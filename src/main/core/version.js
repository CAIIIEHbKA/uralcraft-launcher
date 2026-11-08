'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const {
  MC_VERSION,
  MANIFEST_URL,
  VERSIONS_DIR,
  LIBRARIES_DIR,
  ASSETS_DIR,
  NATIVES_DIR,
  NATIVE_SUBDIRS,
  ASSET_CACHE_PATH,
} = require('./paths');
const {
  downloadFile,
  fetchJson,
} = require('./net');
const {
  rulesAllow,
  readJson,
  writeJsonAtomic,
  fileSize,
  hashFile,
  runPool,
  throwIfAborted,
  humanBytes,
} = require('./utils');

function cachedVersionPath(id) {
  return path.join(VERSIONS_DIR, id, `${id}.json`);
}

async function fetchVersion(versionId = MC_VERSION, { signal, log } = {}) {
  let entry = null;
  let manifest = null;
  try {
    manifest = await fetchJson(MANIFEST_URL, { signal, timeout: 30000 });
    const versions = Array.isArray(manifest?.versions) ? manifest.versions : [];
    entry = versions.find((item) => item.id === versionId);
    if (!entry && manifest?.latest?.release) {
      entry = versions.find((item) => item.id === manifest.latest.release);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (log) log(`Не удалось получить список версий: ${error.message}`, 'warn');
  }

  if (entry) {
    const version = await fetchJson(entry.url, { signal, timeout: 30000 });
    const dir = path.join(VERSIONS_DIR, version.id);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, `${version.id}.json`), version);
    return version;
  }

  const cached = readJson(cachedVersionPath(versionId), null);
  if (cached && cached.id) {
    if (log) log(`Использую сохранённый профиль Minecraft ${cached.id}`, 'warn');
    return cached;
  }
  throw new Error(`Не удалось получить Minecraft ${versionId}. Проверь интернет.`);
}

function nativeMatchesPlatform(artifactPath) {
  const value = String(artifactPath || '').toLowerCase();
  if (!value.includes('natives')) return false;
  const isArm64 = process.arch === 'arm64';
  if (process.platform === 'win32') {
    if (value.includes('natives-windows-arm64')) return isArm64;
    if (value.includes('natives-windows')) return !isArm64;
    return false;
  }
  if (process.platform === 'darwin') {
    if (value.includes('natives-macos-arm64')) return isArm64;
    if (value.includes('natives-macos')) return !isArm64;
    return false;
  }
  if (process.platform === 'linux') {
    if (value.includes('natives-linux-arm64')) return isArm64;
    if (value.includes('natives-linux')) return !isArm64;
    return false;
  }
  return false;
}

function classifierNativeForPlatform(lib) {
  if (!lib?.natives || typeof lib.natives !== 'object') return null;
  const key = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  let classifier = lib.natives[key];
  if (!classifier || typeof classifier !== 'string') return null;
  classifier = classifier.replace('${arch}', process.arch === 'x64' ? '64' : process.arch === 'arm64' ? 'arm64' : '32');
  return classifier;
}

function extractNatives(jarPath, targetDir, log) {
  try {
    const zip = new AdmZip(jarPath);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, '/');
      if (!name || name.startsWith('META-INF/')) continue;
      if (!/\.(dll|so|dylib|jnilib)$/i.test(name)) continue;
      const target = path.join(targetDir, path.basename(name));
      fs.writeFileSync(target, entry.getData());
    }
  } catch (error) {
    if (log) log(`Не удалось распаковать нативы ${path.basename(jarPath)}: ${error.message}`, 'warn');
  }
}

async function prepareNatives(nativeJars, versionId, { log } = {}) {
  const marker = path.join(NATIVES_DIR, '.version');
  const expected = `${versionId}:${process.arch}`;
  let ready = false;
  try {
    const subdirsReady = NATIVE_SUBDIRS.every((name) => fs.existsSync(path.join(NATIVES_DIR, name)));
    ready = subdirsReady
      && fs.readFileSync(marker, 'utf8').trim() === expected
      && fs.readdirSync(NATIVES_DIR).some((name) => /\.(dll|so|dylib|jnilib)$/i.test(name));
  } catch {
    ready = false;
  }
  if (!ready) {
    await fs.promises.rm(NATIVES_DIR, { recursive: true, force: true });
    fs.mkdirSync(NATIVES_DIR, { recursive: true });
    for (const dir of NATIVE_SUBDIRS) fs.mkdirSync(path.join(NATIVES_DIR, dir), { recursive: true });
    for (const jar of nativeJars) extractNatives(jar, NATIVES_DIR, log);
    const natives = fs.readdirSync(NATIVES_DIR).filter((name) => /\.(dll|so|dylib|jnilib)$/i.test(name));
    if (!natives.length) {
      throw new Error('Не удалось подготовить нативные библиотеки Minecraft');
    }
    for (const sub of NATIVE_SUBDIRS) {
      const target = path.join(NATIVES_DIR, sub);
      for (const name of natives) {
        fs.copyFileSync(path.join(NATIVES_DIR, name), path.join(target, name));
      }
    }
    fs.writeFileSync(marker, expected, 'utf8');
  }
}

async function ensureClient(version, { signal, onProgress, log, verify = false } = {}) {
  const dl = version?.downloads?.client;
  if (!dl?.url) throw new Error('В профиле версии нет ссылки на клиент Minecraft');
  const dest = path.join(VERSIONS_DIR, version.id, `${version.id}.jar`);
  if (log) log(`Клиент Minecraft ${version.id}: ${humanBytes(dl.size)}`, 'info');
  return downloadFile({
    url: dl.url,
    dest,
    expectedSha1: dl.sha1,
    expectedSize: dl.size,
    verifySha1: verify,
    signal,
    timeout: 180000,
    onProgress,
  });
}

async function ensureLibraries(version, { signal, onProgress, log, verify = false, nativeKey = null } = {}) {
  const allowed = [];
  for (const lib of version?.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const artifact = lib?.downloads?.artifact;
    if (!artifact?.url) continue;
    const artifactPath = artifact.path || '';
    if (process.platform === 'win32') {
      if (artifactPath.includes('-natives-windows-arm64') && process.arch !== 'arm64') continue;
      if (artifactPath.includes('-natives-windows') && !artifactPath.includes('-natives-windows-arm64') && process.arch === 'arm64') continue;
    }
    allowed.push({ lib, artifact });
  }

  const totalBytes = allowed.reduce((sum, item) => sum + (Number(item.artifact.size) || 0), 0);
  let bytesDone = 0;
  let done = 0;
  const classpath = [];
  const nativeJars = [];

  for (const item of allowed) {
    const { lib, artifact } = item;
    if (!artifact.path) continue;
    const dest = path.join(LIBRARIES_DIR, artifact.path);
    await downloadFile({
      url: artifact.url,
      dest,
      expectedSha1: artifact.sha1,
      expectedSize: artifact.size,
      signal,
      verifySha1: verify,
      timeout: 120000,
    });
    classpath.push(dest);
    if (nativeMatchesPlatform(artifact.path) || nativeMatchesPlatform(lib.name)) {
      if (!nativeJars.includes(dest)) nativeJars.push(dest);
    }

    const classifier = classifierNativeForPlatform(lib);
    if (classifier) {
      const info = lib?.downloads?.classifiers?.[classifier];
      if (info?.url && info?.path) {
        const classifierDest = path.join(LIBRARIES_DIR, info.path);
        await downloadFile({
          url: info.url,
          dest: classifierDest,
          expectedSha1: info.sha1,
          expectedSize: info.size,
          signal,
          verifySha1: verify,
          timeout: 120000,
        });
        if (!nativeJars.includes(classifierDest)) nativeJars.push(classifierDest);
      }
    }

    done += 1;
    bytesDone += Number(artifact.size) || 0;
    if (onProgress) {
      onProgress({
        done,
        total: allowed.length,
        bytesDone,
        bytesTotal: totalBytes,
        label: lib.name || path.basename(artifact.path),
      });
    }
    throwIfAborted(signal);
  }

  await prepareNatives(nativeJars, nativeKey || version.id, { log });
  if (log) log(`Библиотеки готовы: ${classpath.length} файлов`, 'ok');
  return classpath;
}

async function ensureAssets(version, { signal, onProgress, log, verify = false } = {}) {
  const indexInfo = version?.assetIndex;
  if (!indexInfo?.url) throw new Error('В профиле версии нет индекса ресурсов');
  const indexDir = path.join(ASSETS_DIR, 'indexes');
  const indexPath = path.join(indexDir, `${indexInfo.id}.json`);
  fs.mkdirSync(indexDir, { recursive: true });
  await downloadFile({
    url: indexInfo.url,
    dest: indexPath,
    expectedSha1: indexInfo.sha1,
    expectedSize: indexInfo.size,
    signal,
    timeout: 120000,
    verifySha1: true,
  });
  const index = readJson(indexPath, null);
  if (!index?.objects) throw new Error('Не удалось прочитать индекс ресурсов');

  const unique = new Map();
  for (const object of Object.values(index.objects)) {
    if (!object?.hash) continue;
    unique.set(object.hash, object);
  }
  const objects = Array.from(unique.values());
  const cache = readJson(ASSET_CACHE_PATH, {});
  const validCache = cache && typeof cache === 'object' ? cache : {};
  const bytesTotal = objects.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  let done = 0;
  let bytesDone = 0;
  let lastReport = 0;

  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < 120) return;
    lastReport = now;
    onProgress({
      done,
      total: objects.length,
      bytesDone,
      bytesTotal,
      percent: objects.length ? done / objects.length : 1,
    });
  };

  report(true);
  await runPool(objects, async (object) => {
    throwIfAborted(signal);
    const hash = object.hash;
    const dest = path.join(ASSETS_DIR, 'objects', hash.slice(0, 2), hash);
    const expectedSize = Number(object.size) || 0;
    let skip = false;
    const currentSize = fileSize(dest);
    if (currentSize === expectedSize && currentSize >= 0) {
      if (verify) {
        const actual = await hashFile(dest);
        skip = actual === hash;
        if (!skip) await fs.promises.rm(dest, { force: true });
      } else {
        // A file with the right size is a good enough cache hit; a full
        // hash of ~500 MB on every launch would be wasteful.
        skip = true;
      }
    }
    if (!skip) {
      await downloadFile({
        url: `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
        dest,
        expectedSha1: hash,
        expectedSize: object.size,
        signal,
        timeout: 120000,
      });
    }
    try {
      const stat = await fs.promises.stat(dest);
      // The old Python launcher stores seconds; keeping the same unit makes
      // the shared %APPDATA%\.uralcraft cache fully compatible.
      validCache[hash] = { size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
    } catch {
      // ignore
    }
    done += 1;
    bytesDone += expectedSize;
    report(done === objects.length);
  }, 24, signal);

  writeJsonAtomic(ASSET_CACHE_PATH, validCache);
  report(true);
  if (log) log(`Ресурсы готовы: ${objects.length} объектов`, 'ok');
  return { count: objects.length, bytes: bytesTotal };
}

async function ensureLogConfig(version, { signal, log } = {}) {
  const info = version?.logging?.client?.file;
  if (!info?.url) return null;
  const dir = path.join(ASSETS_DIR, 'log_configs');
  const dest = path.join(dir, info.id || 'client-log4j.xml');
  fs.mkdirSync(dir, { recursive: true });
  await downloadFile({
    url: info.url,
    dest,
    expectedSha1: info.sha1,
    expectedSize: info.size,
    signal,
    timeout: 60000,
  });
  return dest;
}

function getJavaMajor(version) {
  const value = Number(version?.javaVersion?.majorVersion);
  return Number.isFinite(value) && value > 0 ? value : 25;
}

module.exports = {
  fetchVersion,
  ensureClient,
  ensureLibraries,
  ensureAssets,
  ensureLogConfig,
  getJavaMajor,
  prepareNatives,
  cachedVersionPath,
};
