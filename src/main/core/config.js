'use strict';

const fs = require('fs');
const {
  CONFIG_PATH,
  DEFAULT_SERVER,
  MC_VERSION,
} = require('./paths');
const {
  readJson,
  writeJsonAtomic,
  clampRam,
  recommendedRamGb,
  sanitizeNickname,
  normalizeServer,
  totalRamGb,
} = require('./utils');

const STALE_SERVERS = new Set([
  '192.168.3.14:22222',
  '192.168.3.14',
]);

function defaults() {
  return {
    nick: '',
    server: DEFAULT_SERVER,
    ram: recommendedRamGb(),
    autoConnect: true,
    shaders: false,
    animations: true,
    voiceChat: true,
    upscale: false,
    upscaleScale: 75,
    theme: 'dark',
    themeShortcut: true,
    minimizeOnLaunch: true,
    onboarded: false,
    version: MC_VERSION,
  };
}

function normalizeTheme(value) {
  return ['dark', 'light', 'system'].includes(value) ? value : 'dark';
}

function fromDisk(raw, existed) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') {
    return { config: base, existed };
  }

  base.nick = sanitizeNickname(raw.nick || base.nick);
  const rawServer = normalizeServer(raw.server || raw.serverAddress || base.server);
  base.server = STALE_SERVERS.has(rawServer) ? DEFAULT_SERVER : rawServer || DEFAULT_SERVER;
  base.ram = clampRam(raw.ram);
  base.autoConnect = raw.auto_connect !== undefined ? Boolean(raw.auto_connect) : Boolean(raw.autoConnect ?? base.autoConnect);
  base.shaders = Boolean(raw.shaders ?? base.shaders);
  base.animations = Boolean(raw.animations ?? base.animations);
  base.voiceChat = Boolean(raw.voice_chat ?? raw.voiceChat ?? base.voiceChat);
  base.upscale = Boolean(raw.upscale ?? base.upscale);
  base.upscaleScale = Math.max(50, Math.min(100, Number(raw.upscale_scale ?? raw.upscaleScale ?? base.upscaleScale) || 75));
  base.theme = normalizeTheme(raw.theme || base.theme);
  base.themeShortcut = raw.theme_shortcut !== undefined
    ? Boolean(raw.theme_shortcut)
    : Boolean(raw.themeShortcut ?? base.themeShortcut);
  base.minimizeOnLaunch = raw.minimize_on_launch !== undefined
    ? Boolean(raw.minimize_on_launch)
    : Boolean(raw.minimizeOnLaunch ?? base.minimizeOnLaunch);
  base.onboarded = raw.onboarded !== undefined ? Boolean(raw.onboarded) : existed;
  base.version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : MC_VERSION;

  return { config: base, existed };
}

function loadConfig() {
  const existed = fs.existsSync(CONFIG_PATH);
  const raw = readJson(CONFIG_PATH, null);
  return fromDisk(raw, existed);
}

function toDisk(config) {
  return {
    // legacy keys keep the old Python launcher compatible
    nick: config.nick,
    server: config.server,
    ram: config.ram,
    auto_connect: config.autoConnect,
    shaders: config.shaders,
    animations: config.animations,
    voice_chat: config.voiceChat,
    upscale: config.upscale,
    upscale_scale: config.upscaleScale,
    // new keys
    theme: config.theme,
    theme_shortcut: config.themeShortcut,
    minimize_on_launch: config.minimizeOnLaunch,
    onboarded: config.onboarded,
    version: config.version,
  };
}

let current = null;

function getConfig() {
  if (!current) current = loadConfig().config;
  return { ...current };
}

function saveConfig(patch = {}) {
  const merged = { ...getConfig() };
  const allowed = new Set(Object.keys(defaults()));
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) continue;
    merged[key] = value;
  }
  merged.nick = sanitizeNickname(merged.nick);
  merged.server = normalizeServer(merged.server) || DEFAULT_SERVER;
  merged.ram = clampRam(merged.ram);
  merged.upscaleScale = Math.max(50, Math.min(100, Number(merged.upscaleScale) || 75));
  merged.theme = normalizeTheme(merged.theme);
  merged.autoConnect = Boolean(merged.autoConnect);
  merged.shaders = Boolean(merged.shaders);
  merged.animations = Boolean(merged.animations);
  merged.voiceChat = Boolean(merged.voiceChat);
  merged.upscale = Boolean(merged.upscale);
  merged.themeShortcut = Boolean(merged.themeShortcut);
  merged.minimizeOnLaunch = Boolean(merged.minimizeOnLaunch);
  merged.onboarded = Boolean(merged.onboarded);

  current = merged;
  writeJsonAtomic(CONFIG_PATH, toDisk(merged));
  return { ...merged };
}

function resetConfig() {
  const fresh = defaults();
  current = fresh;
  writeJsonAtomic(CONFIG_PATH, toDisk(fresh));
  return { ...fresh };
}

function getSystemInfo() {
  return {
    totalRamGb: totalRamGb(),
    recommendedRamGb: recommendedRamGb(),
    platform: process.platform,
    arch: process.arch,
  };
}

module.exports = {
  defaults,
  loadConfig,
  getConfig,
  saveConfig,
  resetConfig,
  getSystemInfo,
  normalizeTheme,
};
