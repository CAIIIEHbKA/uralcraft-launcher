'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const {
  APP_VERSION,
  MC_VERSION,
  GAME_DIR,
  ASSETS_DIR,
  NATIVES_DIR,
  LOGS_DIR,
  LAUNCHER_LOG,
  JAVA_LOG,
  LATEST_GAME_LOG,
  ensureDirs,
} = require('./paths');
const { getConfig } = require('./config');
const {
  getLastPlayedServer,
  getServerById,
  markLastPlayed,
} = require('./servers');
const {
  fetchVersion,
  ensureClient,
  ensureLibraries,
  ensureAssets,
  ensureLogConfig,
  getJavaMajor,
} = require('./version');
const { fetchFabricProfile } = require('./fabric');
const { ensureJava } = require('./java');
const {
  ensureShaderMods,
  ensureVoiceChat,
  ensureShaderPack,
  ensureAnimations,
  setIrisShaderPack,
  setRenderScale,
} = require('./mods');
const { buildCommand, spawnGame } = require('./launch');
const {
  sanitizeNickname,
  isValidNickname,
  parseServer,
  abortError,
  humanBytes,
} = require('./utils');

const PHASE_RANGES = {
  version: [0, 0.03],
  client: [0.03, 0.10],
  fabric: [0.10, 0.14],
  libraries: [0.14, 0.32],
  assets: [0.32, 0.78],
  java: [0.78, 0.88],
  mods: [0.88, 0.94],
  shaderpack: [0.94, 0.96],
  animations: [0.96, 0.985],
  launch: [0.985, 1],
  done: [1, 1],
};

const PHASE_LABELS = {
  version: 'Версия Minecraft',
  client: 'Клиент игры',
  fabric: 'Fabric Loader',
  libraries: 'Библиотеки',
  assets: 'Ресурсы игры',
  java: 'Java 25',
  mods: 'Моды',
  shaderpack: 'Шейдерпак',
  animations: 'Анимации мобов',
  launch: 'Запуск',
  done: 'Готово',
};

function rotateLog() {
  try {
    if (fs.existsSync(LAUNCHER_LOG) && fs.statSync(LAUNCHER_LOG).size > 5 * 1024 * 1024) {
      fs.renameSync(LAUNCHER_LOG, `${LAUNCHER_LOG}.1`);
    }
  } catch {
    // ignore
  }
}

class LauncherEngine extends EventEmitter {
  constructor() {
    super();
    this.busy = false;
    this.mode = null;
    this.controller = null;
    this.game = null;
    this.gameStartedAt = null;
    this.lastProgress = null;
    this.lastEmit = 0;
    this.lastGlobal = -1;
    this.phase = 'idle';
    this.phaseDetail = '';
    this.pendingProgress = null;
    this.cancelled = false;
    this.recentGameLines = [];
    this.javaLogStream = null;
    this.inXmlEvent = false;
    this.latestLogTimer = null;
    this.latestLogOffset = null;
    this.latestLogBuffer = '';
    rotateLog();
  }

  log(message, level = 'info', source = 'launcher') {
    const entry = {
      time: new Date().toISOString(),
      level,
      message: String(message),
      source,
    };
    try {
      ensureDirs();
      fs.appendFileSync(LAUNCHER_LOG, `[${new Date().toLocaleString('ru-RU')}] [${level}] ${message}\n`, 'utf8');
    } catch {
      // ignore disk errors
    }
    this.emit('log', entry);
  }

  getRuntime() {
    return {
      busy: this.busy,
      mode: this.mode,
      running: Boolean(this.game),
      pid: this.game?.pid || null,
      gameStartedAt: this.gameStartedAt,
      phase: this.phase,
      detail: this.phaseDetail,
      progress: this.lastProgress,
    };
  }

  setPhase(phase, fraction, detail, extra = {}, force = false) {
    const range = PHASE_RANGES[phase] || [0, 0];
    const local = Math.max(0, Math.min(1, Number(fraction) || 0));
    const global = range[0] + (range[1] - range[0]) * local;
    this.phase = phase;
    this.phaseDetail = detail || PHASE_LABELS[phase] || '';
    this.pendingProgress = {
      mode: this.mode || 'launch',
      status: this.mode === 'verify' ? 'verifying' : this.busy ? 'preparing' : 'idle',
      phase,
      phaseLabel: PHASE_LABELS[phase] || '',
      detail: this.phaseDetail,
      progress: Math.max(this.lastGlobal, global),
      percent: Math.round(Math.max(this.lastGlobal, global) * 100),
      ...extra,
      startedAt: this.gameStartedAt || this.prepareStartedAt || Date.now(),
    };
    this.flushProgress(force);
  }

  flushProgress(force = false) {
    if (!this.pendingProgress) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < 80) return;
    this.lastEmit = now;
    this.lastGlobal = Math.max(this.lastGlobal, this.pendingProgress.progress || 0);
    const payload = { ...this.pendingProgress, progress: this.lastGlobal, percent: Math.round(this.lastGlobal * 100) };
    this.lastProgress = payload;
    this.emit('progress', payload);
  }

  emitState(status, extra = {}) {
    this.emit('game-state', {
      status,
      running: Boolean(this.game),
      pid: this.game?.pid || null,
      startedAt: this.gameStartedAt,
      ...extra,
    });
  }

  assertFree() {
    if (this.busy) throw new Error('Подготовка уже идёт');
    if (this.game) throw new Error('Minecraft уже запущен');
  }

  async launch({ serverId = null } = {}) {
    this.assertFree();
    const config = getConfig();
    const nick = sanitizeNickname(config.nick);
    if (!isValidNickname(nick)) {
      throw new Error('Введи ник от 2 до 32 символов');
    }
    const selectedServer = serverId ? getServerById(serverId) : getLastPlayedServer();
    if (!selectedServer) throw new Error('Сначала добавь сервер в список');
    const server = config.autoConnect ? parseServer(selectedServer.address) : null;
    if (config.autoConnect && !server) {
      throw new Error('Проверь адрес выбранного сервера');
    }
    this.busy = true;
    this.mode = 'launch';
    this.cancelled = false;
    this.lastGlobal = -1;
    this.controller = new AbortController();
    this.prepareStartedAt = Date.now();
    this.emitState('preparing');
    this.setPhase('version', 0, 'Проверяю версию Minecraft...', {}, true);
    try {
      const result = await this.prepareAndLaunch(config, nick, server, {
        verify: false,
        serverId: selectedServer.id,
      });
      this.busy = false;
      this.setPhase('done', 1, 'Minecraft запускается', {}, true);
      this.emitState('running', {
        pid: result.child.pid,
        startedAt: this.gameStartedAt,
        serverId: selectedServer.id,
        serverName: selectedServer.name,
      });
      return {
        ok: true,
        pid: result.child.pid,
        serverId: selectedServer.id,
        serverName: selectedServer.name,
      };
    } catch (error) {
      this.busy = false;
      if (error?.name === 'AbortError' || this.cancelled) {
        this.phase = 'idle';
        this.log('Подготовка отменена', 'warn');
        this.emitState('cancelled');
        this.setPhase('version', 0, 'Запуск отменён', { progress: 0 }, true);
        return { ok: false, cancelled: true };
      }
      this.phase = 'error';
      this.log(error.message || String(error), 'error');
      this.emitState('error', { message: error.message || String(error) });
      this.setPhase('launch', 0, error.message || 'Ошибка запуска', { error: true }, true);
      throw error;
    } finally {
      this.controller = null;
      this.mode = null;
    }
  }

  async verify() {
    this.assertFree();
    const config = getConfig();
    const nick = sanitizeNickname(config.nick) || 'Player';
    const selectedServer = getLastPlayedServer();
    const server = config.autoConnect && selectedServer
      ? parseServer(selectedServer.address)
      : null;
    this.busy = true;
    this.mode = 'verify';
    this.cancelled = false;
    this.lastGlobal = -1;
    this.controller = new AbortController();
    this.prepareStartedAt = Date.now();
    this.emitState('verifying');
    this.setPhase('version', 0, 'Начинаю проверку файлов...', {}, true);
    try {
      const result = await this.prepareAndLaunch(config, nick, server, { verify: true, dryRun: true });
      this.busy = false;
      this.setPhase('done', 1, 'Все файлы на месте', { verified: true }, true);
      this.emitState('verified', { ok: true });
      return { ok: true, commandLength: result.command.length };
    } catch (error) {
      this.busy = false;
      if (error?.name === 'AbortError' || this.cancelled) {
        this.log('Проверка отменена', 'warn');
        this.emitState('cancelled');
        return { ok: false, cancelled: true };
      }
      this.phase = 'error';
      this.log(error.message || String(error), 'error');
      this.emitState('error', { message: error.message || String(error) });
      throw error;
    } finally {
      this.controller = null;
      this.mode = null;
    }
  }

  async prepareAndLaunch(config, nick, server, { verify = false, dryRun = false, serverId = null } = {}) {
    const signal = this.controller.signal;
    const versionLabel = config.version || MC_VERSION;
    if (!dryRun) this.log(`Подготовка Minecraft ${versionLabel} для ${nick}`, 'accent');
    else this.log('Проверка целостности клиента', 'accent');

    this.setPhase('version', 0.25, 'Получаю список версий...', { bytesTotal: 0, bytesDone: 0 }, true);
    const vanilla = await fetchVersion(versionLabel, {
      signal,
      log: (message, level) => this.log(message, level),
    });
    this.setPhase('version', 1, `Minecraft ${vanilla.id}`, { bytesTotal: 0, bytesDone: 0 }, true);

    this.setPhase('client', 0, 'Проверяю клиент игры...', {}, true);
    const client = await ensureClient(vanilla, {
      signal,
      verify,
      log: (message, level) => this.log(message, level),
      onProgress: (progress) => {
        const fraction = progress.total ? progress.downloaded / progress.total : 0;
        this.setPhase('client', fraction, `Клиент: ${humanBytes(progress.downloaded)} / ${humanBytes(progress.total)}`, {
          bytesDone: progress.downloaded,
          bytesTotal: progress.total,
          cached: Boolean(progress.cached),
        });
      },
    });
    this.setPhase('client', 1, `Клиент готов: ${humanBytes(client.size)}`, {
      bytesDone: client.size,
      bytesTotal: client.size,
    }, true);

    let merged = vanilla;
    if (config.shaders || config.voiceChat) {
      this.setPhase('fabric', 0.1, 'Получаю профиль Fabric...', {}, true);
      const fabric = await fetchFabricProfile(vanilla, {
        signal,
        log: (message, level) => this.log(message, level),
      });
      merged = fabric.merged;
      this.setPhase('fabric', 1, `Fabric ${fabric.loaderVersion}`, {}, true);
    }

    this.setPhase('libraries', 0, config.shaders ? 'Проверяю библиотеки Fabric и Minecraft...' : 'Проверяю библиотеки Minecraft...', {}, true);
    const libraries = await ensureLibraries(merged, {
      signal,
      verify,
      nativeKey: vanilla.id,
      log: (message, level) => this.log(message, level),
      onProgress: (progress) => {
        const fraction = progress.bytesTotal
          ? progress.bytesDone / progress.bytesTotal
          : progress.total ? progress.done / progress.total : 0;
        this.setPhase('libraries', fraction, `${progress.label || 'Библиотеки'}: ${progress.done}/${progress.total}`, {
          bytesDone: progress.bytesDone,
          bytesTotal: progress.bytesTotal,
        });
      },
    });
    const classpath = [client.path, ...libraries];
    this.setPhase('libraries', 1, `Библиотеки готовы: ${classpath.length}`, {}, true);

    this.setPhase('assets', 0, 'Проверяю ресурсы игры...', {}, true);
    const assets = await ensureAssets(vanilla, {
      signal,
      verify,
      log: (message, level) => this.log(message, level),
      onProgress: (progress) => {
        const fraction = progress.bytesTotal
          ? progress.bytesDone / progress.bytesTotal
          : progress.total ? progress.done / progress.total : 0;
        this.setPhase('assets', fraction, `Ресурсы: ${progress.done}/${progress.total} · ${humanBytes(progress.bytesDone)}`, {
          bytesDone: progress.bytesDone,
          bytesTotal: progress.bytesTotal,
          done: progress.done,
          total: progress.total,
        });
      },
    });
    this.setPhase('assets', 1, `Ресурсы готовы: ${assets.count} объектов`, {
      bytesDone: assets.bytes,
      bytesTotal: assets.bytes,
    }, true);

    let logConfig = null;
    try {
      logConfig = await ensureLogConfig(vanilla, {
        signal,
        log: (message, level) => this.log(message, level),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      this.log(`Не удалось скачать конфиг логов: ${error.message}`, 'warn');
    }

    const javaMajor = getJavaMajor(vanilla);
    this.setPhase('java', 0, `Ищу Java ${javaMajor}...`, {}, true);
    const javaPath = await ensureJava(javaMajor, {
      signal,
      log: (message, level) => this.log(message, level),
      onProgress: (progress) => {
        this.setPhase('java', Math.max(0.05, progress.progress || 0), progress.detail || `Java ${javaMajor}`, {}, false);
      },
    });
    this.setPhase('java', 1, `Java ${javaMajor} готова`, {}, true);

    if (!config.voiceChat) {
      await ensureVoiceChat(vanilla.id, {
        enabled: false,
        log: (message, level) => this.log(message, level),
      });
    }

    if (config.shaders || config.voiceChat) {
      this.setPhase('mods', 0.05, config.shaders ? 'Проверяю моды...' : 'Проверяю Simple Voice Chat...', {}, true);
      if (config.shaders) {
      await ensureShaderMods(vanilla.id, {
        signal,
        log: (message, level) => this.log(message, level),
        onProgress: (progress) => {
          const fraction = progress.total ? progress.index / progress.total : 0.5;
          this.setPhase('mods', fraction, progress.detail || 'Моды графики...', {}, false);
        },
      });
      }
      await ensureVoiceChat(vanilla.id, {
        enabled: config.voiceChat,
        signal,
        log: (message, level) => this.log(message, level),
        onProgress: (progress) => {
          this.setPhase('mods', config.shaders ? 0.96 : 0.5, progress.detail || 'Simple Voice Chat...', {}, false);
        },
      });
      this.setPhase('mods', 1, config.voiceChat
        ? (config.shaders ? 'Моды готовы' : 'Simple Voice Chat готов')
        : 'Simple Voice Chat выключен', {}, true);

      if (config.shaders) {
        const pack = await ensureShaderPack(vanilla.id, {
          signal,
          log: (message, level) => this.log(message, level),
          onProgress: (progress) => {
            this.setPhase('shaderpack', 0.3, progress.detail || 'Шейдерпак...', {}, false);
          },
        });
        setIrisShaderPack(pack);
        this.setPhase('shaderpack', 1, `Шейдерпак: ${pack}`, {}, true);
      }
    }

    this.setPhase('animations', 0, config.animations ? 'Проверяю анимации мобов...' : 'Отключаю анимации мобов...', {}, true);
    const animations = await ensureAnimations(vanilla.id, {
      enabled: config.animations,
      signal,
      log: (message, level) => this.log(message, level),
      onProgress: (progress) => {
        this.setPhase('animations', 0.4, progress.detail || 'Анимации мобов...', {}, false);
      },
    });
    setRenderScale(Boolean(config.upscale && config.shaders), config.upscaleScale);
    this.setPhase('animations', 1, animations ? `Анимации: ${animations}` : 'Анимации выключены', {}, true);

    const quickPlayServer = server?.address || '';
    const command = buildCommand(merged, javaPath, {
      nick,
      server: quickPlayServer,
      ram: config.ram,
      classpath,
      nativesDir: NATIVES_DIR,
      gameDir: GAME_DIR,
      assetsDir: ASSETS_DIR,
      logConfigPath: logConfig,
    });

    if (dryRun) {
      this.log(`Проверка завершена. Java: ${javaPath}`, 'ok');
      this.setPhase('done', 1, 'Все файлы на месте', {}, true);
      return { command, child: null, version: merged };
    }

    this.setPhase('launch', 0.2, 'Создаю процесс Minecraft...', {}, true);
    this.log(`Запуск Minecraft ${merged.id} · ${config.ram} ГБ RAM`, 'accent');
    this.openJavaLog();
    this.recentGameLines = [];
    this.inXmlEvent = false;
    this.gameStartedAt = Date.now();
    const child = spawnGame(command, {
      onLine: (line) => this.handleGameLine(line),
      onExit: ({ code, signal: exitSignal }) => this.handleGameExit(code, exitSignal),
    });
    this.game = child;
    try {
      await new Promise((resolve, reject) => {
        if (child.pid) resolve();
        else {
          child.once('spawn', resolve);
          child.once('error', reject);
        }
      });
    } catch (error) {
      this.game = null;
      this.gameStartedAt = null;
      if (this.javaLogStream) {
        try { this.javaLogStream.end(); } catch { /* ignore */ }
        this.javaLogStream = null;
      }
      this.emitState('error', { message: `Не удалось запустить Java: ${error.message}` });
      throw new Error(`Не удалось запустить Java: ${error.message}`);
    }

    if (serverId) {
      try {
        markLastPlayed(serverId);
      } catch (error) {
        this.log(`Не удалось запомнить последний сервер: ${error.message}`, 'warn');
      }
    }
    this.startGameLogTail();
    this.setPhase('launch', 1, 'Minecraft запущен', {}, true);
    this.log(`Minecraft запущен (PID ${child.pid})`, 'ok');
    return { command, child, version: merged };
  }

  isExpectedOfflineNoise(text) {
    return /failed to fetch user properties/i.test(text)
      || /invalidcredentials/i.test(text)
      || /failed to fetch realms/i.test(text)
      || /could not authorize you against realms server/i.test(text)
      || /failed to parse into signedjwt/i.test(text)
      || /sun\.misc\.unsafe/i.test(text)
      || /terminally deprecated method/i.test(text)
      || /please consider reporting this to the maintainers/i.test(text);
  }

  isGameChatter(text) {
    return /^(Mappings not present!|Warnings were found!|Loading \d+ mods:|SpongePowered MIXIN Subsystem|Loaded configuration file for Sodium|Searching for graphics cards|Found graphics adapter|Initializing MixinExtras|307 Datafixer optimizations|Environment: Environment\[|Loading Entity Model Features|Loading Entity Texture Features|\[ETF\]|\[EMF\]|\[Indigo\]|SDL \[SYSTEM\]|Backend library|Modifying process environment|Debug functionality is disabled|ARB_direct_state_access|Profile: HIGH|Using graphics backend|Using graphics device|Hardware information|CPU:|GPU:|OS:|Reloading ResourceManager|Found unifont|Size changed to|Created: .*minecraft:textures\/atlas|Thread\[#|OpenGL (Vendor|Renderer|Version)|Enabling GL_DEBUG_OUTPUT|OpenAL initialized|Sound engine started|Sodium has applied one or more workarounds|This is not necessarily an issue|Reference map ')/i.test(text)
      || /recommends any version of modmenu/i.test(text)
      || /Force-disabling mixin/i.test(text)
      || /^Created window using SDL/i.test(text)
      || /^Modifying OpenGL context/i.test(text);
  }

  handleGameLine(rawLine, { fromLatest = false, time = null } = {}) {
    const line = String(rawLine || '').replace(/\r$/, '');
    if (!line.trim()) return;

    // The official log4j config prints LegacyXMLLayout blocks to stdout.
    // We read the human-readable game log from logs/latest.log instead.
    if (line.includes('<log4j:Event')) {
      this.inXmlEvent = true;
      return;
    }
    if (this.inXmlEvent) {
      if (line.includes('</log4j:Event>')) this.inXmlEvent = false;
      return;
    }
    if (fromLatest && !/^\[\d{2}:\d{2}:\d{2}\]/.test(line)) return;
    if (this.isExpectedOfflineNoise(line)) return;

    let message = line;
    let timestamp = time || new Date().toISOString();
    let level = 'game';
    if (fromLatest) {
      const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+\[([^\]]+)\]:\s?(.*)$/);
      if (match) {
        const now = new Date();
        const [hours, minutes, seconds] = match[1].split(':').map(Number);
        timestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds).toISOString();
        message = match[3];
        if (/\/ERROR\]/.test(line)) level = 'error';
        else if (/\/WARN\]/.test(line)) level = 'warn';
      }
    } else if (/error|exception|fatal/i.test(line)) {
      level = 'error';
    } else if (/warn/i.test(line)) {
      level = 'warn';
    }

    if (this.isGameChatter(message)) return;

    this.recentGameLines.push(message);
    if (this.recentGameLines.length > 400) this.recentGameLines.shift();
    if (this.javaLogStream) {
      try {
        this.javaLogStream.write(`${line}\n`);
      } catch {
        // ignore
      }
    }
    this.emit('log', {
      time: timestamp,
      level,
      message,
      source: 'game',
    });
  }

  startGameLogTail() {
    this.stopGameLogTail();
    this.latestLogOffset = null;
    this.latestLogBuffer = '';
    this.latestLogTimer = setInterval(() => this.pollGameLog(), 450);
    setTimeout(() => this.pollGameLog(), 700).unref?.();
  }

  stopGameLogTail() {
    if (this.latestLogTimer) {
      clearInterval(this.latestLogTimer);
      this.latestLogTimer = null;
    }
    if (this.latestLogBuffer) {
      const line = this.latestLogBuffer;
      this.latestLogBuffer = '';
      this.handleGameLine(line, { fromLatest: true });
    }
  }

  pollGameLog() {
    try {
      if (!fs.existsSync(LATEST_GAME_LOG)) return;
      const stat = fs.statSync(LATEST_GAME_LOG);
      const gameStart = this.gameStartedAt || Date.now();
      if (stat.mtimeMs < gameStart - 5000) return;
      if (this.latestLogOffset === null) this.latestLogOffset = 0;
      if (stat.size < this.latestLogOffset) this.latestLogOffset = 0;
      if (stat.size <= this.latestLogOffset) return;
      const length = stat.size - this.latestLogOffset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(LATEST_GAME_LOG, 'r');
      try {
        fs.readSync(fd, buffer, 0, length, this.latestLogOffset);
      } finally {
        fs.closeSync(fd);
      }
      this.latestLogOffset = stat.size;
      const text = (this.latestLogBuffer || '') + buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      this.latestLogBuffer = lines.pop() || '';
      for (const line of lines) {
        this.handleGameLine(line, { fromLatest: true });
      }
    } catch {
      // The client may still be creating the log file.
    }
  }

  handleGameExit(code, signal) {
    this.pollGameLog();
    this.stopGameLogTail();
    const duration = this.gameStartedAt ? Date.now() - this.gameStartedAt : 0;
    this.game = null;
    this.gameStartedAt = null;
    this.phase = 'idle';
    if (this.javaLogStream) {
      try {
        this.javaLogStream.end();
      } catch {
        // ignore
      }
      this.javaLogStream = null;
    }
    if (code && code !== 0) {
      const tail = this.recentGameLines.slice(-8).join('\n');
      this.log(`Minecraft завершился с кодом ${code}`, 'error');
      this.emitState('crashed', { code, signal, duration, tail });
      this.emit('toast', {
        type: 'error',
        title: 'Minecraft завершился с ошибкой',
        message: 'Открой вкладку «Логи», чтобы увидеть последние строки.',
      });
    } else {
      this.log('Minecraft закрыт', 'info');
      this.emitState('stopped', { code: code ?? 0, signal, duration });
    }
  }

  cancel() {
    if (!this.busy) return false;
    this.cancelled = true;
    this.controller?.abort(abortError());
    this.log('Отмена подготовки...', 'warn');
    return true;
  }

  openJavaLog() {
    if (this.javaLogStream) return;
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      this.javaLogStream = fs.createWriteStream(JAVA_LOG, { flags: 'w' });
      this.javaLogStream.write(`=== URALCRAFT ${APP_VERSION} · ${new Date().toLocaleString('ru-RU')} ===\n`);
    } catch {
      this.javaLogStream = null;
    }
  }

  shutdown() {
    this.cancel();
    this.stopGameLogTail();
    if (this.javaLogStream) {
      try {
        this.javaLogStream.end();
      } catch {
        // ignore
      }
    }
    // The game process is intentionally left running: closing the launcher
    // should not kill an active Minecraft session.
  }
}

module.exports = {
  LauncherEngine,
  PHASE_LABELS,
};
