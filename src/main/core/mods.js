'use strict';

const fs = require('fs');
const path = require('path');
const {
  MODRINTH_API,
  MODS_DIR,
  SHADERPACKS_DIR,
  RESOURCEPACKS_DIR,
  CONFIG_DIR,
  GAME_DIR,
} = require('./paths');
const { fetchJson, downloadFile } = require('./net');
const { humanBytes, abortError } = require('./utils');

const SHADER_MODS = [
  { id: 'P7dR8mSH', label: 'Fabric API', pattern: /^fabric-api-.*\.jar$/i },
  { id: 'AANobbMI', label: 'Sodium', pattern: /^sodium-fabric-.*\.jar$/i },
  { id: 'YL57xq9U', label: 'Iris', pattern: /^iris-fabric-.*\.jar$/i },
  { id: '9s6osm5g', label: 'Cloth Config', pattern: /^cloth-config-.*\.jar$/i },
  { id: 'Va8PJBFX', label: 'RenderScale', pattern: /^renderscale-.*\.jar$/i },
  { id: '4I1XuqiY', label: 'Entity Model Features', pattern: /^entity_model_features-.*\.jar$/i },
  { id: 'BVzZfTc1', label: 'Entity Texture Features', pattern: /^entity_texture_features-.*\.jar$/i },
];

const SHADER_PACK = {
  id: 'HVnmMxH1',
  label: 'Complementary Reimagined',
  pattern: /^ComplementaryReimagined.*\.zip$/i,
};

const ANIMATIONS_PACK = {
  id: '50dA9Sha',
  label: 'Fresh Animations',
  pattern: /^FreshAnimations.*\.zip$/i,
};

// Simple Voice Chat is a Fabric mod, not a server plugin. The server may still
// need the matching server-side plugin/mod, but the client jar is required for
// the in-game voice UI and microphone connection.
const VOICE_CHAT_MOD = {
  id: '9eGQg6ZK',
  label: 'Simple Voice Chat',
  pattern: /^voicechat-fabric-.*\.jar$/i,
};

function sortVersions(versions) {
  return [...versions].sort((a, b) => String(b.date_published || '').localeCompare(String(a.date_published || '')));
}

async function findModrinthFile(projectId, { gameVersion, loader, allowAnyVersion = false, signal } = {}) {
  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  if (loader) params.set('loaders', JSON.stringify([loader]));
  const url = `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version${params.size ? `?${params}` : ''}`;
  let versions = await fetchJson(url, { signal, timeout: 30000 });
  if ((!Array.isArray(versions) || !versions.length) && allowAnyVersion) {
    const fallbackParams = new URLSearchParams();
    if (loader) fallbackParams.set('loaders', JSON.stringify([loader]));
    const fallbackUrl = `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version${fallbackParams.size ? `?${fallbackParams}` : ''}`;
    versions = await fetchJson(fallbackUrl, { signal, timeout: 30000 });
  }
  if (!Array.isArray(versions) || !versions.length) {
    throw new Error(`Modrinth: нет версии для ${projectId}${gameVersion ? ` / ${gameVersion}` : ''}`);
  }
  const releases = versions.filter((item) => item.version_type === 'release');
  const candidates = sortVersions(releases.length ? releases : versions);
  const version = candidates[0];
  const files = Array.isArray(version.files) ? version.files : [];
  const file = files.find((item) => item.primary) || files[0];
  if (!file?.url) throw new Error(`Modrinth: у ${projectId} нет файла`);
  return {
    filename: path.basename(file.filename || `${projectId}.jar`),
    url: file.url,
    sha1: file.hashes?.sha1 || null,
    size: file.size || null,
    version: version.version_number || '',
  };
}

function findExisting(dir, pattern) {
  try {
    const found = fs.readdirSync(dir).filter((name) => pattern.test(name));
    return found.sort().at(-1) || null;
  } catch {
    return null;
  }
}

function removeOtherVersions(dir, pattern, keepName) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (pattern.test(name) && name !== keepName) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

async function ensureMod(projectId, { gameVersion, loader = 'fabric', signal, log, onProgress, label, pattern }) {
  fs.mkdirSync(MODS_DIR, { recursive: true });
  try {
    const info = await findModrinthFile(projectId, { gameVersion, loader, signal });
    const dest = path.join(MODS_DIR, info.filename);
    await downloadFile({
      url: info.url,
      dest,
      expectedSha1: info.sha1,
      expectedSize: info.size,
      signal,
      timeout: 180000,
    });
    removeOtherVersions(MODS_DIR, pattern, info.filename);
    if (log) log(`${label}: ${info.version || info.filename}`, 'ok');
    if (onProgress) onProgress(label, info.filename);
    return { path: dest, skipped: false, filename: info.filename, version: info.version };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    const existing = findExisting(MODS_DIR, pattern);
    if (!existing) throw new Error(`${label}: ${error.message}`);
    if (log) log(`${label}: использую уже скачанный ${existing}`, 'warn');
    if (onProgress) onProgress(label, existing);
    return { path: path.join(MODS_DIR, existing), skipped: true, filename: existing, version: 'локальная версия' };
  }
}

async function ensureShaderMods(gameVersion, { signal, log, onProgress } = {}) {
  const results = [];
  for (let i = 0; i < SHADER_MODS.length; i += 1) {
    const mod = SHADER_MODS[i];
    if (onProgress) onProgress({ stage: 'mods', index: i + 1, total: SHADER_MODS.length, detail: `Мод ${mod.label}...` });
    const result = await ensureMod(mod.id, {
      gameVersion,
      loader: 'fabric',
      signal,
      log,
      label: mod.label,
      pattern: mod.pattern,
      onProgress: () => {
        // The version line is already logged by ensureMod; avoid duplicates.
      },
    });
    results.push(result);
  }
  return results;
}

async function ensureVoiceChat(gameVersion, { enabled = true, signal, log, onProgress } = {}) {
  if (!enabled) {
    removeOtherVersions(MODS_DIR, VOICE_CHAT_MOD.pattern, '');
    if (log) log('Simple Voice Chat выключен', 'info');
    return null;
  }
  if (onProgress) onProgress({ stage: 'voicechat', detail: 'Мод Simple Voice Chat...' });
  const result = await ensureMod(VOICE_CHAT_MOD.id, {
    gameVersion,
    loader: 'fabric',
    signal,
    log,
    label: VOICE_CHAT_MOD.label,
    pattern: VOICE_CHAT_MOD.pattern,
    onProgress: () => {},
  });
  return result;
}

async function ensureShaderPack(gameVersion, { signal, log, onProgress } = {}) {
  fs.mkdirSync(SHADERPACKS_DIR, { recursive: true });
  if (onProgress) onProgress({ stage: 'shaderpack', detail: `Шейдерпак ${SHADER_PACK.label}...` });
  try {
    const info = await findModrinthFile(SHADER_PACK.id, {
      gameVersion,
      allowAnyVersion: true,
      signal,
    });
    const dest = path.join(SHADERPACKS_DIR, info.filename);
    await downloadFile({
      url: info.url,
      dest,
      expectedSha1: info.sha1,
      expectedSize: info.size,
      signal,
      timeout: 180000,
    });
    removeOtherVersions(SHADERPACKS_DIR, SHADER_PACK.pattern, info.filename);
    if (log) log(`Шейдерпак: ${info.filename}`, 'ok');
    return info.filename;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    const existing = findExisting(SHADERPACKS_DIR, SHADER_PACK.pattern);
    if (!existing) throw new Error(`Шейдерпак: ${error.message}`);
    if (log) log(`Шейдерпак: использую ${existing}`, 'warn');
    return existing;
  }
}

function setProperties(file, values) {
  let lines = [];
  try {
    if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  } catch {
    lines = [];
  }
  const seen = new Set();
  const output = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const key = line.split('=', 1)[0].trim();
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        output.push(`${key}=${values[key]}`);
        seen.add(key);
        continue;
      }
    }
    output.push(line);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${output.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

function setIrisShaderPack(filename) {
  setProperties(path.join(CONFIG_DIR, 'iris.properties'), {
    shaderPack: filename,
    enableShaders: 'true',
    disableUpdateMessage: 'true',
  });
}

function readOptions() {
  const file = path.join(GAME_DIR, 'options.txt');
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n') : [];
  } catch {
    return [];
  }
}

function writeOptions(lines) {
  const file = path.join(GAME_DIR, 'options.txt');
  fs.writeFileSync(file, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

function setResourcePack(filename, enabled) {
  const lines = readOptions();
  let found = false;
  const entry = `file/${filename}`;
  const output = lines.map((line) => {
    if (!line.startsWith('resourcePacks:')) return line;
    found = true;
    let packs = [];
    try {
      packs = JSON.parse(line.slice('resourcePacks:'.length));
    } catch {
      packs = [];
    }
    if (!Array.isArray(packs)) packs = [];
    if (!packs.includes('vanilla')) packs.unshift('vanilla');
    if (enabled && !packs.includes(entry)) packs.push(entry);
    if (!enabled) packs = packs.filter((item) => !String(item).startsWith('file/FreshAnimations'));
    return `resourcePacks:${JSON.stringify(packs)}`;
  });
  if (!found && enabled) {
    output.push(`resourcePacks:${JSON.stringify(['vanilla', entry])}`);
  }
  writeOptions(output);
}

async function ensureAnimations(gameVersion, { enabled, signal, log, onProgress } = {}) {
  fs.mkdirSync(RESOURCEPACKS_DIR, { recursive: true });
  if (!enabled) {
    const existing = findExisting(RESOURCEPACKS_DIR, ANIMATIONS_PACK.pattern);
    if (existing) setResourcePack(existing, false);
    if (log) log('Анимации мобов выключены', 'info');
    return null;
  }
  if (onProgress) onProgress({ stage: 'animations', detail: 'Ресурспак Fresh Animations...' });
  let filename = findExisting(RESOURCEPACKS_DIR, ANIMATIONS_PACK.pattern);
  try {
    const info = await findModrinthFile(ANIMATIONS_PACK.id, {
      gameVersion,
      allowAnyVersion: true,
      signal,
    });
    const dest = path.join(RESOURCEPACKS_DIR, info.filename);
    await downloadFile({
      url: info.url,
      dest,
      expectedSha1: info.sha1,
      expectedSize: info.size,
      signal,
      timeout: 180000,
    });
    removeOtherVersions(RESOURCEPACKS_DIR, ANIMATIONS_PACK.pattern, info.filename);
    filename = info.filename;
    if (log) log(`Fresh Animations: ${info.filename} (${humanBytes(info.size)})`, 'ok');
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (!filename) {
      if (log) log(`Fresh Animations не скачан: ${error.message}`, 'warn');
      return null;
    }
    if (log) log(`Fresh Animations: использую ${filename}`, 'warn');
  }
  if (filename) {
    setResourcePack(filename, true);
    if (log) log(`Анимации мобов включены: ${filename}`, 'ok');
  }
  return filename;
}

function setRenderScale(enabled, percent = 75) {
  const file = path.join(CONFIG_DIR, 'renderscale.json5');
  let values = {
    scale: 1.0,
    targetFrameRate: 0,
    aggressionLevel: 'NORMAL',
    minimumScale: 0.1,
    fsr: false,
    irisScale: -1.0,
    forceBilinear: false,
    downscaleFilter: 'AUTO',
    sharpeningMode: 'OFF',
    sharpeningStrength: 35,
  };
  try {
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (loaded && typeof loaded === 'object') values = { ...values, ...loaded };
    }
  } catch {
    // keep defaults
  }
  if (enabled) {
    const factor = Math.max(0.5, Math.min(1, Number(percent) / 100 || 0.75));
    values = {
      ...values,
      scale: factor,
      irisScale: factor,
      fsr: true,
      sharpeningMode: 'RCAS',
      sharpeningStrength: 35,
      downscaleFilter: 'AUTO',
      targetFrameRate: 0,
    };
  } else {
    values = {
      ...values,
      scale: 1.0,
      irisScale: 1.0,
      fsr: false,
      sharpeningMode: 'OFF',
      targetFrameRate: 0,
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(values, null, '\t')}\n`, 'utf8');
}

function shaderFilesStatus() {
  const mods = fs.existsSync(MODS_DIR) ? fs.readdirSync(MODS_DIR) : [];
  const packs = fs.existsSync(SHADERPACKS_DIR) ? fs.readdirSync(SHADERPACKS_DIR) : [];
  return {
    mods: mods.filter((name) => name.endsWith('.jar')),
    shaderPacks: packs.filter((name) => name.endsWith('.zip')),
  };
}

module.exports = {
  SHADER_MODS,
  SHADER_PACK,
  ANIMATIONS_PACK,
  VOICE_CHAT_MOD,
  ensureShaderMods,
  ensureVoiceChat,
  ensureShaderPack,
  ensureAnimations,
  setIrisShaderPack,
  setRenderScale,
  setResourcePack,
  shaderFilesStatus,
  findModrinthFile,
};
