'use strict';

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  shell,
  clipboard,
  Menu,
} = require('electron');

const {
  APP_VERSION,
  MC_VERSION,
  DEFAULT_SERVER,
  BASE_DIR,
  GAME_DIR,
  VERSIONS_DIR,
  ASSETS_DIR,
  LOGS_DIR,
  CONFIG_PATH,
  UI_STATE_PATH,
  MODS_DIR,
  SHADERPACKS_DIR,
  RESOURCEPACKS_DIR,
  SCREENSHOTS_DIR,
  LAUNCHER_LOG,
  JAVA_LOG,
  ensureDirs,
} = require('./core/paths');
const {
  getConfig,
  saveConfig,
  resetConfig,
  getSystemInfo,
} = require('./core/config');
const { LauncherEngine } = require('./core/engine');
const {
  getStore: getServerStore,
  addServer,
  updateServer,
  removeServer,
  setServerIcon,
} = require('./core/servers');
const { pingServer } = require('./core/ping');
const { javaInfo } = require('./core/java');
const { readLogs } = require('./core/logs');
const { fetchAvatar } = require('./core/profile');
const { shaderFilesStatus } = require('./core/mods');
const { readJson, writeJsonAtomic, sleep } = require('./core/utils');

const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke-test');
const isSmokeLaunch = process.argv.includes('--smoke-launch');
const smokeViewArg = process.argv.find((arg) => arg.startsWith('--smoke-view='));
const smokeView = smokeViewArg ? smokeViewArg.split('=')[1] : 'home';
const smokeActionArg = process.argv.find((arg) => arg.startsWith('--smoke-action='));
const smokeAction = smokeActionArg ? smokeActionArg.split('=')[1] : '';

let mainWindow = null;
let engine = null;
let quitting = false;
let minimizedForGame = false;
let saveBoundsTimer = null;
const pingCache = new Map();

app.setName('URALCRAFT Launcher');
if (process.platform === 'win32') {
  app.setAppUserModelId('ru.uralcraft.launcher');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function loadUiState() {
  const value = readJson(UI_STATE_PATH, {});
  return value && typeof value === 'object' ? value : {};
}

function saveUiState(patch) {
  const state = loadUiState();
  const next = {
    ...state,
    ...patch,
    window: patch?.window ? { ...(state.window || {}), ...patch.window } : state.window,
  };
  try {
    writeJsonAtomic(UI_STATE_PATH, next);
  } catch {
    // ignore
  }
  return next;
}

function validBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  if (bounds.width < 1000 || bounds.height < 680) return null;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
  const displays = screen.getAllDisplays();
  const intersects = displays.some((display) => {
    const area = display.workArea;
    return bounds.x < area.x + area.width
      && bounds.x + bounds.width > area.x
      && bounds.y < area.y + area.height
      && bounds.y + bounds.height > area.y;
  });
  return intersects ? bounds : null;
}

function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  saveUiState({
    window: {
      ...bounds,
      maximized: mainWindow.isMaximized(),
    },
  });
}

function scheduleBoundsSave() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(rememberBounds, 350);
}

function createWindow() {
  const ui = loadUiState();
  const bounds = validBounds(ui?.window) || {};
  const iconPath = path.join(__dirname, '..', 'renderer', 'assets', 'ural.ico');
  const config = getConfig();
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = Math.max(1000, Math.min(bounds.width || 1280, workArea.width - 32));
  const windowHeight = Math.max(680, Math.min(bounds.height || 840, workArea.height - 32));

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    frame: false,
    thickFrame: true,
    roundedCorners: true,
    backgroundColor: config.theme === 'light' ? '#f1ece4' : '#08090d',
    title: 'URALCRAFT — CAIIIEHbKA & Friends',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged || isDev,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  if (ui?.window?.maximized) mainWindow.maximize();

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev && !isSmoke) mainWindow.webContents.openDevTools({ mode: 'detach' });
    if (isSmoke) runSmokeScreenshot();
  });

  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('close', rememberBounds);
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function wireEngine() {
  engine = new LauncherEngine();

  engine.on('progress', (payload) => sendToRenderer('launch:progress', payload));
  engine.on('log', (entry) => sendToRenderer('log:line', entry));
  engine.on('toast', (payload) => sendToRenderer('toast', payload));
  engine.on('game-state', (state) => {
    sendToRenderer('game:state', state);
    if (state.status === 'running') {
      const config = getConfig();
      if (config.minimizeOnLaunch && !isSmoke) {
        minimizedForGame = true;
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
            mainWindow.minimize();
          }
        }, 700);
      }
    }
    if (state.status === 'stopped' || state.status === 'crashed') {
      if (minimizedForGame && mainWindow && !mainWindow.isDestroyed()) {
        minimizedForGame = false;
        setTimeout(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }, 300);
      }
    }
  });
}

function wireIpc() {
  ipcMain.handle('app:bootstrap', async () => {
    const config = getConfig();
    const [java, uiState] = await Promise.all([
      javaInfo(25).catch(() => ({ found: false, path: null, version: null })),
      Promise.resolve(loadUiState()),
    ]);
    const shaderFiles = shaderFilesStatus();
    return {
      app: {
        name: 'URALCRAFT',
        version: APP_VERSION,
        electron: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
      },
      version: {
        id: MC_VERSION,
        label: `Minecraft ${MC_VERSION}`,
      },
      config,
      firstRun: !fs.existsSync(CONFIG_PATH),
      system: getSystemInfo(),
      paths: {
        base: BASE_DIR,
        game: GAME_DIR,
        logs: LOGS_DIR,
        java: java.path,
      },
      java,
      shaderFiles,
      ui: uiState,
      runtime: engine.getRuntime(),
      serverDefault: DEFAULT_SERVER,
      servers: getServerStore(),
    };
  });

  ipcMain.handle('config:save', (_event, patch) => {
    const next = saveConfig(patch && typeof patch === 'object' ? patch : {});
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(next.theme === 'light' ? '#f1ece4' : '#08090d');
    }
    return next;
  });

  ipcMain.handle('config:reset', () => {
    const next = resetConfig();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor('#08090d');
    }
    return next;
  });

  ipcMain.handle('game:launch', async (_event, serverId) => {
    try {
      return await engine.launch({ serverId: typeof serverId === 'string' ? serverId : null });
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('game:verify', async () => {
    try {
      return await engine.verify();
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('game:cancel', () => ({ ok: engine.cancel() }));
  ipcMain.handle('game:runtime', () => engine.getRuntime());

  ipcMain.handle('servers:list', () => getServerStore());

  ipcMain.handle('servers:add', (_event, payload) => {
    try {
      return { ok: true, ...addServer(payload || {}) };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('servers:update', (_event, id, payload) => {
    try {
      return { ok: true, ...updateServer(String(id), payload || {}) };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('servers:remove', (_event, id) => {
    try {
      return { ok: true, store: removeServer(String(id)) };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('server:ping', async (_event, address, options) => {
    const value = String(address || '').trim().slice(0, 255);
    const force = Boolean(options?.force);
    const serverId = typeof options?.serverId === 'string' ? options.serverId : null;
    const cached = pingCache.get(value);
    if (!force && cached && Date.now() - cached.at < (cached.result.online ? 12000 : 6000)) {
      return cached.result;
    }
    const result = await pingServer(value, { timeout: 3500 });
    if (serverId && result.online && result.favicon) {
      try {
        setServerIcon(serverId, result.favicon);
      } catch {
        // An icon must never break a status check.
      }
    }
    pingCache.set(value, { at: Date.now(), result });
    return result;
  });

  ipcMain.handle('profile:avatar', async (_event, nick) => {
    const value = String(nick || '').trim().slice(0, 32);
    if (!value) return null;
    return fetchAvatar(value);
  });

  ipcMain.handle('logs:read', () => readLogs());

  ipcMain.handle('clipboard:write', (_event, text) => {
    try {
      clipboard.writeText(String(text || '').slice(0, 2 * 1024 * 1024));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('shell:open-path', async (_event, key) => {
    ensureDirs();
    const targets = {
      game: GAME_DIR,
      logs: LOGS_DIR,
      screenshots: SCREENSHOTS_DIR,
      resourcepacks: RESOURCEPACKS_DIR,
      shaderpacks: SHADERPACKS_DIR,
      mods: MODS_DIR,
      versions: VERSIONS_DIR,
      assets: ASSETS_DIR,
      'launcher-log': LAUNCHER_LOG,
      'java-log': JAVA_LOG,
      base: BASE_DIR,
    };
    const target = targets[String(key || '')];
    if (!target) return { ok: false, error: 'Неизвестный путь' };
    if (target === LAUNCHER_LOG && !fs.existsSync(target)) return { ok: true, path: LOGS_DIR, empty: true };
    if (target === JAVA_LOG && !fs.existsSync(target)) return { ok: true, path: LOGS_DIR, empty: true };
    const error = await shell.openPath(target);
    return { ok: !error, path: target, error: error || null };
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    try {
      const parsed = new URL(String(url));
      if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false };
      await shell.openExternal(parsed.href);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('ui:state', (_event, patch) => {
    const safe = {};
    if (patch && typeof patch === 'object' && typeof patch.view === 'string') {
      if (['home', 'server', 'settings', 'logs'].includes(patch.view)) safe.view = patch.view;
    }
    if (!Object.keys(safe).length) return loadUiState();
    return saveUiState(safe);
  });

  ipcMain.handle('window:is-maximized', () => Boolean(mainWindow?.isMaximized()));
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
  });
  ipcMain.on('window:close', () => mainWindow?.close());
}

async function captureSmoke(name) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const image = await mainWindow.webContents.capturePage();
  const dir = path.join(process.cwd(), 'release');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `preview-${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`SMOKE_SCREENSHOT=${file}`);
}

function runSmokeScreenshot() {
  setTimeout(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      for (let i = 0; i < 100; i += 1) {
        const ready = await mainWindow.webContents.executeJavaScript('Boolean(window.__uralcraftReady)');
        if (ready) break;
        await sleep(100);
      }
      if (isSmokeLaunch) {
        await mainWindow.webContents.executeJavaScript(
          "window.__uralcraftShowView && window.__uralcraftShowView('home')",
        );
        await sleep(800);
        await mainWindow.webContents.executeJavaScript("document.getElementById('playButton')?.click()");
        await sleep(2800);
        await captureSmoke('preparing');
        for (let i = 0; i < 160; i += 1) {
          if (engine?.getRuntime().running) break;
          await sleep(500);
        }
        await sleep(1300);
        await captureSmoke('running');
        if (engine?.game) {
          try { engine.game.kill(); } catch { /* ignore */ }
        }
        await sleep(1800);
        return;
      }
      if (smokeView) {
        await mainWindow.webContents.executeJavaScript(
          `window.__uralcraftShowView && window.__uralcraftShowView(${JSON.stringify(smokeView)})`,
        );
        await sleep(1000);
      }
      if (smokeAction === 'logout' || smokeAction === 'logout-submit') {
        await mainWindow.webContents.executeJavaScript(
          "document.querySelector('[data-action=\"logout\"]')?.click()",
        );
        await sleep(900);
        if (smokeAction === 'logout-submit') {
          await mainWindow.webContents.executeJavaScript(
            "document.getElementById('onboardingNick').value = 'TestNick'; document.getElementById('onboardingSubmit').click();",
          );
          await sleep(1400);
          await captureSmoke('logout-submitted');
          return;
        }
        await captureSmoke('logout');
        return;
      }
      if (smokeAction === 'add-server' || smokeAction === 'add-server-save') {
        await mainWindow.webContents.executeJavaScript(
          "document.querySelector('[data-action=\"add-server\"]')?.click()",
        );
        await sleep(750);
        if (smokeAction === 'add-server-save') {
          await mainWindow.webContents.executeJavaScript(
            "document.getElementById('serverNameInput').value = 'Мир друзей'; document.getElementById('serverAddressInput').value = '127.0.0.1:25565'; document.getElementById('serverModalSave').click();",
          );
          await sleep(2600);
          await captureSmoke('server-added');
          return;
        }
        await captureSmoke('add-server');
        return;
      }
      if (smokeView === 'server' && !smokeAction) await sleep(4500);
      await mainWindow.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      await sleep(1200);
      await captureSmoke(smokeView || 'home');
    } catch (error) {
      console.error('SMOKE_ERROR', error);
    } finally {
      app.quit();
    }
  }, 300);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  ensureDirs();
  wireEngine();
  wireIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)) shell.openExternal(parsed.href);
    } catch {
      // ignore
    }
    return { action: 'deny' };
  });
});

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  rememberBounds();
  engine?.shutdown();
  if (isSmoke) {
    // Ensure a stalled download cannot keep the smoke-test alive.
    setTimeout(() => app.exit(0), 3000).unref?.();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
