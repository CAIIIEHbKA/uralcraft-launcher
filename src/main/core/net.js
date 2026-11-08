'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { USER_AGENT } = require('./paths');
const { abortError, throwIfAborted, hashFile } = require('./utils');

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const inFlight = new Map();

function requestUrl(url, { timeout = 60000, signal, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    const request = transport.get(parsed, {
      agent: parsed.protocol === 'https:' ? agent : undefined,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        ...headers,
      },
    }, resolve);
    request.setTimeout(timeout, () => {
      request.destroy(new Error(`Таймаут соединения (${Math.round(timeout / 1000)} сек)`));
    });
    request.on('error', reject);
    if (signal) {
      if (signal.aborted) {
        request.destroy(abortError());
        return;
      }
      signal.addEventListener('abort', () => request.destroy(abortError()), { once: true });
    }
  });
}

async function fetchJson(url, { timeout = 30000, signal, headers = {} } = {}) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Таймаут запроса')), timeout);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw abortError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...headers,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} при запросе ${url}`);
    }
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error?.name === 'AbortError') throw new Error('Таймаут запроса');
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

async function performDownload(url, options, redirectsLeft) {
  if (redirectsLeft < 0) {
    throw new Error('Слишком много перенаправлений');
  }
  throwIfAborted(options.signal);
  const response = await requestUrl(url, {
    timeout: options.timeout,
    signal: options.signal,
    headers: options.headers,
  });

  if (isRedirect(response.statusCode) && response.headers.location) {
    response.resume();
    const next = new URL(response.headers.location, url).href;
    return performDownload(next, options, redirectsLeft - 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    const error = new Error(`HTTP ${response.statusCode} при скачивании ${url}`);
    error.statusCode = response.statusCode;
    throw error;
  }

  const total = Number(options.expectedSize || response.headers['content-length'] || 0);
  const temp = `${options.dest}.part`;
  await fs.promises.mkdir(path.dirname(options.dest), { recursive: true });
  await fs.promises.rm(temp, { force: true });

  const hash = crypto.createHash('sha1');
  let downloaded = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      downloaded += chunk.length;
      const now = Date.now();
      if (options.onProgress && (now - lastReport > 90 || downloaded === total)) {
        lastReport = now;
        try {
          options.onProgress({ downloaded, total: total || downloaded });
        } catch {
          // progress callbacks must never break a download
        }
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(response, meter, fs.createWriteStream(temp));
    if (options.expectedSize && downloaded !== Number(options.expectedSize)) {
      throw new Error(`Размер файла не совпал: ${downloaded} вместо ${options.expectedSize}`);
    }
    const actualSha1 = hash.digest('hex');
    if (options.expectedSha1 && actualSha1.toLowerCase() !== String(options.expectedSha1).toLowerCase()) {
      throw new Error('Контрольная сумма файла не совпала');
    }
    await fs.promises.rm(options.dest, { force: true });
    await fs.promises.rename(temp, options.dest);
    if (options.onProgress) {
      try {
        options.onProgress({ downloaded, total: total || downloaded });
      } catch {
        // ignore
      }
    }
    return { path: options.dest, size: downloaded, skipped: false, sha1: actualSha1 };
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    if (options.signal?.aborted) throw abortError();
    throw error;
  }
}

async function downloadFile(options) {
  const {
    url,
    dest,
    expectedSha1 = null,
    expectedSize = null,
    signal = null,
    retries = 3,
    timeout = 120000,
    verifySha1 = false,
    checkExisting = true,
    onProgress = null,
    headers = {},
  } = options || {};

  if (!url || !dest) throw new Error('downloadFile: не указаны url или dest');
  throwIfAborted(signal);

  const key = path.resolve(dest);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    if (checkExisting) {
      try {
        const stat = await fs.promises.stat(dest);
        const sizeOk = !expectedSize || stat.size === Number(expectedSize);
        let hashOk = true;
        if (sizeOk && verifySha1 && expectedSha1) {
          hashOk = (await hashFile(dest)).toLowerCase() === String(expectedSha1).toLowerCase();
        }
        if (sizeOk && hashOk && stat.size > 0) {
          if (onProgress) {
            try {
              onProgress({ downloaded: stat.size, total: stat.size, cached: true });
            } catch {
              // ignore
            }
          }
          return { path: dest, size: stat.size, skipped: true };
        }
      } catch {
        // file does not exist or cannot be read
      }
    }

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await performDownload(url, {
          dest,
          expectedSize,
          expectedSha1,
          signal,
          timeout,
          onProgress,
          headers,
        }, 8);
      } catch (error) {
        lastError = error;
        if (error?.statusCode === 404 || error?.statusCode === 403) break;
        if (signal?.aborted) throw abortError();
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(2500, attempt * 700)));
        }
      }
    }
    throw lastError || new Error('Не удалось скачать файл');
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

module.exports = {
  fetchJson,
  downloadFile,
};
