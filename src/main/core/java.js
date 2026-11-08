'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const AdmZip = require('adm-zip');
const {
  BASE_DIR,
  ADOPTIUM_API,
} = require('./paths');
const { fetchJson, downloadFile } = require('./net');
const { humanBytes, walkFiles, abortError } = require('./utils');

const execFileAsync = promisify(execFile);
const JAVA_FALLBACK = {
  25: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jre_x64_windows_hotspot_25.0.5_8.zip',
};

function javaExecutableNames() {
  return process.platform === 'win32' ? ['javaw.exe', 'java.exe'] : ['java'];
}

function addCandidate(list, value) {
  if (!value) return;
  const resolved = path.resolve(value);
  if (!list.includes(resolved)) list.push(resolved);
}

function addJavaRoot(list, root) {
  if (!root) return;
  for (const name of javaExecutableNames()) {
    addCandidate(list, path.join(root, 'bin', name));
  }
}

function searchRoots(list, roots, maxDepth = 4) {
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      const files = walkFiles(root, { maxDepth });
      for (const file of files) {
        if (/[\\/]bin[\\/](javaw\.exe|java\.exe|java)$/i.test(file)) addCandidate(list, file);
      }
    } catch {
      // ignore inaccessible directories
    }
  }
}

async function checkJavaVersion(exe, requiredMajor) {
  try {
    let output = '';
    try {
      const result = await execFileAsync(exe, ['-version'], {
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      output = `${result.stdout || ''}${result.stderr || ''}`;
    } catch (error) {
      if (error?.killed) return { ok: false, version: 0, output: '' };
      output = `${error?.stdout || ''}${error?.stderr || ''}`;
    }
    let match = output.match(/version\s+"([^"]+)"/i);
    if (!match) match = output.match(/java\.version\s*=\s*(\S+)/i);
    if (!match) return { ok: false, version: 0, output };
    const raw = match[1].trim();
    let major;
    if (raw.startsWith('1.')) major = Number.parseInt(raw.split('.')[1], 10);
    else major = Number.parseInt(raw.split(/[.+-]/)[0], 10);
    if (!Number.isFinite(major)) return { ok: false, version: 0, output };
    return { ok: major >= requiredMajor, version: major, raw, output };
  } catch {
    return { ok: false, version: 0, output: '' };
  }
}

async function findJava(requiredMajor = 25, { log } = {}) {
  const candidates = [];
  addCandidate(candidates, process.env.URALCRAFT_JAVA);
  addJavaRoot(candidates, path.join(BASE_DIR, `jre-${requiredMajor}`));
  addJavaRoot(candidates, path.join(path.dirname(process.execPath), `jre-${requiredMajor}`));
  if (process.env.JAVA_HOME) addJavaRoot(candidates, process.env.JAVA_HOME);
  if (process.env.JAVA_HOME) addCandidate(candidates, process.env.JAVA_HOME);

  // Check the bundled / explicitly configured runtimes before scanning
  // Program Files. This makes the normal launch effectively instant.
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const info = await checkJavaVersion(candidate, requiredMajor);
    if (info.ok) {
      if (log) log(`Найдена Java ${info.raw}: ${candidate}`, 'info');
      return candidate;
    }
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  searchRoots(candidates, [
    path.join(appData, '.tlauncher', 'jvms'),
    path.join(appData, '.tlauncher', 'jre'),
    path.join(appData, '.tlauncher', 'java'),
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\Microsoft',
  ]);

  try {
    const result = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', process.platform === 'win32' ? ['java.exe'] : ['java'], {
      timeout: 5000,
      windowsHide: true,
    });
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      if (line.trim()) addCandidate(candidates, line.trim());
    }
  } catch {
    // java is not on PATH
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const info = await checkJavaVersion(candidate, requiredMajor);
    if (info.ok) {
      if (log) log(`Найдена Java ${info.raw}: ${candidate}`, 'info');
      return candidate;
    }
  }
  return null;
}

function findJavaExecutable(root) {
  const names = javaExecutableNames();
  for (const name of names) {
    const direct = path.join(root, 'bin', name);
    if (fs.existsSync(direct)) return direct;
  }
  const files = walkFiles(root, { maxDepth: 5 });
  for (const name of names) {
    const found = files.find((file) => path.basename(file).toLowerCase() === name.toLowerCase() && /[\\/]bin[\\/]/i.test(file));
    if (found) return found;
  }
  return null;
}

async function downloadJava(requiredMajor, { signal, onProgress, log } = {}) {
  if (process.platform !== 'win32') {
    throw new Error(`Java ${requiredMajor} не найдена. Установи JDK ${requiredMajor} и перезапусти лаунчер.`);
  }
  if (log) log(`Java ${requiredMajor} не найдена — скачиваю Temurin JRE`, 'info');
  let packageInfo = null;
  try {
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const url = `${ADOPTIUM_API}/${requiredMajor}/hotspot?architecture=${architecture}&image_type=jre&os=windows&vendor=eclipse`;
    const data = await fetchJson(url, { signal, timeout: 60000 });
    if (Array.isArray(data) && data[0]?.binary?.package?.link) {
      packageInfo = data[0].binary.package;
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (log) log(`Adoptium API недоступен: ${error.message}`, 'warn');
  }
  if (!packageInfo) {
    const fallback = JAVA_FALLBACK[requiredMajor];
    if (!fallback) throw new Error(`Не удалось найти Java ${requiredMajor} для скачивания`);
    packageInfo = { link: fallback, size: null, name: `OpenJDK${requiredMajor}U-jre.zip` };
  }

  const zipPath = path.join(BASE_DIR, `jre-${requiredMajor}.zip`);
  const extractDir = path.join(BASE_DIR, `jre-${requiredMajor}-extract`);
  const targetDir = path.join(BASE_DIR, `jre-${requiredMajor}`);

  await downloadFile({
    url: packageInfo.link,
    dest: zipPath,
    expectedSize: packageInfo.size,
    signal,
    timeout: 600000,
    retries: 2,
    onProgress: (progress) => {
      if (onProgress) {
        const total = progress.total || packageInfo.size || 0;
        onProgress({
          stage: 'download',
          downloaded: progress.downloaded,
          total,
          progress: total ? progress.downloaded / total : 0,
          detail: `Java ${requiredMajor}: ${humanBytes(progress.downloaded)} / ${humanBytes(total)}`,
        });
      }
    },
  });

  if (log) log(`Распаковываю Java ${requiredMajor}`, 'info');
  if (onProgress) onProgress({ stage: 'extract', progress: 0.7, detail: `Распаковываю Java ${requiredMajor}...` });
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);
  const found = findJavaExecutable(extractDir);
  if (!found) throw new Error(`В скачанной Java ${requiredMajor} не найден bin/java.exe`);
  const root = path.dirname(path.dirname(found));
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(root, targetDir);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });

  const result = path.join(targetDir, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
  if (!fs.existsSync(result)) throw new Error(`Не удалось установить Java ${requiredMajor}`);
  if (onProgress) onProgress({ stage: 'done', progress: 1, detail: `Java ${requiredMajor} готова` });
  if (log) log(`Java ${requiredMajor} установлена: ${result}`, 'ok');
  return result;
}

async function ensureJava(requiredMajor = 25, options = {}) {
  const existing = await findJava(requiredMajor, options);
  if (existing) return existing;
  return downloadJava(requiredMajor, options);
}

async function javaInfo(requiredMajor = 25) {
  const pathFound = await findJava(requiredMajor);
  if (!pathFound) return { found: false, path: null, version: null };
  const info = await checkJavaVersion(pathFound, requiredMajor);
  return { found: true, path: pathFound, version: info.raw || String(info.version) };
}

module.exports = {
  ensureJava,
  findJava,
  checkJavaVersion,
  javaInfo,
};
