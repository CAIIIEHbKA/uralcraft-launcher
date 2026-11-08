'use strict';

const crypto = require('crypto');
const {
  SERVERS_PATH,
  DEFAULT_SERVER,
} = require('./paths');
const { getConfig, saveConfig } = require('./config');
const {
  readJson,
  writeJsonAtomic,
  normalizeServer,
  parseServer,
} = require('./utils');

const DEFAULT_SERVER_NAME = 'Уральский мир';

let cache = null;

function sanitizeName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  return name || 'Сервер';
}

function sanitizeIcon(value) {
  if (typeof value !== 'string') return null;
  if (!/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value)) return null;
  if (value.length > 300000) return null;
  return value;
}

function defaultServer() {
  return {
    id: 'default',
    name: DEFAULT_SERVER_NAME,
    address: DEFAULT_SERVER,
    icon: null,
    isDefault: true,
    createdAt: Date.now(),
    lastPlayedAt: null,
  };
}

function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const address = normalizeServer(raw.address || '');
  if (!parseServer(address)) return null;
  const isDefault = Boolean(raw.isDefault) || address === DEFAULT_SERVER;
  const id = isDefault
    ? 'default'
    : (typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{3,64}$/.test(raw.id)
      ? raw.id
      : `srv_${crypto.randomBytes(5).toString('hex')}`);
  return {
    id,
    name: isDefault ? DEFAULT_SERVER_NAME : sanitizeName(raw.name),
    address,
    icon: sanitizeIcon(raw.icon),
    isDefault,
    createdAt: Number(raw.createdAt) || Date.now() + index,
    lastPlayedAt: Number(raw.lastPlayedAt) || null,
  };
}

function normalizeStore(raw) {
  const config = getConfig();
  const list = [];
  const seenAddresses = new Set();
  const seenIds = new Set();

  if (raw && Array.isArray(raw.servers)) {
    for (let i = 0; i < raw.servers.length; i += 1) {
      const entry = normalizeEntry(raw.servers[i], i);
      if (!entry) continue;
      if (seenAddresses.has(entry.address) || seenIds.has(entry.id)) continue;
      seenAddresses.add(entry.address);
      seenIds.add(entry.id);
      list.push(entry);
    }
  }

  let defaultEntry = list.find((entry) => entry.isDefault);
  if (!defaultEntry) {
    defaultEntry = defaultServer();
    list.unshift(defaultEntry);
  } else {
    list.splice(list.indexOf(defaultEntry), 1);
    defaultEntry.name = DEFAULT_SERVER_NAME;
    defaultEntry.address = DEFAULT_SERVER;
    defaultEntry.isDefault = true;
    defaultEntry.id = 'default';
    list.unshift(defaultEntry);
  }

  // A custom server from the old launcher config is preserved.
  if (!raw && config.server && config.server !== DEFAULT_SERVER
    && !seenAddresses.has(normalizeServer(config.server))) {
    list.push({
      id: `srv_${crypto.randomBytes(5).toString('hex')}`,
      name: 'Мой сервер',
      address: normalizeServer(config.server),
      icon: null,
      isDefault: false,
      createdAt: Date.now(),
      lastPlayedAt: null,
    });
  }

  let lastPlayedId = typeof raw?.lastPlayedId === 'string' ? raw.lastPlayedId : null;
  if (!lastPlayedId || !list.some((entry) => entry.id === lastPlayedId)) {
    const configured = config.server
      ? list.find((entry) => entry.address === normalizeServer(config.server))
      : null;
    lastPlayedId = configured?.id || list[0].id;
  }

  return { version: 1, lastPlayedId, servers: list };
}

function persist(store) {
  cache = store;
  writeJsonAtomic(SERVERS_PATH, store);
  return store;
}

function getStore() {
  if (cache) return cache;
  const raw = readJson(SERVERS_PATH, null);
  const store = normalizeStore(raw);
  if (!raw || JSON.stringify(raw) !== JSON.stringify(store)) {
    persist(store);
  } else {
    cache = store;
  }
  return cache;
}

function getServers() {
  return getStore().servers.map((entry) => ({ ...entry }));
}

function getLastPlayedId() {
  return getStore().lastPlayedId;
}

function getLastPlayedServer() {
  const store = getStore();
  return store.servers.find((entry) => entry.id === store.lastPlayedId)
    || store.servers.find((entry) => entry.isDefault)
    || store.servers[0]
    || null;
}

function getServerById(id) {
  return getStore().servers.find((entry) => entry.id === id) || null;
}

function addServer({ name, address }) {
  const store = getStore();
  const normalized = normalizeServer(address);
  if (!parseServer(normalized)) throw new Error('Неверный адрес сервера');
  if (store.servers.some((entry) => entry.address === normalized)) {
    throw new Error('Такой сервер уже есть в списке');
  }
  const entry = {
    id: `srv_${crypto.randomBytes(5).toString('hex')}`,
    name: sanitizeName(name),
    address: normalized,
    icon: null,
    isDefault: false,
    createdAt: Date.now(),
    lastPlayedAt: null,
  };
  store.servers.push(entry);
  persist(store);
  return { store: getStore(), server: { ...entry } };
}

function updateServer(id, { name, address }) {
  const store = getStore();
  const entry = store.servers.find((item) => item.id === id);
  if (!entry) throw new Error('Сервер не найден');
  if (entry.isDefault) throw new Error('Домашний сервер нельзя изменить');
  const normalized = normalizeServer(address);
  if (!parseServer(normalized)) throw new Error('Неверный адрес сервера');
  if (store.servers.some((item) => item.id !== id && item.address === normalized)) {
    throw new Error('Такой сервер уже есть в списке');
  }
  entry.name = sanitizeName(name);
  entry.address = normalized;
  persist(store);
  return { store: getStore(), server: { ...entry } };
}

function removeServer(id) {
  const store = getStore();
  const entry = store.servers.find((item) => item.id === id);
  if (!entry) throw new Error('Сервер не найден');
  if (entry.isDefault) throw new Error('Домашний сервер нельзя удалить');
  store.servers = store.servers.filter((item) => item.id !== id);
  if (store.lastPlayedId === id) {
    store.lastPlayedId = store.servers.find((item) => item.isDefault)?.id || store.servers[0]?.id;
  }
  persist(store);
  return getStore();
}

function markLastPlayed(id) {
  const store = getStore();
  const entry = store.servers.find((item) => item.id === id);
  if (!entry) return null;
  store.lastPlayedId = entry.id;
  entry.lastPlayedAt = Date.now();
  persist(store);
  const config = getConfig();
  if (config.server !== entry.address) {
    saveConfig({ server: entry.address });
  }
  return { ...entry };
}

function setServerIcon(id, icon) {
  const clean = sanitizeIcon(icon);
  if (!clean) return null;
  const store = getStore();
  const entry = store.servers.find((item) => item.id === id);
  if (!entry || entry.icon === clean) return entry ? { ...entry } : null;
  entry.icon = clean;
  persist(store);
  return { ...entry };
}

module.exports = {
  DEFAULT_SERVER_NAME,
  getStore,
  getServers,
  getLastPlayedId,
  getLastPlayedServer,
  getServerById,
  addServer,
  updateServer,
  removeServer,
  markLastPlayed,
  setServerIcon,
};
