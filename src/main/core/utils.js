'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanBytes(value) {
  const num = Number(value) || 0;
  if (num < 1024) return `${num} Б`;
  if (num < 1024 ** 2) return `${(num / 1024).toFixed(0)} КБ`;
  if (num < 1024 ** 3) return `${(num / 1024 ** 2).toFixed(1)} МБ`;
  return `${(num / 1024 ** 3).toFixed(2)} ГБ`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 сек';
  if (seconds < 60) return `${Math.ceil(seconds)} сек`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min} мин ${sec} сек`;
}

function sanitizeNickname(value) {
  return String(value || '')
    .trim()
    .replace(/[^\wа-яА-ЯёЁ\-.]/g, '')
    .slice(0, 32);
}

function isValidNickname(value) {
  const nick = sanitizeNickname(value);
  return nick.length >= 2 && nick.length <= 32;
}

function normalizeServer(value) {
  let server = String(value || '').trim();
  if (!server) return '';
  server = server.replace(/^minecraft:\/\//i, '').replace(/\/+$/, '');
  if (!server.includes(':')) server += ':25565';
  return server;
}

function parseServer(value) {
  const normalized = normalizeServer(value);
  if (!normalized) return null;
  const split = normalized.lastIndexOf(':');
  if (split <= 0) return null;
  const host = normalized.slice(0, split);
  const port = Number(normalized.slice(split + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, address: `${host}:${port}` };
}

function offlineUuid(name) {
  const digest = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  const bytes = Buffer.from(digest);
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function subst(value, context) {
  return String(value || '').replace(/\$\{([^}]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      return String(context[key] ?? '');
    }
    return match;
  });
}

function archMatches(wanted) {
  if (!wanted) return true;
  if (wanted === 'x86') return process.arch === 'ia32';
  if (wanted === 'x86_64' || wanted === 'x64') return process.arch === 'x64';
  if (wanted === 'arm64' || wanted === 'aarch64') return process.arch === 'arm64';
  return wanted === process.arch;
}

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function rulesAllow(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (rule.features && typeof rule.features === 'object') {
      let matches = true;
      for (const [key, value] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== Boolean(value)) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
    }
    if (rule.os && typeof rule.os === 'object') {
      const name = rule.os.name;
      if (name && name !== osName()) continue;
      if (rule.os.arch && !archMatches(rule.os.arch)) continue;
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(os.release())) continue;
        } catch {
          continue;
        }
      }
    }
    allowed = rule.action === 'allow';
  }
  return allowed;
}

function totalRamGb() {
  const bytes = os.totalmem();
  return Math.max(2, Math.round(bytes / 1024 ** 3));
}

function recommendedRamGb() {
  const total = totalRamGb();
  if (total <= 8) return 3;
  if (total <= 16) return 5;
  if (total <= 24) return 7;
  return 8;
}

function clampRam(value) {
  const max = Math.max(2, Math.min(32, totalRamGb() - 1));
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return recommendedRamGb();
  return Math.max(2, Math.min(max, parsed));
}

function readJson(file, fallback = null) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function hashFile(file, algorithm = 'sha1') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

async function pathExists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

function walkFiles(root, options = {}) {
  const maxDepth = options.maxDepth ?? 6;
  const results = [];
  const ignored = new Set(options.ignore || []);
  function visit(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  if (fs.existsSync(root)) visit(root, 0);
  return results;
}

function abortError() {
  const error = new Error('Загрузка отменена');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function runPool(items, worker, concurrency = 8, signal) {
  const list = Array.from(items);
  if (!list.length) return;
  let cursor = 0;
  let stopped = false;
  let firstError = null;
  const runners = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (!stopped) {
      throwIfAborted(signal);
      const index = cursor++;
      if (index >= list.length) return;
      try {
        await worker(list[index], index);
      } catch (error) {
        stopped = true;
        if (!firstError) firstError = error;
        return;
      }
    }
  });
  await Promise.all(runners);
  if (firstError) throw firstError;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTimestamp(date = new Date()) {
  return date.toLocaleTimeString('ru-RU', { hour12: false });
}

module.exports = {
  sleep,
  humanBytes,
  formatDuration,
  sanitizeNickname,
  isValidNickname,
  normalizeServer,
  parseServer,
  offlineUuid,
  subst,
  rulesAllow,
  osName,
  totalRamGb,
  recommendedRamGb,
  clampRam,
  readJson,
  writeJsonAtomic,
  hashFile,
  fileSize,
  pathExists,
  walkFiles,
  abortError,
  throwIfAborted,
  runPool,
  escapeRegExp,
  formatTimestamp,
};
