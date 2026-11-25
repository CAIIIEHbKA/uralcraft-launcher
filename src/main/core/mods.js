'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const semver = require('semver');
const {
  MODRINTH_API,
  MODS_DIR,
  SHADERPACKS_DIR,
  RESOURCEPACKS_DIR,
  CONFIG_DIR,
  GAME_DIR,
  CACHE_DIR,
} = require('./paths');
const { fetchJson, downloadFile } = require('./net');
const { humanBytes, abortError } = require('./utils');

const SODIUM_MOD = { id: 'AANobbMI', label: 'Sodium', pattern: /^sodium-fabric-.*\.jar$/i };
const IRIS_MOD = { id: 'YL57xq9U', label: 'Iris', pattern: /^iris-fabric-.*\.jar$/i };

const SHADER_MODS = [
  { id: 'P7dR8mSH', label: 'Fabric API', pattern: /^fabric-api-.*\.jar$/i },
  SODIUM_MOD,
  IRIS_MOD,
  { id: '9s6osm5g', label: 'Cloth Config', pattern: /^cloth-config-.*\.jar$/i },
  { id: 'Va8PJBFX', label: 'RenderScale', pattern: /^renderscale-.*\.jar$/i },
  { id: '4I1XuqiY', label: 'Entity Model Features', pattern: /^entity_model_features-.*\.jar$/i },
  { id: 'BVzZfTc1', label: 'Entity Texture Features', pattern: /^entity_texture_features-.*\.jar$/i },
];

// Iris is the most constrained mod, so keep it first: the resolver prefers the
// newest Iris and then picks the newest Sodium build that Iris accepts.
const RESOLVE_ORDER = [
  IRIS_MOD,
  SODIUM_MOD,
  ...SHADER_MODS.filter((mod) => mod.id !== SODIUM_MOD.id && mod.id !== IRIS_MOD.id),
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
  id: '9eGKb6K1',
  label: 'Simple Voice Chat',
  pattern: /^voicechat-fabric-.*\.jar$/i,
};

const MOD_META_DIR = path.join(CACHE_DIR, 'mod-meta');
const metadataCache = new Map();

function sortVersions(versions) {
  return [...versions].sort((a, b) => String(b.date_published || '').localeCompare(String(a.date_published || '')));
}

function versionToInfo(version, projectId) {
  const files = Array.isArray(version.files) ? version.files : [];
  const file = files.find((item) => item.primary) || files[0];
  if (!file?.url) throw new Error(`Modrinth: у ${projectId || version.project_id} нет файла`);
  return {
    projectId: version.project_id || projectId || null,
    versionId: version.id || null,
    filename: path.basename(file.filename || `${projectId || 'mod'}.jar`),
    url: file.url,
    sha1: file.hashes?.sha1 || null,
    size: file.size || null,
    version: version.version_number || '',
    datePublished: version.date_published || '',
    dependencies: Array.isArray(version.dependencies) ? version.dependencies : [],
  };
}

async function fetchModrinthVersions(projectId, { gameVersion, loader, allowAnyVersion = false, signal } = {}) {
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
  return Array.isArray(versions) ? versions : [];
}

function selectVersionCandidates(versions) {
  const releases = versions.filter((item) => item.version_type === 'release');
  return sortVersions(releases.length ? releases : versions);
}

async function findModrinthFile(projectId, { gameVersion, loader, allowAnyVersion = false, beforeDate = null, signal } = {}) {
  const versions = await fetchModrinthVersions(projectId, { gameVersion, loader, allowAnyVersion, signal });
  if (!versions.length) {
    throw new Error(`Modrinth: нет версии для ${projectId}${gameVersion ? ` / ${gameVersion}` : ''}`);
  }
  let pool = versions;
  if (beforeDate) {
    pool = pool.filter((item) => String(item.date_published || '') <= String(beforeDate));
    if (!pool.length) {
      throw new Error(`Modrinth: у ${projectId} нет версии, выпущенной до ${beforeDate}`);
    }
  }
  const candidates = selectVersionCandidates(pool);
  return versionToInfo(candidates[0], projectId);
}

async function listModrinthCandidates(projectId, { gameVersion, loader = 'fabric', signal, limit = 10 } = {}) {
  const versions = await fetchModrinthVersions(projectId, { gameVersion, loader, signal });
  if (!versions.length) throw new Error(`Modrinth: нет версии для ${projectId} / ${gameVersion}`);
  return selectVersionCandidates(versions)
    .slice(0, limit)
    .map((version) => versionToInfo(version, projectId));
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

function versionMatches(version, predicate) {
  const predicates = Array.isArray(predicate) ? predicate : [predicate];
  return predicates.some((raw) => {
    if (typeof raw !== 'string') return false;
    const range = raw.trim();
    if (!range) return false;
    if (range === '*' || /^x$/i.test(range)) return true;
    let candidate = String(version || '').trim();
    if (!candidate) return false;
    if (!semver.valid(candidate)) {
      const coerced = semver.coerce(candidate);
      if (!coerced) return false;
      candidate = coerced.version;
    }
    try {
      return semver.satisfies(candidate, range, { includePrerelease: true, loose: true });
    } catch {
      return false;
    }
  });
}

function readFabricMetadata(filePath) {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry('fabric.mod.json');
  if (!entry) return null;
  const text = entry.getData().toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A few mods leave raw control characters in description strings.
    parsed = JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' '));
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    id: String(parsed.id || ''),
    version: String(parsed.version || ''),
    depends: parsed.depends && typeof parsed.depends === 'object' ? parsed.depends : {},
    breaks: parsed.breaks && typeof parsed.breaks === 'object' ? parsed.breaks : {},
    conflicts: parsed.conflicts && typeof parsed.conflicts === 'object' ? parsed.conflicts : {},
  };
}

function metadataCacheFile(info) {
  const safe = `${info.projectId || 'mod'}-${info.versionId || path.basename(info.filename, '.jar')}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return path.join(MOD_META_DIR, `${safe}.jar`);
}

async function loadModMetadata(info, { signal, log } = {}) {
  const key = info.versionId || `${info.projectId}:${info.filename}`;
  if (metadataCache.has(key)) return metadataCache.get(key);

  let meta = null;
  let sourcePath = null;
  try {
    const installed = path.join(MODS_DIR, info.filename);
    if (fs.existsSync(installed)) {
      try {
        meta = readFabricMetadata(installed);
        if (meta) sourcePath = installed;
      } catch (error) {
        // A truncated/corrupt jar must be replaced, not treated as a valid
        // candidate that forces the resolver to downgrade.
        try {
          fs.rmSync(installed, { force: true });
        } catch {
          // ignore cleanup errors
        }
        if (log) log(`${info.filename} повреждён (${error.message}); скачиваю заново`, 'warn');
        meta = null;
      }
    }
    if (!meta) {
      const cached = metadataCacheFile(info);
      await downloadFile({
        url: info.url,
        dest: cached,
        expectedSha1: info.sha1,
        expectedSize: info.size,
        signal,
        timeout: 180000,
        verifySha1: true,
      });
      meta = readFabricMetadata(cached);
      if (meta) sourcePath = cached;
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (log) log(`Не удалось прочитать метаданные ${info.filename}: ${error.message}`, 'warn');
  }

  const record = meta ? { ...meta, info, sourcePath } : null;
  metadataCache.set(key, record);
  return record;
}

function localModEntry(spec) {
  const filename = findExisting(MODS_DIR, spec.pattern);
  if (!filename) return null;
  const filePath = path.join(MODS_DIR, filename);
  try {
    const meta = readFabricMetadata(filePath);
    if (!meta) return null;
    return {
      spec,
      info: {
        projectId: spec.id,
        versionId: null,
        filename,
        url: null,
        sha1: null,
        size: null,
        version: meta.version,
        datePublished: '',
        dependencies: [],
      },
      meta,
      sourcePath: filePath,
    };
  } catch {
    return null;
  }
}

function predicateLabel(predicate) {
  return Array.isArray(predicate) ? predicate.join(' || ') : String(predicate);
}

function compareEntries(from, target) {
  const targetId = target.meta.id;
  if (!targetId) return null;

  const depends = from.meta.depends || {};
  if (Object.prototype.hasOwnProperty.call(depends, targetId)
    && !versionMatches(target.meta.version, depends[targetId])) {
    return {
      type: 'depends',
      from,
      target,
      predicate: depends[targetId],
      reason: `${from.spec.label} ${from.meta.version} требует ${target.spec.label} ${predicateLabel(depends[targetId])}, а выбран ${target.meta.version}`,
    };
  }

  for (const kind of ['breaks', 'conflicts']) {
    const map = from.meta[kind] || {};
    if (Object.prototype.hasOwnProperty.call(map, targetId)
      && versionMatches(target.meta.version, map[targetId])) {
      return {
        type: kind,
        from,
        target,
        predicate: map[targetId],
        reason: `${from.spec.label} ${from.meta.version} несовместим с ${target.spec.label} ${target.meta.version} (${kind}: ${predicateLabel(map[targetId])})`,
      };
    }
  }
  return null;
}

function collectIssues(entry, selected) {
  const issues = [];
  for (const other of selected) {
    const forward = compareEntries(entry, other);
    if (forward) issues.push(forward);
    const backward = compareEntries(other, entry);
    if (backward) issues.push(backward);
  }
  return issues;
}

async function resolveModSet(specs, gameVersion, { signal, log, limit = 10, maxChecks = 300 } = {}) {
  const candidates = new Map();
  for (const spec of specs) {
    candidates.set(spec.id, await listModrinthCandidates(spec.id, {
      gameVersion,
      loader: 'fabric',
      signal,
      limit,
    }));
  }

  let checks = 0;
  const loggedRejections = new Set();

  async function search(position, selected) {
    if (position >= specs.length) return selected;
    const spec = specs[position];
    for (const info of candidates.get(spec.id)) {
      checks += 1;
      if (checks > maxChecks) {
        throw new Error('слишком много вариантов модов для проверки совместимости');
      }
      const meta = await loadModMetadata(info, { signal, log });
      if (!meta) continue;
      const entry = { spec, info, meta, sourcePath: meta.sourcePath };
      const issues = collectIssues(entry, selected);
      if (issues.length) {
        const reason = issues[0].reason;
        if (log && !loggedRejections.has(reason)) {
          loggedRejections.add(reason);
          log(reason, 'warn');
        }
        continue;
      }
      const result = await search(position + 1, [...selected, entry]);
      if (result) return result;
    }
    return null;
  }

  const result = await search(0, []);
  if (!result) throw new Error('не удалось найти совместимые версии модов');
  if (log) {
    const summary = result.map((entry) => `${entry.spec.label} ${entry.meta.version}`).join(', ');
    log(`Совместимые версии: ${summary}`, 'ok');
  }
  return result;
}

async function copyFileAtomic(source, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const temp = `${dest}.part`;
  await fs.promises.copyFile(source, temp);
  await fs.promises.rm(dest, { force: true });
  await fs.promises.rename(temp, dest);
}

async function ensureMod(projectId, {
  gameVersion,
  loader = 'fabric',
  signal,
  log,
  onProgress,
  label,
  pattern,
  info = null,
  sourcePath = null,
}) {
  fs.mkdirSync(MODS_DIR, { recursive: true });
  try {
    const resolved = info || await findModrinthFile(projectId, { gameVersion, loader, signal });
    const dest = path.join(MODS_DIR, resolved.filename);
    const fromInstalled = sourcePath && path.resolve(sourcePath) === path.resolve(dest);
    if (sourcePath && !fromInstalled && fs.existsSync(sourcePath)) {
      await copyFileAtomic(sourcePath, dest);
    } else if (!fromInstalled) {
      await downloadFile({
        url: resolved.url,
        dest,
        expectedSha1: resolved.sha1,
        expectedSize: resolved.size,
        signal,
        timeout: 180000,
        verifySha1: true,
      });
    }
    removeOtherVersions(MODS_DIR, pattern, resolved.filename);
    if (log) log(`${label}: ${resolved.version || resolved.filename}`, 'ok');
    if (onProgress) onProgress(label, resolved.filename);
    return { path: dest, skipped: false, filename: resolved.filename, version: resolved.version };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    const existing = findExisting(MODS_DIR, pattern);
    if (!existing) throw new Error(`${label}: ${error.message}`);
    if (info?.filename && existing !== info.filename) {
      throw new Error(`${label}: нужна совместимая версия ${info.filename}, но установить её не удалось (${error.message})`);
    }
    if (log) log(`${label}: использую уже скачанный ${existing}`, 'warn');
    if (onProgress) onProgress(label, existing);
    return { path: path.join(MODS_DIR, existing), skipped: true, filename: existing, version: 'локальная версия' };
  }
}

async function installResolvedMods(selected, { signal, log, onProgress } = {}) {
  const byId = new Map(selected.map((entry) => [entry.spec.id, entry]));
  const orderedSpecs = SHADER_MODS.filter((spec) => byId.has(spec.id));
  const results = [];
  for (let i = 0; i < orderedSpecs.length; i += 1) {
    const spec = orderedSpecs[i];
    const entry = byId.get(spec.id);
    if (onProgress) {
      onProgress({
        stage: 'mods',
        index: i + 1,
        total: orderedSpecs.length,
        detail: `Мод ${spec.label}...`,
      });
    }
    results.push(await ensureMod(spec.id, {
      signal,
      log,
      label: spec.label,
      pattern: spec.pattern,
      info: entry.info,
      sourcePath: entry.sourcePath,
    }));
  }
  return results;
}

async function ensureShaderMods(gameVersion, { enabled = true, repairExisting = false, signal, log, onProgress } = {}) {
  if (!enabled) {
    if (!repairExisting) return [];
    const iris = localModEntry(IRIS_MOD);
    const sodium = localModEntry(SODIUM_MOD);
    if (!iris || !sodium) return [];
    const issues = collectIssues(iris, [sodium]);
    if (!issues.length) {
      if (log) log(`Sodium ${sodium.meta.version} и Iris ${iris.meta.version} совместимы`, 'info');
      return [];
    }
    if (log) log(`Sodium/Iris несовместимы: ${issues[0].reason}. Ищу совместимую пару...`, 'warn');
    const selected = await resolveModSet([IRIS_MOD, SODIUM_MOD], gameVersion, { signal, log });
    return installResolvedMods(selected, { signal, log, onProgress });
  }

  if (onProgress) onProgress({ stage: 'mods', index: 0, total: SHADER_MODS.length, detail: 'Проверяю новые версии и совместимость...' });
  let selected;
  try {
    selected = await resolveModSet(RESOLVE_ORDER, gameVersion, { signal, log });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    const iris = localModEntry(IRIS_MOD);
    const sodium = localModEntry(SODIUM_MOD);
    if (iris && sodium) {
      const issues = collectIssues(iris, [sodium]);
      if (!issues.length) {
        if (log) log(`Не удалось проверить обновления (${error.message}); оставляю совместимые Sodium ${sodium.meta.version} и Iris ${iris.meta.version}`, 'warn');
        return [];
      }
      throw new Error(`Не удалось обновить Sodium/Iris: ${error.message}. Установленная пара тоже несовместима: ${issues[0].reason}`);
    }
    throw new Error(`Не удалось подобрать совместимые версии модов: ${error.message}`);
  }
  return installResolvedMods(selected, { signal, log, onProgress });
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
  SODIUM_MOD,
  IRIS_MOD,
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
  resolveModSet,
};
