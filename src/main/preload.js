'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('launcher', {
  platform: process.platform,
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  launch: (serverId) => ipcRenderer.invoke('game:launch', serverId || null),
  verify: () => ipcRenderer.invoke('game:verify'),
  cancel: () => ipcRenderer.invoke('game:cancel'),
  runtime: () => ipcRenderer.invoke('game:runtime'),
  ping: (address, options) => ipcRenderer.invoke('server:ping', address, options),
  servers: () => ipcRenderer.invoke('servers:list'),
  addServer: (payload) => ipcRenderer.invoke('servers:add', payload),
  updateServer: (id, payload) => ipcRenderer.invoke('servers:update', id, payload),
  removeServer: (id) => ipcRenderer.invoke('servers:remove', id),
  getAvatar: (nick) => ipcRenderer.invoke('profile:avatar', nick),
  logs: () => ipcRenderer.invoke('logs:read'),
  openPath: (key) => ipcRenderer.invoke('shell:open-path', key),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', String(text ?? '')),
  uiState: (patch) => ipcRenderer.invoke('ui:state', patch),
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },
  onProgress: (callback) => subscribe('launch:progress', callback),
  onGameState: (callback) => subscribe('game:state', callback),
  onLog: (callback) => subscribe('log:line', callback),
  onToast: (callback) => subscribe('toast', callback),
  onMaximized: (callback) => subscribe('window:maximized', callback),
});
