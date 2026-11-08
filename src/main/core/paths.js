'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_VERSION = (() => {
  try {
    return require(path.join(__dirname, '..', '..', '..', 'package.json')).version;
  } catch {
    return '2.0.0';
  }
})();

const MC_VERSION = '26.3';
const DEFAULT_SERVER = '31.25.31.112:22222';
const LAUNCHER_NAME = 'URALCRAFT';
const USER_AGENT = `URALCRAFT/${APP_VERSION}`;

function resolveAppData() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

const BASE_DIR = process.env.URALCRAFT_HOME
  ? path.resolve(process.env.URALCRAFT_HOME)
  : path.join(resolveAppData(), '.uralcraft');
const GAME_DIR = path.join(BASE_DIR, 'game');
const VERSIONS_DIR = path.join(BASE_DIR, 'versions');
const LIBRARIES_DIR = path.join(BASE_DIR, 'libraries');
const ASSETS_DIR = path.join(BASE_DIR, 'assets');
const NATIVES_DIR = path.join(BASE_DIR, 'natives');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const AVATARS_DIR = path.join(CACHE_DIR, 'avatars');
const CONFIG_PATH = path.join(BASE_DIR, 'launcher.json');
const SERVERS_PATH = path.join(BASE_DIR, 'servers.json');
const UI_STATE_PATH = path.join(BASE_DIR, 'launcher-ui.json');
const ASSET_CACHE_PATH = path.join(BASE_DIR, 'asset-cache.json');
const SHADER_STATE_PATH = path.join(BASE_DIR, 'shader-state.json');
const MODS_DIR = path.join(GAME_DIR, 'mods');
const SHADERPACKS_DIR = path.join(GAME_DIR, 'shaderpacks');
const RESOURCEPACKS_DIR = path.join(GAME_DIR, 'resourcepacks');
const SCREENSHOTS_DIR = path.join(GAME_DIR, 'screenshots');
const CONFIG_DIR = path.join(GAME_DIR, 'config');
const LAUNCHER_LOG = path.join(LOGS_DIR, 'launcher.log');
const JAVA_LOG = path.join(LOGS_DIR, 'java.log');
const LATEST_GAME_LOG = path.join(GAME_DIR, 'logs', 'latest.log');

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const FALLBACK_FABRIC_LOADER = '0.20.1';
const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest';

const NATIVE_SUBDIRS = ['java', 'jna', 'lwjgl', 'netty'];

function ensureDirs() {
  const dirs = [
    BASE_DIR,
    GAME_DIR,
    VERSIONS_DIR,
    LIBRARIES_DIR,
    ASSETS_DIR,
    path.join(ASSETS_DIR, 'indexes'),
    path.join(ASSETS_DIR, 'objects'),
    path.join(ASSETS_DIR, 'log_configs'),
    NATIVES_DIR,
    ...NATIVE_SUBDIRS.map((name) => path.join(NATIVES_DIR, name)),
    LOGS_DIR,
    CACHE_DIR,
    AVATARS_DIR,
    MODS_DIR,
    SHADERPACKS_DIR,
    RESOURCEPACKS_DIR,
    SCREENSHOTS_DIR,
    CONFIG_DIR,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  APP_VERSION,
  MC_VERSION,
  DEFAULT_SERVER,
  LAUNCHER_NAME,
  USER_AGENT,
  BASE_DIR,
  GAME_DIR,
  VERSIONS_DIR,
  LIBRARIES_DIR,
  ASSETS_DIR,
  NATIVES_DIR,
  LOGS_DIR,
  CACHE_DIR,
  AVATARS_DIR,
  CONFIG_PATH,
  SERVERS_PATH,
  UI_STATE_PATH,
  ASSET_CACHE_PATH,
  SHADER_STATE_PATH,
  MODS_DIR,
  SHADERPACKS_DIR,
  RESOURCEPACKS_DIR,
  SCREENSHOTS_DIR,
  CONFIG_DIR,
  LAUNCHER_LOG,
  JAVA_LOG,
  LATEST_GAME_LOG,
  MANIFEST_URL,
  FABRIC_META,
  MODRINTH_API,
  FALLBACK_FABRIC_LOADER,
  ADOPTIUM_API,
  NATIVE_SUBDIRS,
  ensureDirs,
};
