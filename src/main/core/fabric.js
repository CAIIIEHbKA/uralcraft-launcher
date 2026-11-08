'use strict';

const fs = require('fs');
const path = require('path');
const {
  FABRIC_META,
  FALLBACK_FABRIC_LOADER,
  VERSIONS_DIR,
} = require('./paths');
const { fetchJson } = require('./net');
const { readJson, writeJsonAtomic } = require('./utils');

function mavenArtifact(lib) {
  if (lib?.downloads?.artifact?.url) return lib;
  const name = String(lib?.name || '');
  const parts = name.split(':');
  if (parts.length < 3) return lib;
  const [group, artifact, version, ...rest] = parts;
  const classifier = rest.length ? rest.join('-') : '';
  const relative = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  const base = String(lib.url || 'https://maven.fabricmc.net/').replace(/\/+$/, '');
  return {
    ...lib,
    downloads: {
      ...(lib.downloads || {}),
      artifact: {
        path: relative,
        url: `${base}/${relative}`,
        sha1: lib.sha1 || null,
        size: lib.size || null,
      },
    },
  };
}

function mergedProfilePath(id) {
  return path.join(VERSIONS_DIR, id, `${id}.json`);
}

function mergeProfiles(vanilla, profile) {
  const args = vanilla.arguments || {};
  const fabricArgs = profile.arguments || {};
  const libraries = [
    ...(vanilla.libraries || []),
    ...(profile.libraries || []).map(mavenArtifact),
  ];
  const merged = {
    ...vanilla,
    id: profile.id || `fabric-loader-${profile.loader?.version || 'unknown'}-${vanilla.id}`,
    inheritsFrom: vanilla.id,
    mainClass: profile.mainClass,
    type: profile.type || vanilla.type,
    libraries,
    arguments: {
      game: [...(args.game || []), ...(fabricArgs.game || [])],
      jvm: [...(args.jvm || []), ...(fabricArgs.jvm || [])],
    },
  };
  merged._fabric = {
    loader: profile.loader?.version || null,
    intermediary: profile.intermediary?.version || null,
    mcVersion: vanilla.id,
  };
  return merged;
}

async function latestLoader(mcVersion, { signal, log } = {}) {
  try {
    const list = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`, {
      signal,
      timeout: 30000,
    });
    if (Array.isArray(list) && list.length) {
      const stable = list.find((item) => item?.loader?.stable && item?.loader?.version);
      if (stable) return stable.loader.version;
      if (list[0]?.loader?.version) return list[0].loader.version;
    }
  } catch (error) {
    if (log) log(`Fabric Meta недоступен: ${error.message}`, 'warn');
  }
  return FALLBACK_FABRIC_LOADER;
}

async function fetchFabricProfile(vanilla, { signal, log } = {}) {
  const loaderVersion = await latestLoader(vanilla.id, { signal, log });
  const profileUrl = `${FABRIC_META}/versions/loader/${encodeURIComponent(vanilla.id)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  try {
    const profile = await fetchJson(profileUrl, { signal, timeout: 30000 });
    const merged = mergeProfiles(vanilla, profile);
    const dest = mergedProfilePath(merged.id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeJsonAtomic(dest, merged);
    if (log) log(`Fabric Loader ${loaderVersion} подключён`, 'ok');
    return { merged, loaderVersion, fromCache: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    const fallbackId = `fabric-loader-${loaderVersion}-${vanilla.id}`;
    const cached = readJson(mergedProfilePath(fallbackId), null)
      || readJson(mergedProfilePath(`fabric-loader-${FALLBACK_FABRIC_LOADER}-${vanilla.id}`), null);
    if (cached?.libraries?.length) {
      if (log) log('Fabric Meta недоступен — использую сохранённый профиль Fabric', 'warn');
      const merged = cached.inheritsFrom ? mergeProfiles(vanilla, cached) : cached;
      return { merged, loaderVersion: cached._fabric?.loader || loaderVersion, fromCache: true };
    }
    throw new Error(`Не удалось получить профиль Fabric: ${error.message}`);
  }
}

module.exports = {
  fetchFabricProfile,
  mergeProfiles,
  latestLoader,
  mavenArtifact,
};
