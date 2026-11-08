(() => {
  'use strict';

  const api = window.launcher;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  const WEEKDAYS = [
    'воскресенье', 'понедельник', 'вторник', 'среда',
    'четверг', 'пятница', 'суббота',
  ];

  const state = {
    bootstrap: null,
    config: {},
    system: { totalRamGb: 16, recommendedRamGb: 8 },
    java: { found: false },
    paths: {},
    view: 'home',
    server: null,
    serverLoading: false,
    silentPing: false,
    serverCheckedAt: 0,
    servers: [],
    lastPlayedId: null,
    serverPings: {},
    serverListPinging: false,
    editingServerId: null,
    progress: null,
    busy: false,
    running: false,
    gameState: null,
    avatarFallback: '',
    avatarRemote: null,
    logs: { launcher: [], game: [] },
    logsLoaded: false,
    logsLoading: false,
    logFilter: 'all',
    logAutoScroll: true,
    loginMode: 'onboarding',
    pendingPatch: {},
    persistTimer: null,
    persistInFlight: false,
    saveChipTimer: null,
    confirmHandler: null,
    pingTimer: null,
    dockHideTimer: null,
  };

  const els = {};
  const serverIconCache = new Map();

  function cacheElements() {
    const ids = [
      'boot', 'bootProgress', 'bootText', 'app', 'titlebar', 'mainScroll',
      'titleDot', 'titlebarStatus', 'maximizeIcon',
      'railAvatar', 'railIndicator', 'railTheme', 'railThemeIcon',
      'homeDate', 'homeNick', 'homeNick2', 'homeAvatar',
      'headBadge', 'headDot', 'headServerStatus',
      'heroServer', 'heroDot', 'heroServerState', 'heroServerIp',
      'heroGraphics', 'heroGraphicsSub', 'playButton', 'playIcon', 'playLabel',
      'miniServerPill', 'miniServerIp', 'miniPlayers', 'miniPing', 'miniSlots', 'miniMotd',
      'homeRamValue', 'homeRam', 'homeRamHint', 'homeRamMax', 'ramSystem',
      'homeShaders', 'homeAnimations', 'homeVoiceChat', 'homeFsr', 'homeFsrSwitch', 'homeFsrValue',
      'graphicsMode',
      'serverList', 'serverCount', 'serverModal', 'serverModalTitle',
      'serverModalSubtitle', 'serverNameInput', 'serverAddressInput',
      'serverModalError', 'serverModalSave',
      'miniServerName', 'miniServerIcon', 'settingsServerName',
      'settingsServerAddress', 'settingsServerIcon',
      'settingsAvatar', 'settingNick', 'settingServer', 'settingAutoConnect',
      'settingsServerPill', 'testServerButton',
      'settingsRamChip', 'settingsRamValue', 'settingRam', 'settingsRamHint',
      'settingsRamMax', 'settingMinimize',
      'settingsGraphicsMode', 'settingShaders', 'settingAnimations', 'settingVoiceChat',
      'settingUpscale', 'settingUpscaleScale', 'settingsFsrValue',
      'upscaleSliderWrap', 'themeOptions', 'settingThemeShortcut',
      'javaStatusChip', 'saveChip',
      'logFilter', 'logAutoScroll', 'logTerminal', 'logEmpty', 'logLines',
      'logCount',
      'launchDock', 'dockIcon', 'dockTitle', 'dockDetail', 'dockPercent',
      'dockStage', 'dockProgress',
      'toastStack',
      'onboarding', 'onboardingNick', 'onboardingServer', 'onboardingShaders',
      'onboardingAnimations', 'onboardingError', 'onboardingSubmit',
      'onboardingTitle', 'onboardingSubtitle', 'onboardingServerField',
      'onboardingOptions', 'onboardingSubmitLabel', 'onboardingSubmitIcon',
      'onboardingNote',
      'confirmModal', 'confirmTitle', 'confirmText', 'confirmAction',
      'statusbarProgress', 'statusbarDot', 'statusbarText', 'statusbarDetail',
    ];
    for (const id of ids) els[id] = document.getElementById(id);
  }

  /* ----------------------------------------------------------------------- */
  /*  Boot / init                                                           */
  /* ----------------------------------------------------------------------- */

  async function init() {
    cacheElements();
    bindEvents();
    setBoot(12, 'Загружаем интерфейс...');
    setupDate();
    setupRange(els.homeRam);
    setupRange(els.settingRam);
    setupRange(els.settingUpscaleScale);

    if (!api) {
      setBoot(100, 'Не удалось подключиться к лаунчеру');
      return;
    }

    api.onProgress(handleProgress);
    api.onGameState(handleGameState);
    api.onLog(appendLogEntry);
    api.onToast((payload) => showToast(payload.type || 'info', payload.title || 'Сообщение', payload.message || ''));
    api.onMaximized(updateMaximizeIcon);

    try {
      setBoot(28, 'Читаю настройки и проверяю Java...');
      const bootstrap = await api.bootstrap();
      state.bootstrap = bootstrap;
      state.config = { ...bootstrap.config };
      state.system = bootstrap.system || state.system;
      state.java = bootstrap.java || state.java;
      state.paths = bootstrap.paths || {};
      state.view = validView(bootstrap.ui?.view) || 'home';
      state.busy = Boolean(bootstrap.runtime?.busy);
      state.running = Boolean(bootstrap.runtime?.running);
      applyServerStore(bootstrap.servers);

      setBoot(68, 'Собираю профиль...');
      document.documentElement.dataset.theme = resolvedTheme();
      applyConfigToUI();
      syncSettingsForm();
      renderServerUI();
      renderServerList();
      renderPlayState();
      renderStatusBar();
      renderGraphicsUI();
      updateMaximizeIcon(await api.win.isMaximized());
      setBoot(88, 'Загружаю аватар...');
      updateAvatar();
      showView(state.view, { silent: true });
      els.saveChip?.classList.add('hidden');
      setBoot(100, 'Готово');
      hideBoot();

      if (!state.config.onboarded) {
        setTimeout(openOnboarding, 750);
      }

      window.__uralcraftShowView = (view) => showView(view);
      await pingServer({ initial: true });
      window.__uralcraftReady = true;

      clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => {
        if (document.hidden) return;
        pingServer({ silent: true });
        if (state.view === 'server') refreshAllServers({ silent: true });
      }, 45000);
    } catch (error) {
      console.error(error);
      setBoot(100, `Не удалось запустить лаунчер: ${error?.message || error}`);
      window.__uralcraftReady = true;
    }
  }

  function setBoot(percent, text) {
    if (els.bootProgress) els.bootProgress.style.width = `${percent}%`;
    if (els.bootText && text) els.bootText.textContent = text;
  }

  function hideBoot() {
    if (!els.boot) return;
    setTimeout(() => {
      els.boot.classList.add('hidden');
      setTimeout(() => els.boot?.remove(), 700);
    }, 380);
  }

  function setupDate() {
    if (!els.homeDate) return;
    const now = new Date();
    els.homeDate.textContent = `${now.getDate()} ${MONTHS[now.getMonth()]} · ${WEEKDAYS[now.getDay()]}`;
  }

  function validView(view) {
    return ['home', 'server', 'settings', 'logs'].includes(view) ? view : null;
  }

  /* ----------------------------------------------------------------------- */
  /*  Config / theme                                                        */
  /* ----------------------------------------------------------------------- */

  function resolvedTheme() {
    if (state.config.theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return state.config.theme === 'light' ? 'light' : 'dark';
  }

  function applyTheme() {
    const resolved = resolvedTheme();
    document.documentElement.dataset.theme = resolved;
    const use = els.railThemeIcon?.querySelector('use');
    if (use) use.setAttribute('href', resolved === 'dark' ? '#i-sun' : '#i-moon');
    if (els.railTheme) {
      els.railTheme.style.display = state.config.themeShortcut === false ? 'none' : '';
      els.railTheme.title = resolved === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
    }
    if (els.themeOptions) {
      for (const button of $$('.theme-option', els.themeOptions)) {
        button.classList.toggle('active', button.dataset.themeChoice === state.config.theme);
      }
    }
  }

  function queueConfig(patch, { delay = 240, immediate = false } = {}) {
    Object.assign(state.config, patch);
    Object.assign(state.pendingPatch, patch);
    applyConfigToUI();
    if (immediate) {
      persistConfig();
    } else {
      clearTimeout(state.persistTimer);
      state.persistTimer = setTimeout(persistConfig, delay);
    }
  }

  async function persistConfig() {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
    if (state.persistInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return persistConfig();
    }
    const patch = { ...state.pendingPatch };
    state.pendingPatch = {};
    if (!Object.keys(patch).length) return state.config;

    state.persistInFlight = true;
    try {
      const saved = await api.saveConfig(patch);
      state.config = { ...saved };
      applyConfigToUI();
      syncSettingsForm();
      flashSaved();
      if (patch.nick !== undefined) updateAvatar();
      if (patch.server !== undefined) {
        state.server = null;
        state.serverCheckedAt = 0;
        renderServerUI();
        setTimeout(() => pingServer({ silent: true }), 280);
      }
      return state.config;
    } catch (error) {
      showToast('error', 'Не удалось сохранить настройки', error?.message || String(error));
      return state.config;
    } finally {
      state.persistInFlight = false;
    }
  }

  function flashSaved() {
    if (!els.saveChip) return;
    els.saveChip.classList.remove('hidden');
    els.saveChip.lastChild.textContent = ' Сохранено';
    clearTimeout(state.saveChipTimer);
    state.saveChipTimer = setTimeout(() => els.saveChip.classList.add('hidden'), 2200);
  }

  function applyConfigToUI() {
    const config = state.config;
    const nick = config.nick || 'друг';

    if (els.homeNick) els.homeNick.textContent = nick;
    if (els.homeNick2) els.homeNick2.textContent = nick;

    const bindCheck = (element, value) => {
      if (element && element.checked !== Boolean(value)) element.checked = Boolean(value);
    };
    bindCheck(els.homeShaders, config.shaders);
    bindCheck(els.homeAnimations, config.animations);
    bindCheck(els.homeVoiceChat, config.voiceChat);
    bindCheck(els.homeFsr, config.upscale);
    bindCheck(els.settingShaders, config.shaders);
    bindCheck(els.settingAnimations, config.animations);
    bindCheck(els.settingVoiceChat, config.voiceChat);
    bindCheck(els.settingUpscale, config.upscale);
    bindCheck(els.settingAutoConnect, config.autoConnect);
    bindCheck(els.settingMinimize, config.minimizeOnLaunch);
    bindCheck(els.settingThemeShortcut, config.themeShortcut);

    if (els.settingShaders) els.settingShaders.disabled = false;
    if (els.homeFsrSwitch) els.homeFsrSwitch.classList.toggle('disabled', !config.shaders);
    const settingFsrSwitch = els.settingUpscale?.closest('.switch');
    if (settingFsrSwitch) settingFsrSwitch.classList.toggle('disabled', !config.shaders);
    if (els.upscaleSliderWrap) {
      els.upscaleSliderWrap.classList.toggle('disabled', !config.upscale || !config.shaders);
    }

    if (els.homeRam) {
      const total = Math.max(2, Number(state.system.totalRamGb) || 16);
      const max = Math.max(2, Math.min(32, total - 1));
      const value = Math.max(2, Math.min(max, Number(config.ram) || 8));
      els.homeRam.max = String(max);
      els.settingRam.max = String(max);
      if (els.homeRam.value !== String(value)) els.homeRam.value = String(value);
      if (els.settingRam.value !== String(value)) els.settingRam.value = String(value);
      setRangeFill(els.homeRam, value);
      setRangeFill(els.settingRam, value);
      if (els.homeRamValue) els.homeRamValue.textContent = String(value);
      if (els.settingsRamValue) els.settingsRamValue.textContent = String(value);
      if (els.homeRamMax) els.homeRamMax.textContent = `${max} ГБ`;
      if (els.settingsRamMax) els.settingsRamMax.textContent = `${max} ГБ`;
      if (els.homeRamHint) els.homeRamHint.textContent = `рекомендуем ${state.system.recommendedRamGb || 8} ГБ`;
      if (els.settingsRamHint) els.settingsRamHint.textContent = `рекомендуем ${state.system.recommendedRamGb || 8} ГБ`;
      if (els.ramSystem) els.ramSystem.textContent = `${total} ГБ всего`;
      if (els.settingsRamChip) els.settingsRamChip.textContent = `${total} ГБ`;
    }

    if (els.homeFsrValue) els.homeFsrValue.textContent = String(config.upscaleScale || 75);
    if (els.settingsFsrValue) els.settingsFsrValue.textContent = String(config.upscaleScale || 75);
    if (els.settingUpscaleScale) {
      els.settingUpscaleScale.value = String(config.upscaleScale || 75);
      setRangeFill(els.settingUpscaleScale, Number(config.upscaleScale) || 75);
    }

    renderGraphicsUI();
    applyTheme();
  }

  function syncSettingsForm() {
    const config = state.config;
    if (els.settingNick && document.activeElement !== els.settingNick) els.settingNick.value = config.nick || '';
    if (els.settingServer && document.activeElement !== els.settingServer) els.settingServer.value = config.server || '';
    if (els.settingAutoConnect) els.settingAutoConnect.checked = Boolean(config.autoConnect);
    if (els.settingMinimize) els.settingMinimize.checked = Boolean(config.minimizeOnLaunch);
    if (els.settingShaders) els.settingShaders.checked = Boolean(config.shaders);
    if (els.settingAnimations) els.settingAnimations.checked = Boolean(config.animations);
    if (els.settingVoiceChat) els.settingVoiceChat.checked = Boolean(config.voiceChat);
    if (els.settingUpscale) els.settingUpscale.checked = Boolean(config.upscale);
    if (els.settingThemeShortcut) els.settingThemeShortcut.checked = config.themeShortcut !== false;
    if (els.settingRam) {
      els.settingRam.value = String(config.ram || 8);
      setRangeFill(els.settingRam, Number(config.ram) || 8);
    }
    if (els.settingUpscaleScale) {
      els.settingUpscaleScale.value = String(config.upscaleScale || 75);
      setRangeFill(els.settingUpscaleScale, Number(config.upscaleScale) || 75);
    }
    if (els.settingsFsrValue) els.settingsFsrValue.textContent = String(config.upscaleScale || 75);
    if (els.javaStatusChip) {
      els.javaStatusChip.textContent = state.java?.found ? 'JAVA 25' : 'JAVA 25 · АВТО';
      els.javaStatusChip.classList.toggle('accent', !state.java?.found);
    }
    applyTheme();
    for (const button of $$('.theme-option', els.themeOptions)) {
      button.classList.toggle('active', button.dataset.themeChoice === config.theme);
    }
  }

  /* ----------------------------------------------------------------------- */
  /*  UI rendering                                                          */
  /* ----------------------------------------------------------------------- */

  function renderGraphicsUI() {
    const shaders = Boolean(state.config.shaders);
    const animations = Boolean(state.config.animations);
    if (els.graphicsMode) els.graphicsMode.textContent = shaders ? 'SHADERS' : 'VANILLA';
    if (els.settingsGraphicsMode) els.settingsGraphicsMode.textContent = shaders ? 'SHADERS' : 'VANILLA';
    if (els.heroGraphics) els.heroGraphics.textContent = shaders ? 'Sodium + Iris' : 'Minecraft 26.3';
    if (els.heroGraphicsSub) {
      els.heroGraphicsSub.textContent = shaders
        ? (animations ? 'шейдеры и живые анимации' : 'шейдеры включены')
        : (animations ? 'чистый клиент + анимации' : 'чистый клиент');
    }
  }

  function updateMaximizeIcon(maximized) {
    const use = els.maximizeIcon?.querySelector('use');
    if (use) use.setAttribute('href', maximized ? '#i-restore' : '#i-maximize');
  }

  function lastPlayedServer() {
    return state.servers.find((server) => server.id === state.lastPlayedId)
      || state.servers.find((server) => server.isDefault)
      || state.servers[0]
      || null;
  }

  function serverById(id) {
    return state.servers.find((server) => server.id === id) || null;
  }

  function applyServerStore(store) {
    if (!store || !Array.isArray(store.servers)) return;
    const previous = lastPlayedServer();
    const previousAddress = previous?.address || null;
    state.servers = store.servers.map((server) => ({ ...server }));
    state.lastPlayedId = store.lastPlayedId || state.servers[0]?.id || null;
    const last = lastPlayedServer();
    if (last) state.config.server = last.address;
    if (last && last.address !== previousAddress) {
      state.server = null;
      state.serverCheckedAt = 0;
    }
    renderServerUI();
    renderServerList();
  }

  function serverIconSrc(server) {
    if (server?.icon) return server.icon;
    if (server?.isDefault) return 'assets/server-icon.png';
    return fallbackServerIcon(server);
  }

  function fallbackServerIcon(server) {
    const key = String(server?.address || 'server');
    if (serverIconCache.has(key)) return serverIconCache.get(key);
    const hash = hashText(key);
    const palettes = [
      ['#ff9c3b', '#7a2e0b'],
      ['#5ee3a1', '#0c3d28'],
      ['#7ba8ff', '#102752'],
      ['#b794ff', '#2c1554'],
      ['#ffd15c', '#4c3507'],
    ];
    const [from, to] = palettes[hash % palettes.length];
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 128, 128);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(104, 20, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 58px Manrope, sans-serif';
    const initial = String(server?.name || 'S').trim().charAt(0).toUpperCase() || 'S';
    ctx.fillText(initial, 64, 69);
    const result = canvas.toDataURL('image/png');
    serverIconCache.set(key, result);
    return result;
  }

  function iconNode(name, className = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  async function runLimited(items, limit, worker) {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await worker(item);
      }
    });
    await Promise.all(workers);
  }

  function serverCardPing(server) {
    return state.serverPings[server.id] || { loading: false, result: null };
  }

  function createServerCard(server) {
    const card = document.createElement('article');
    const isLast = server.id === state.lastPlayedId;
    card.className = `panel server-list-card${isLast ? ' is-last' : ''}`;
    card.dataset.serverId = server.id;
    card.innerHTML = `
      <div class="server-card-head">
        <div class="server-card-icon"><img alt=""></div>
        <div class="server-card-title"><h3></h3><span class="server-card-address"></span></div>
        <div class="server-card-badges"></div>
      </div>
      <div class="server-card-status">
        <span class="status-pill checking"></span>
        <span class="meta meta-ping"><svg class="icon"><use href="#i-signal"></use></svg><span></span></span>
        <span class="meta meta-players"><svg class="icon"><use href="#i-users"></use></svg><span></span></span>
      </div>
      <p class="server-card-motd"></p>
      <div class="server-card-players"></div>
      <div class="server-card-footer">
        <button type="button" class="btn-primary" data-action="play-server">
          <svg class="icon fill"><use href="#i-play"></use></svg>
          Играть
        </button>
        <div class="server-card-actions"></div>
      </div>
    `;

    const icon = $('.server-card-icon img', card);
    icon.src = serverIconSrc(server);
    icon.onerror = () => { icon.onerror = null; icon.src = fallbackServerIcon(server); };
    $('.server-card-title h3', card).textContent = server.name;
    $('.server-card-address', card).textContent = server.address;

    const badges = $('.server-card-badges', card);
    if (isLast) {
      const badge = document.createElement('span');
      badge.className = 'server-badge last';
      badge.textContent = 'ПОСЛЕДНИЙ';
      badges.append(badge);
    }
    if (server.isDefault) {
      const badge = document.createElement('span');
      badge.className = 'server-badge home';
      badge.textContent = 'ДОМ';
      badges.append(badge);
    }

    const ping = serverCardPing(server);
    const result = ping.result;
    const players = result?.players;
    const pill = $('.status-pill', card);
    let kind = 'unknown';
    let label = 'не проверен';
    let pingText = '—';
    let playersText = '—';
    let motd = 'Нажми «Обновить», чтобы проверить сервер.';

    if (ping.loading && !result) {
      kind = 'checking';
      label = 'проверка';
      motd = 'Проверяем сервер...';
    } else if (result?.online) {
      kind = 'online';
      label = 'онлайн';
      pingText = Number.isFinite(result.latency) ? `${result.latency} мс` : '—';
      playersText = players ? `${players.online ?? 0}/${players.max ?? '—'}` : '—';
      motd = result.motd || 'Сервер онлайн';
    } else if (result) {
      kind = 'offline';
      label = 'offline';
      motd = result.error || 'Сервер не отвечает';
    }
    setPill(pill, kind, label);
    $('.meta-ping span', card).textContent = pingText;
    $('.meta-players span', card).textContent = playersText;
    $('.server-card-motd', card).textContent = motd;

    const playersRow = $('.server-card-players', card);
    if (result?.online && Array.isArray(players?.sample) && players.sample.length) {
      for (const player of players.sample.slice(0, 4)) {
        const img = document.createElement('img');
        img.src = fallbackAvatarDataUrl(player.name);
        img.alt = '';
        img.title = player.name;
        playersRow.append(img);
      }
      const note = document.createElement('span');
      note.textContent = players.sample.length > 4 ? `+${players.sample.length - 4} ещё` : `${players.online ?? players.sample.length} онлайн`;
      playersRow.append(note);
    } else if (result?.online) {
      const note = document.createElement('span');
      note.textContent = 'Сейчас никого нет';
      playersRow.append(note);
    }

    const footer = $('.server-card-footer', card);
    const playButton = $('[data-action="play-server"]', footer);
    playButton.dataset.serverId = server.id;
    const actions = $('.server-card-actions', card);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'icon-btn';
    copy.dataset.action = 'copy-server';
    copy.dataset.serverId = server.id;
    copy.title = 'Скопировать адрес';
    copy.append(iconNode('copy'));
    actions.append(copy);

    if (!server.isDefault) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'icon-btn';
      edit.dataset.action = 'edit-server';
      edit.dataset.serverId = server.id;
      edit.title = 'Изменить сервер';
      edit.append(iconNode('pencil'));
      actions.append(edit);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn danger';
      remove.dataset.action = 'delete-server';
      remove.dataset.serverId = server.id;
      remove.title = 'Удалить сервер';
      remove.append(iconNode('trash'));
      actions.append(remove);
    }

    return card;
  }

  function renderServerList() {
    if (!els.serverList) return;
    els.serverList.textContent = '';
    for (const server of state.servers) {
      els.serverList.append(createServerCard(server));
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'server-add-tile';
    add.dataset.action = 'add-server';
    add.innerHTML = `
      <span class="add-tile-icon"><svg class="icon"><use href="#i-plus"></use></svg></span>
      <b>Добавить сервер</b>
      <span>Свой адрес и название</span>
    `;
    els.serverList.append(add);

    if (els.serverCount) {
      const count = state.servers.length;
      els.serverCount.textContent = `${count} ${count === 1 ? 'сервер' : count < 5 ? 'сервера' : 'серверов'}`;
    }
  }

  async function refreshAllServers({ force = false, silent = false } = {}) {
    if (state.serverListPinging || !state.servers.length) return;
    state.serverListPinging = true;
    for (const server of state.servers) {
      state.serverPings[server.id] = {
        loading: true,
        result: state.serverPings[server.id]?.result || null,
      };
    }
    if (state.view === 'server') renderServerList();

    await runLimited(state.servers, 3, async (server) => {
      try {
        const result = await api.ping(server.address, { force, serverId: server.id });
        state.serverPings[server.id] = { loading: false, result };
        if (result?.online && result.favicon) server.icon = result.favicon;
        if (server.id === state.lastPlayedId) {
          state.server = result;
          state.serverCheckedAt = Date.now();
          state.config.server = server.address;
          renderServerUI();
          renderStatusBar();
        }
      } catch (error) {
        state.serverPings[server.id] = {
          loading: false,
          result: { online: false, error: error?.message || 'Нет ответа' },
        };
      }
      if (state.view === 'server') renderServerList();
    });
    state.serverListPinging = false;
    if (state.view === 'server') renderServerList();
    if (!silent) renderServerUI();
  }

  function showView(view, { silent = false } = {}) {
    const next = validView(view) || 'home';
    state.view = next;
    for (const button of $$('.rail-btn')) {
      button.classList.toggle('active', button.dataset.nav === next);
    }
    for (const section of $$('.view')) {
      section.classList.toggle('active', section.dataset.view === next);
    }
    if (next === 'settings') syncSettingsForm();
    if (next === 'logs') {
      loadLogs();
      renderLogs();
    }
    if (next === 'server') {
      renderServerUI();
      renderServerList();
      refreshAllServers({ silent: true });
      if (!state.server || Date.now() - state.serverCheckedAt > 15000) pingServer({ silent: true });
    }
    if (!silent) {
      els.mainScroll.scrollTop = 0;
      api.uiState({ view: next }).catch(() => {});
    } else {
      api.uiState({ view: next }).catch(() => {});
    }
  }

  function setRangeFill(input, value) {
    if (!input) return;
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const pct = max === min ? 0 : ((Number(value) - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
  }

  function setupRange(input) {
    if (!input) return;
    setRangeFill(input, input.value);
  }

  function formatTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleTimeString('ru-RU', { hour12: false });
    } catch {
      return '—';
    }
  }

  /* ----------------------------------------------------------------------- */
  /*  Server ping / status                                                  */
  /* ----------------------------------------------------------------------- */

  async function pingServer({ manual = false, initial = false, silent = false, force = false } = {}) {
    const last = lastPlayedServer();
    const requestedAddress = last?.address || state.config.server;
    if (!requestedAddress || state.serverLoading) return;
    state.config.server = requestedAddress;
    state.serverLoading = true;
    state.silentPing = silent || (!manual && !initial && Boolean(state.server));
    if (!silent && (manual || initial || !state.server)) renderServerUI();
    try {
      const result = await api.ping(requestedAddress, {
        force: manual || initial || force,
        serverId: last?.id || null,
      });
      if (state.config.server !== requestedAddress) return;
      if (last && result?.favicon) {
        last.icon = result.favicon;
        renderServerList();
      }
      state.server = result || { online: false, error: 'Нет ответа' };
      state.serverCheckedAt = Date.now();
      if (manual) {
        if (state.server.online) {
          const players = state.server.players;
          showToast('success', 'Сервер онлайн', players ? `${players.online}/${players.max} игроков · ${state.server.latency} мс` : 'Можно заходить');
        } else {
          showToast('info', 'Сервер сейчас спит', state.server.error || 'Проверь адрес и попробуй ещё раз');
        }
      }
    } catch (error) {
      if (state.config.server === requestedAddress) {
        state.server = { online: false, error: error?.message || 'Нет ответа' };
        state.serverCheckedAt = Date.now();
        if (manual) showToast('error', 'Не удалось проверить сервер', error?.message || String(error));
      }
    } finally {
      state.serverLoading = false;
      state.silentPing = false;
      renderServerUI();
      renderStatusBar();
    }
  }

  function setPill(element, kind, label) {
    if (!element) return;
    element.classList.remove('online', 'offline', 'checking', 'unknown');
    element.classList.add(kind);
    element.textContent = '';
    const dot = document.createElement('span');
    element.append(dot, document.createTextNode(label));
  }

  function setDot(element, kind) {
    if (!element) return;
    element.classList.remove('online', 'offline', 'checking', 'busy');
    if (kind) element.classList.add(kind);
  }

  function renderServerUI() {
    const last = lastPlayedServer();
    if (last) {
      state.config.server = last.address;
      if (state.lastPlayedId !== last.id) state.lastPlayedId = last.id;
    }
    const address = last?.address || state.config.server || '';
    const checking = !state.server || (state.serverLoading && !state.silentPing);
    const server = state.server;
    const online = Boolean(server?.online);
    const players = server?.players || null;
    const onlineCount = players?.online ?? 0;
    const maxPlayers = players?.max ?? 20;
    const ping = online && Number.isFinite(server?.latency) ? `${server.latency} мс` : '—';
    const statusKind = checking ? 'checking' : online ? 'online' : (server ? 'offline' : 'checking');
    const statusLabel = checking ? 'проверка' : online ? 'онлайн' : (server ? 'offline' : 'проверка');
    const stateText = checking
      ? 'Проверяем сервер...'
      : online
        ? `Сервер онлайн · ${onlineCount}/${maxPlayers}`
        : 'Сервер спит';

    setDot(els.headDot, statusKind);
    setDot(els.heroDot, statusKind);
    setDot(els.railIndicator, online ? 'online' : null);
    if (els.headServerStatus) els.headServerStatus.textContent = stateText;
    if (els.heroServerState) els.heroServerState.textContent = stateText;
    if (els.heroServerIp) els.heroServerIp.textContent = address || '—';
    if (els.miniServerIp) els.miniServerIp.textContent = address || '—';
    if (els.serverAddress) els.serverAddress.textContent = address || '—';
    if (els.miniServerName) els.miniServerName.textContent = last?.name || 'Уральский мир';
    if (els.settingsServerName) els.settingsServerName.textContent = last?.name || 'Уральский мир';
    if (els.settingsServerAddress) els.settingsServerAddress.textContent = address || '—';
    const lastIcon = last ? serverIconSrc(last) : 'assets/server-icon.png';
    if (els.miniServerIcon) {
      els.miniServerIcon.src = lastIcon;
      els.miniServerIcon.onerror = () => {
        els.miniServerIcon.onerror = null;
        els.miniServerIcon.src = last ? fallbackServerIcon(last) : 'assets/server-icon.png';
      };
    }
    if (els.settingsServerIcon) {
      els.settingsServerIcon.src = lastIcon;
      els.settingsServerIcon.onerror = () => {
        els.settingsServerIcon.onerror = null;
        els.settingsServerIcon.src = last ? fallbackServerIcon(last) : 'assets/server-icon.png';
      };
    }
    setPill(els.miniServerPill, statusKind, statusLabel);
    setPill(els.serverPill, statusKind, statusLabel);
    setPill(els.settingsServerPill, statusKind, statusLabel);

    if (els.miniPlayers) els.miniPlayers.textContent = online ? String(onlineCount) : '—';
    if (els.miniPing) els.miniPing.textContent = online ? ping : '—';
    if (els.miniSlots) els.miniSlots.textContent = online ? String(maxPlayers) : '20';
    if (els.worldSlots) els.worldSlots.textContent = online ? String(maxPlayers) : '20';
    if (els.serverPing) els.serverPing.textContent = online ? ping : '— мс';
    if (els.serverPlayers) els.serverPlayers.textContent = online ? `${onlineCount} / ${maxPlayers}` : '— / 20';
    if (els.playersChip) els.playersChip.textContent = online ? `${onlineCount}/${maxPlayers}` : (checking ? '—' : 'OFFLINE');

    if (els.miniMotd) {
      els.miniMotd.textContent = online
        ? (server.motd || `${last?.name || 'Сервер'} · онлайн`)
        : (checking ? 'Проверяем сообщение сервера...' : 'Друзья, приключения и уютный мир');
    }

    renderMotd(online ? server?.motdSegments : null, checking, online);

    const pulse = $('.server-icon-pulse');
    if (pulse) pulse.style.background = online ? 'var(--green)' : 'var(--muted-2)';

    renderPlayers(online, checking, players);
    renderStatusBar();
  }

  function renderMotd(segments, checking, online) {
    if (!els.serverMotd) return;
    els.serverMotd.textContent = '';
    if (checking) {
      const placeholder = document.createElement('span');
      placeholder.className = 'motd-placeholder';
      placeholder.textContent = 'Проверяем сообщение сервера...';
      els.serverMotd.append(placeholder);
      return;
    }
    if (!online) {
      const placeholder = document.createElement('span');
      placeholder.className = 'motd-placeholder';
      placeholder.textContent = 'Сервер сейчас спит. Когда все соберутся — запустите его и нажмите «Обновить».';
      els.serverMotd.append(placeholder);
      return;
    }
    if (!Array.isArray(segments) || !segments.length) {
      const line = document.createElement('div');
      line.className = 'motd-line';
      line.textContent = 'Уральский сервер · CAIIIEHbKA & Friends';
      els.serverMotd.append(line);
      return;
    }

    let line = document.createElement('div');
    line.className = 'motd-line';
    let hasContent = false;
    for (const segment of segments) {
      const pieces = String(segment.text || '').split('\n');
      pieces.forEach((piece, index) => {
        if (piece) {
          const span = document.createElement('span');
          span.textContent = piece;
          if (segment.color) span.style.color = segment.color;
          if (segment.bold) span.style.fontWeight = '800';
          if (segment.italic) span.style.fontStyle = 'italic';
          if (segment.underlined) span.style.textDecoration = 'underline';
          if (segment.strikethrough) span.style.textDecoration = 'line-through';
          line.append(span);
          hasContent = true;
        }
        if (index < pieces.length - 1) {
          els.serverMotd.append(line);
          line = document.createElement('div');
          line.className = 'motd-line';
        }
      });
    }
    if (hasContent || line.childNodes.length) els.serverMotd.append(line);
  }

  function renderPlayers(online, checking, players) {
    if (!els.playersContent) return;
    els.playersContent.textContent = '';
    if (checking) {
      els.playersContent.append(emptyState('users', 'Проверяем, кто онлайн', 'Как только сервер ответит, здесь появятся игроки.'));
      return;
    }
    if (!online) {
      els.playersContent.append(emptyState('moon', 'Сервер спит', 'Разбуди его, когда все в сборе — и возвращайся.'));
      return;
    }
    const sample = Array.isArray(players?.sample) ? players.sample.slice(0, 20) : [];
    if (!sample.length) {
      els.playersContent.append(emptyState('users', 'Сейчас никого нет', 'Самое время зайти первым и позвать друзей.'));
    } else {
      const list = document.createElement('div');
      list.className = 'players-list';
      for (const player of sample) {
        const name = String(player?.name || 'Игрок').slice(0, 32);
        const chip = document.createElement('span');
        chip.className = 'player-chip';
        const img = document.createElement('img');
        img.src = fallbackAvatarDataUrl(name);
        img.alt = '';
        const dot = document.createElement('span');
        dot.className = 'player-dot';
        chip.append(img, dot, document.createTextNode(name));
        list.append(chip);
      }
      const note = document.createElement('div');
      note.className = 'players-note';
      note.textContent = `Онлайн ${players?.online ?? sample.length} из ${players?.max ?? 20}. Заходи — тебя уже ждут.`;
      els.playersContent.append(list, note);
    }
  }

  function emptyState(icon, title, text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'empty-icon';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${icon}`);
    svg.append(use);
    iconWrap.append(svg);
    const heading = document.createElement('b');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    wrapper.append(iconWrap, heading, paragraph);
    return wrapper;
  }

  /* ----------------------------------------------------------------------- */
  /*  Play / progress                                                       */
  /* ----------------------------------------------------------------------- */

  function handleProgress(payload) {
    if (!payload) return;
    state.progress = payload;
    state.busy = payload.status === 'preparing' || payload.status === 'verifying';
    if (state.busy) {
      state.running = false;
    }
    renderPlayState();
    renderDock();
    renderStatusBar();
    if (payload.phase === 'done') {
      clearTimeout(state.dockHideTimer);
      state.dockHideTimer = setTimeout(hideDock, 950);
    }
    if (payload.error) {
      clearTimeout(state.dockHideTimer);
      state.dockHideTimer = setTimeout(hideDock, 1800);
    }
  }

  function handleGameState(payload) {
    if (!payload) return;
    state.gameState = payload;
    if (payload.status === 'running') {
      state.busy = false;
      state.running = true;
      state.progress = null;
      hideDock();
      if (payload.serverId) {
        const selected = serverById(payload.serverId);
        if (selected) {
          if (state.lastPlayedId !== selected.id) {
            state.lastPlayedId = selected.id;
            state.server = null;
            state.serverCheckedAt = 0;
          }
          state.config.server = selected.address;
          renderServerUI();
          renderServerList();
          setTimeout(() => pingServer({ force: true }), 350);
        }
      }
      showToast('success', 'Minecraft запущен', 'Приятной игры. Сервер уже ждёт.');
    } else if (payload.status === 'preparing' || payload.status === 'verifying') {
      state.busy = true;
      state.running = false;
    } else if (payload.status === 'stopped') {
      state.busy = false;
      state.running = false;
      state.progress = null;
      hideDock();
    } else if (payload.status === 'crashed') {
      state.busy = false;
      state.running = false;
      state.progress = null;
      hideDock();
      showToast('error', 'Minecraft завершился с ошибкой', payload.tail ? payload.tail.split('\n').slice(-2).join(' ') : 'Открой вкладку «Логи», чтобы увидеть подробности.');
    } else if (payload.status === 'verified') {
      state.busy = false;
      state.progress = null;
      hideDock();
      showToast('success', 'Проверка завершена', 'Все файлы на месте — можно играть.');
    } else if (payload.status === 'cancelled') {
      state.busy = false;
      state.progress = null;
      hideDock();
      showToast('info', 'Отменено', 'Подготовка остановлена.');
    } else if (payload.status === 'error') {
      state.busy = false;
      state.progress = state.progress
        ? { ...state.progress, status: 'error', error: true, detail: payload.message || state.progress.detail }
        : { mode: 'launch', status: 'error', phase: 'error', phaseLabel: 'Ошибка', detail: payload.message || 'Ошибка запуска', percent: 0, progress: 0, error: true };
      hideDock();
    }
    renderPlayState();
    renderDock();
    renderStatusBar();
  }

  function renderPlayState() {
    if (!els.playButton) return;
    const running = state.running || state.gameState?.status === 'running';
    const busy = state.busy || state.gameState?.status === 'preparing' || state.gameState?.status === 'verifying';
    const error = Boolean(state.progress?.error);
    els.playButton.classList.toggle('is-loading', busy);
    els.playButton.classList.toggle('is-running', running && !busy);
    els.playButton.classList.toggle('is-error', error && !busy && !running);

    let icon = 'play';
    let label = 'Играть';
    let fill = true;
    if (busy) {
      icon = 'refresh';
      label = state.progress?.mode === 'verify' ? 'Проверка...' : 'Загрузка...';
      fill = false;
    } else if (running) {
      icon = 'check';
      label = 'В игре';
      fill = false;
    } else if (error) {
      icon = 'refresh';
      label = 'Повторить';
      fill = false;
    }
    els.playLabel.textContent = label;
    els.playIcon.innerHTML = `<svg class="icon ${fill ? 'fill' : ''}"><use href="#i-${icon}"></use></svg>`;

    if (els.serverPlayButton) {
      els.serverPlayButton.disabled = busy || running;
      els.serverPlayButton.classList.toggle('is-disabled', busy || running);
    }
  }

  function renderDock() {
    const payload = state.progress;
    if (!els.launchDock) return;
    const visible = Boolean(payload && (payload.status === 'preparing' || payload.status === 'verifying'));
    els.launchDock.classList.toggle('show', visible);
    if (!visible) return;
    const verify = payload.mode === 'verify';
    els.dockTitle.textContent = verify ? 'Проверка файлов' : 'Подготовка Minecraft';
    els.dockDetail.textContent = payload.detail || 'Проверяю файлы...';
    els.dockPercent.textContent = `${payload.percent || 0}%`;
    els.dockStage.textContent = (payload.phaseLabel || 'подготовка').toUpperCase();
    els.dockProgress.style.width = `${payload.percent || 0}%`;
    els.dockIcon.classList.toggle('is-loading', !payload.error);
    els.dockIcon.classList.remove('is-error');
    els.launchDock.classList.toggle('is-error', Boolean(payload.error));
    const use = els.dockIcon.querySelector('use');
    if (use) use.setAttribute('href', verify ? '#i-shield' : '#i-download');
  }

  function hideDock() {
    if (els.launchDock) els.launchDock.classList.remove('show');
  }

  function renderStatusBar() {
    if (!els.statusbarText) return;
    const payload = state.progress;
    const busy = state.busy || state.gameState?.status === 'preparing' || state.gameState?.status === 'verifying';
    const running = state.running || state.gameState?.status === 'running';
    const error = Boolean(payload?.error);
    const serverOnline = state.server?.online;
    const serverExists = Boolean(state.server);

    let dot = '';
    let text = 'Готов к запуску';
    let detail = state.config.server || '';
    let percent = 0;

    if (busy) {
      dot = 'busy';
      text = payload?.mode === 'verify' ? 'Проверка файлов...' : 'Подготовка Minecraft...';
      detail = payload ? `${payload.phaseLabel || 'Подготовка'} · ${payload.detail || ''}` : 'Пожалуйста, подожди';
      percent = payload?.percent || 0;
    } else if (running) {
      dot = 'online';
      text = 'Minecraft запущен';
      detail = state.gameState?.pid ? `PID ${state.gameState.pid}` : 'Игра идёт';
    } else if (error) {
      dot = 'offline';
      text = 'Ошибка запуска';
      detail = payload.detail || 'Открой логи, чтобы узнать подробности';
    } else if (state.serverLoading) {
      dot = 'busy';
      text = 'Проверяем сервер...';
      detail = state.config.server || '';
    } else if (serverOnline) {
      dot = 'online';
      text = 'Сервер онлайн';
      detail = `${state.config.server} · ${state.server.players?.online ?? 0}/${state.server.players?.max ?? 20} игроков`;
    } else if (serverExists) {
      dot = '';
      text = 'Сервер спит';
      detail = `${state.config.server} · можно запускать игру`;
    }

    if (els.titlebarStatus) els.titlebarStatus.textContent = busy ? `${payload?.phaseLabel || 'подготовка'} · ${percent}%` : running ? 'Minecraft запущен' : serverOnline ? 'Сервер онлайн' : serverExists ? 'Сервер спит' : 'Готов к запуску';
    setDot(els.titleDot, dot);
    setDot(els.statusbarDot, dot);
    els.statusbarText.textContent = text;
    if (els.statusbarDetail) els.statusbarDetail.textContent = detail;
    if (els.statusbarProgress) els.statusbarProgress.style.width = `${percent}%`;
  }

  async function startGame(serverId = null) {
    if (state.busy) {
      showToast('info', 'Уже готовимся', 'Подожди немного или отмени загрузку.');
      return;
    }
    if (state.running) {
      showToast('info', 'Minecraft уже запущен', 'Играй! Лаунчер можно свернуть.');
      return;
    }
    const selected = serverId ? serverById(serverId) : lastPlayedServer();
    if (!selected) {
      showToast('error', 'Нет сервера', 'Добавь сервер в списке и попробуй снова.');
      showView('server');
      return;
    }
    const nick = sanitizeNick(els.settingNick?.value || state.config.nick);
    if (nick.length < 2) {
      showToast('error', 'Нужен ник', 'Введи ник от 2 до 32 символов в настройках.');
      showView('settings');
      setTimeout(() => els.settingNick?.focus(), 250);
      return;
    }
    if (!normalizeServerInput(selected.address)) {
      showToast('error', 'Неверный адрес сервера', 'Открой список серверов и исправь адрес.');
      showView('server');
      return;
    }

    state.config.nick = nick;
    state.config.server = selected.address;
    state.pendingPatch.nick = nick;
    await persistConfig();
    renderPlayState();
    renderStatusBar();
    try {
      const result = await api.launch(selected.id);
      if (result?.ok) {
        state.lastPlayedId = selected.id;
        state.config.server = selected.address;
        const stored = serverById(selected.id);
        if (stored) stored.lastPlayedAt = Date.now();
        renderServerUI();
        renderServerList();
        pingServer({ force: true, silent: true });
      } else if (result && result.ok === false && !result.cancelled) {
        showToast('error', 'Не удалось запустить', result.error || 'Открой логи, чтобы увидеть подробности.');
      }
    } catch (error) {
      showToast('error', 'Не удалось запустить', error?.message || String(error));
    }
  }

  async function cancelLaunch() {
    if (!state.busy) return;
    const result = await api.cancel();
    if (result?.ok) showToast('info', 'Отмена', 'Останавливаю подготовку...');
  }

  async function verifyFiles() {
    if (state.busy) {
      showToast('info', 'Подожди', 'Подготовка уже идёт.');
      return;
    }
    if (state.running) {
      showToast('info', 'Minecraft запущен', 'Проверку файлов можно сделать после выхода из игры.');
      return;
    }
    showView('settings');
    state.busy = true;
    state.progress = {
      mode: 'verify',
      status: 'verifying',
      phase: 'version',
      phaseLabel: 'Проверка файлов',
      detail: 'Начинаю проверку...',
      percent: 0,
      progress: 0,
    };
    renderPlayState();
    renderDock();
    renderStatusBar();
    try {
      const result = await api.verify();
      if (result?.ok === false && !result.cancelled) {
        showToast('error', 'Проверка не удалась', result.error || 'Открой логи для подробностей.');
      }
    } catch (error) {
      showToast('error', 'Проверка не удалась', error?.message || String(error));
    } finally {
      if (state.busy) {
        state.busy = false;
        state.progress = null;
        hideDock();
        renderPlayState();
        renderStatusBar();
      }
    }
  }

  /* ----------------------------------------------------------------------- */
  /*  Avatar                                                                */
  /* ----------------------------------------------------------------------- */

  const avatarCache = new Map();

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || 'Steve');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function pick(list, hash, shift) {
    return list[(hash >>> shift) % list.length];
  }

  function fallbackAvatarDataUrl(name) {
    const key = String(name || 'Steve').toLowerCase();
    if (avatarCache.has(key)) return avatarCache.get(key);
    const hash = hashText(key);
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const skins = ['#f2c48f', '#e4ae73', '#c98b58', '#a96c3e', '#8b5632'];
    const hairs = ['#2a1d17', '#4c2f1d', '#7a4625', '#d39b48', '#1d2433', '#63311e'];
    const shirts = ['#ff8a2b', '#44c28b', '#5e8ee8', '#a06be8', '#d95a5a'];
    const backgrounds = ['#171a22', '#1b1d26', '#211b20', '#1a2222', '#201d2a'];

    const skin = pick(skins, hash, 2);
    const hair = pick(hairs, hash, 5);
    const shirt = pick(shirts, hash, 9);
    const bg = pick(backgrounds, hash, 13);

    const gradient = ctx.createLinearGradient(0, 0, 128, 128);
    gradient.addColorStop(0, bg);
    gradient.addColorStop(1, '#0d0f14');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);

    ctx.globalAlpha = 0.22;
    ctx.fillStyle = shirt;
    ctx.beginPath();
    ctx.arc(64, 64, 55, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    const p = 8;
    const px = (x, y, w, h, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(x * p, y * p, w * p, h * p);
    };

    // Head and hair silhouette.
    px(3, 2, 10, 1, hair);
    px(2, 3, 1, 8, hair);
    px(13, 3, 1, 8, hair);
    px(3, 3, 10, 2, hair);
    px(3, 5, 10, 8, skin);
    px(3, 11, 10, 2, hair);

    // Hair fringe.
    px(3, 5, 3, 1, hair);
    px(8, 5, 5, 1, hair);
    px(11, 6, 2, 2, hair);

    // Eyes.
    px(5, 7, 2, 2, '#f8f8f8');
    px(9, 7, 2, 2, '#f8f8f8');
    px(6, 7, 1, 2, '#23201e');
    px(9, 7, 1, 2, '#23201e');

    // Nose and mouth.
    px(7, 9, 2, 1, 'rgba(90,45,30,0.35)');
    px(6, 11, 4, 1, '#9e5546');
    px(7, 12, 2, 1, '#743c31');

    // A little shoulder accent.
    px(3, 13, 10, 3, shirt);
    px(3, 13, 1, 3, 'rgba(0,0,0,0.16)');
    px(12, 13, 1, 3, 'rgba(0,0,0,0.16)');

    const result = canvas.toDataURL('image/png');
    avatarCache.set(key, result);
    return result;
  }

  async function updateAvatar() {
    const nick = state.config.nick || 'Steve';
    state.avatarFallback = fallbackAvatarDataUrl(nick);
    for (const image of $$('[data-avatar]')) {
      image.src = state.avatarFallback;
      image.onerror = () => {
        image.onerror = null;
        image.src = state.avatarFallback;
      };
    }
    try {
      const remote = await api.getAvatar(nick);
      if (remote && remote.startsWith('data:image/')) {
        state.avatarRemote = remote;
        for (const image of $$('[data-avatar]')) image.src = remote;
      }
    } catch {
      // fallback stays
    }
  }

  /* ----------------------------------------------------------------------- */
  /*  Logs                                                                  */
  /* ----------------------------------------------------------------------- */

  function parseLauncherLine(line) {
    const match = String(line).match(/^\[(.*?)\]\s+\[(\w+)\]\s+([\s\S]*)$/);
    if (!match) return { time: '—', level: 'info', message: String(line), source: 'launcher', timestamp: 0 };
    const rawTime = match[1];
    const time = rawTime.split(',').pop().trim();
    let timestamp = 0;
    try {
      const dateMatch = rawTime.match(/(\d{1,2})\.(\d{1,2})\.(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})/);
      if (dateMatch) {
        timestamp = new Date(
          Number(dateMatch[3]),
          Number(dateMatch[2]) - 1,
          Number(dateMatch[1]),
          Number(dateMatch[4]),
          Number(dateMatch[5]),
          Number(dateMatch[6]),
        ).getTime();
      }
    } catch {
      timestamp = 0;
    }
    return { time, level: match[2].toLowerCase(), message: match[3], source: 'launcher', timestamp };
  }

  function parseGameLine(line) {
    const text = String(line);
    const match = text.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[([^\]]+)\]:\s?(.*)$/)
      || text.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
    const now = new Date();
    let timestamp = now.getTime();
    if (match) {
      const [hours, minutes, seconds] = match[1].split(':').map(Number);
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds);
      timestamp = date.getTime();
    }
    const thread = match && match.length > 3 ? match[2] : '';
    const message = match ? (match.length > 3 ? match[3] : match[2]) : text;
    let level = 'game';
    if (/ERROR|SEVERE|Exception|FATAL/i.test(thread) || /ERROR|SEVERE|Exception|FATAL/i.test(message)) level = 'error';
    else if (/WARN/i.test(thread) || /WARN/i.test(message)) level = 'warn';
    return {
      time: match ? match[1] : '—',
      level,
      message,
      source: 'game',
      timestamp,
    };
  }

  function isGameNoise(message) {
    const text = String(message || '');
    return /^(Mappings not present!|Warnings were found!|Loading \d+ mods:|SpongePowered MIXIN Subsystem|Loaded configuration file for Sodium|Searching for graphics cards|Found graphics adapter|Initializing MixinExtras|307 Datafixer optimizations|Environment: Environment\[|Loading Entity Model Features|Loading Entity Texture Features|\[ETF\]|\[EMF\]|\[Indigo\]|SDL \[SYSTEM\]|Backend library|Modifying process environment|Debug functionality is disabled|ARB_direct_state_access|Profile: HIGH|Using graphics backend|Using graphics device|Hardware information|CPU:|GPU:|OS:|Reloading ResourceManager|Found unifont|Size changed to|Created: .*minecraft:textures\/atlas|Thread\[#|OpenGL (Vendor|Renderer|Version)|Enabling GL_DEBUG_OUTPUT|OpenAL initialized|Sound engine started|Sodium has applied one or more workarounds|This is not necessarily an issue|Reference map ')/i.test(text)
      || /failed to fetch user properties/i.test(text)
      || /invalidcredentials/i.test(text)
      || /failed to fetch realms/i.test(text)
      || /could not authorize you against realms server/i.test(text)
      || /failed to parse into signedjwt/i.test(text)
      || /recommends any version of modmenu/i.test(text)
      || /Force-disabling mixin/i.test(text)
      || /^Created window using SDL/i.test(text)
      || /^Modifying OpenGL context/i.test(text)
      || /sun\.misc\.unsafe/i.test(text);
  }

  async function loadLogs(force = false) {
    if (!api || state.logsLoading) return;
    if (state.logsLoaded && !force) return;
    state.logsLoading = true;
    try {
      const data = await api.logs();
      state.logs.launcher = (data.launcher || []).map(parseLauncherLine).filter((entry) => entry.message);
      const gameLines = (data.game && data.game.length) ? data.game : (data.latest || []);
      state.logs.game = gameLines
        .map(parseGameLine)
        .filter((entry) => entry.message && !isGameNoise(entry.message));
      state.logsLoaded = true;
      renderLogs();
    } catch (error) {
      showToast('error', 'Не удалось открыть логи', error?.message || String(error));
    } finally {
      state.logsLoading = false;
    }
  }

  function appendLogEntry(entry) {
    if (!entry || !entry.message) return;
    if (entry.source === 'game' && isGameNoise(entry.message)) return;
    const normalized = {
      time: entry.time ? formatTime(entry.time) : '—',
      level: String(entry.level || 'info').toLowerCase(),
      message: String(entry.message),
      source: entry.source === 'game' ? 'game' : 'launcher',
      timestamp: entry.time ? new Date(entry.time).getTime() : Date.now(),
    };
    const bucket = normalized.source === 'game' ? state.logs.game : state.logs.launcher;
    bucket.push(normalized);
    if (bucket.length > 1200) bucket.splice(0, bucket.length - 1200);
    if (state.view === 'logs' && matchesFilter(normalized)) {
      appendLogLine(normalized);
      updateLogCount();
      if (state.logAutoScroll) scrollLogsToBottom();
    }
  }

  function matchesFilter(entry) {
    if (state.logFilter === 'all') return true;
    return entry.source === state.logFilter;
  }

  function visibleLogs() {
    if (state.logFilter === 'launcher') return state.logs.launcher;
    if (state.logFilter === 'game') return state.logs.game;
    return [...state.logs.launcher, ...state.logs.game].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  function renderLogs() {
    if (!els.logLines) return;
    const logs = visibleLogs().slice(-900);
    els.logLines.textContent = '';
    const fragment = document.createDocumentFragment();
    for (const entry of logs) fragment.append(createLogLine(entry));
    els.logLines.append(fragment);
    if (els.logEmpty) els.logEmpty.style.display = logs.length ? 'none' : '';
    updateLogCount();
    if (state.logAutoScroll) scrollLogsToBottom();
  }

  function appendLogLine(entry) {
    if (!els.logLines) return;
    if (els.logEmpty) els.logEmpty.style.display = 'none';
    els.logLines.append(createLogLine(entry));
    while (els.logLines.children.length > 900) els.logLines.firstElementChild?.remove();
  }

  function createLogLine(entry) {
    const line = document.createElement('div');
    line.className = `log-line ${entry.level}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.time;
    const source = document.createElement('span');
    source.className = 'log-source';
    source.textContent = entry.source === 'game' ? 'MC' : 'LAUNCH';
    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.message;
    line.append(time, source, message);
    return line;
  }

  function updateLogCount() {
    if (els.logCount) {
      const count = visibleLogs().length;
      els.logCount.textContent = `${count} ${count === 1 ? 'строка' : count < 5 ? 'строки' : 'строк'}`;
    }
  }

  function scrollLogsToBottom() {
    if (!els.logTerminal) return;
    requestAnimationFrame(() => {
      els.logTerminal.scrollTop = els.logTerminal.scrollHeight;
    });
  }

  async function copyLogs() {
    const entries = visibleLogs();
    if (!entries.length) {
      showToast('info', 'Логи пусты', 'Пока нечего копировать.');
      return;
    }
    const text = entries.map((entry) => `[${entry.time}] [${entry.source === 'game' ? 'MC' : 'LAUNCH'}] [${entry.level}] ${entry.message}`).join('\n');
    const ok = api.copyText ? await api.copyText(text) : false;
    if (ok) showToast('success', 'Логи скопированы', `${entries.length} строк в буфере обмена.`);
    else showToast('error', 'Не удалось скопировать', 'Попробуй ещё раз.');
  }

  /* ----------------------------------------------------------------------- */
  /*  Toasts / confirm / onboarding                                         */
  /* ----------------------------------------------------------------------- */

  function showToast(type = 'info', title = 'Сообщение', message = '', duration = 4600) {
    if (!els.toastStack) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'check' : type === 'error' ? 'alert' : type === 'warning' ? 'alert' : 'info';
    toast.innerHTML = `
      <span class="toast-icon"><svg class="icon"><use href="#i-${icon}"></use></svg></span>
      <span class="toast-copy"><b></b><span></span></span>
      <button type="button" class="toast-close" aria-label="Закрыть"><svg class="icon"><use href="#i-x"></use></svg></button>
    `;
    $('.toast-copy b', toast).textContent = title;
    $('.toast-copy span', toast).textContent = message;
    const close = () => {
      if (!toast.isConnected) return;
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 230);
    };
    $('.toast-close', toast).addEventListener('click', close);
    els.toastStack.append(toast);
    while (els.toastStack.children.length > 4) els.toastStack.firstElementChild?.remove();
    setTimeout(close, duration);
  }

  function openConfirm(title, text, label, handler) {
    if (!els.confirmModal) return;
    els.confirmTitle.textContent = title;
    els.confirmText.textContent = text;
    els.confirmAction.textContent = label;
    state.confirmHandler = handler;
    els.confirmModal.classList.add('open');
  }

  function closeConfirm() {
    els.confirmModal?.classList.remove('open');
    state.confirmHandler = null;
  }

  function openOnboarding(mode = 'onboarding') {
    if (!els.onboarding) return;
    state.loginMode = mode === 'switch' ? 'switch' : 'onboarding';
    const switching = state.loginMode === 'switch';
    els.onboarding.classList.toggle('login-mode', switching);
    if (els.onboardingTitle) els.onboardingTitle.textContent = switching ? 'Вход в аккаунт' : 'Давай знакомиться';
    if (els.onboardingSubtitle) {
      els.onboardingSubtitle.textContent = switching
        ? 'Введи новый ник — сервер, настройки и файлы игры останутся на месте.'
        : 'Сервер уже настроен. Осталось выбрать ник — и в путь.';
    }
    if (els.onboardingSubmitLabel) els.onboardingSubmitLabel.textContent = switching ? 'Войти' : 'Погнали';
    if (els.onboardingSubmitIcon) els.onboardingSubmitIcon.setAttribute('href', switching ? '#i-check' : '#i-play');
    if (els.onboardingNote) {
      els.onboardingNote.textContent = switching
        ? 'Если меняешь ник — он должен быть в whitelist сервера. Пароль не нужен.'
        : 'Всё можно изменить позже в настройках. Лицензия не требуется.';
    }
    els.onboardingNick.value = switching ? '' : (state.config.nick || '');
    els.onboardingShaders.checked = Boolean(state.config.shaders);
    els.onboardingAnimations.checked = Boolean(state.config.animations);
    els.onboardingError.textContent = '';
    els.onboarding.classList.add('open');
    setTimeout(() => {
      els.onboardingNick?.focus();
      if (switching) els.onboardingNick?.select();
    }, 300);
  }

  function closeOnboardingPanel() {
    els.onboarding?.classList.remove('open');
    els.onboarding?.classList.remove('login-mode');
    state.loginMode = 'onboarding';
  }

  async function submitOnboarding({ silentClose = false } = {}) {
    const switching = state.loginMode === 'switch';
    const nick = sanitizeNick(els.onboardingNick?.value);
    if (nick.length < 2) {
      els.onboardingError.textContent = 'Ник должен быть от 2 до 32 символов.';
      els.onboardingNick?.focus();
      return;
    }

    els.onboardingError.textContent = '';
    els.onboardingSubmit.disabled = true;
    try {
      const patch = switching
        ? { nick, onboarded: true }
        : {
            nick,
            shaders: Boolean(els.onboardingShaders?.checked),
            animations: Boolean(els.onboardingAnimations?.checked),
            onboarded: true,
          };
      const config = await api.saveConfig(patch);
      state.config = { ...config };
      applyConfigToUI();
      syncSettingsForm();
      updateAvatar();
      closeOnboardingPanel();
      if (!silentClose) {
        showToast(
          'success',
          switching ? 'Ник изменён' : 'Добро пожаловать в URALCRAFT',
          switching
            ? `Теперь входишь как ${nick}. Сервер и настройки остались на месте.`
            : 'Настройки сохранены. Сервер уже в списке.',
        );
      }
      if (!switching) {
        state.server = null;
        renderServerUI();
        pingServer({ silent: true });
        refreshAllServers({ silent: true });
      }
    } catch (error) {
      els.onboardingError.textContent = error?.message || 'Не удалось сохранить настройки.';
    } finally {
      els.onboardingSubmit.disabled = false;
    }
  }

  async function closeOnboardingWithoutSubmit() {
    if (state.loginMode === 'switch') {
      closeOnboardingPanel();
      showToast('info', 'Вход отменён', 'Остался прежний ник.');
      return;
    }
    if (state.config.onboarded) {
      closeOnboardingPanel();
      return;
    }
    const nick = sanitizeNick(els.onboardingNick?.value) || state.config.nick || 'Steve';
    try {
      const config = await api.saveConfig({ nick, onboarded: true });
      state.config = { ...config };
      applyConfigToUI();
      syncSettingsForm();
      updateAvatar();
    } catch {
      state.config.onboarded = true;
    }
    closeOnboardingPanel();
    showToast('info', 'Можно начинать', 'Ник всегда можно поменять в настройках.');
  }

  function openLogout() {
    if (state.running) {
      showToast('info', 'Сначала закрой Minecraft', 'Выйти и сменить ник можно после выхода из игры.');
      return;
    }
    if (state.busy) {
      showToast('info', 'Подожди', 'Идёт подготовка или проверка файлов.');
      return;
    }
    openOnboarding('switch');
  }

  function openServerModal(server = null) {
    if (!els.serverModal) return;
    state.editingServerId = server && !server.isDefault ? server.id : null;
    if (els.serverModalTitle) {
      els.serverModalTitle.textContent = state.editingServerId ? 'Изменить сервер' : 'Добавить сервер';
    }
    if (els.serverModalSubtitle) {
      els.serverModalSubtitle.textContent = state.editingServerId
        ? 'Название и адрес можно поменять в любой момент.'
        : 'Название и адрес — больше ничего не нужно.';
    }
    if (els.serverNameInput) els.serverNameInput.value = server?.name || '';
    if (els.serverAddressInput) els.serverAddressInput.value = server?.address || '';
    if (els.serverModalError) els.serverModalError.textContent = '';
    els.serverModal.classList.add('open');
    setTimeout(() => els.serverNameInput?.focus(), 220);
  }

  function closeServerModal() {
    els.serverModal?.classList.remove('open');
    state.editingServerId = null;
  }

  async function saveServerModal() {
    const name = (els.serverNameInput?.value || '').trim().slice(0, 48);
    const address = normalizeServerInput(els.serverAddressInput?.value);
    if (!name) {
      els.serverModalError.textContent = 'Придумай название серверу.';
      els.serverNameInput?.focus();
      return;
    }
    if (!address) {
      els.serverModalError.textContent = 'Проверь адрес: нужен формат host:port.';
      els.serverAddressInput?.focus();
      return;
    }
    els.serverModalError.textContent = '';
    if (els.serverModalSave) els.serverModalSave.disabled = true;
    try {
      const editingId = state.editingServerId;
      const result = editingId
        ? await api.updateServer(editingId, { name, address })
        : await api.addServer({ name, address });
      if (!result?.ok) {
        els.serverModalError.textContent = result?.error || 'Не удалось сохранить сервер.';
        return;
      }
      applyServerStore(result.store);
      closeServerModal();
      if (state.view === 'server') renderServerList();
      refreshAllServers({ force: true, silent: true });
      pingServer({ force: true, silent: true });
      showToast('success', editingId ? 'Сервер изменён' : 'Сервер добавлен', `${name} · ${address}`);
    } catch (error) {
      els.serverModalError.textContent = error?.message || 'Не удалось сохранить сервер.';
    } finally {
      if (els.serverModalSave) els.serverModalSave.disabled = false;
    }
  }

  function deleteServer(server) {
    if (!server || server.isDefault) {
      showToast('info', 'Домашний сервер', 'Его нельзя удалить — он всегда первый в списке.');
      return;
    }
    openConfirm(
      'Удалить сервер?',
      `«${server.name}» исчезнет из списка. Файлы игры и настройки останутся на месте.`,
      'Удалить',
      async () => {
        const result = await api.removeServer(server.id);
        if (!result?.ok) {
          showToast('error', 'Не удалось удалить', result?.error || 'Попробуй ещё раз.');
          return;
        }
        applyServerStore(result.store);
        if (state.view === 'server') renderServerList();
        refreshAllServers({ force: true, silent: true });
        pingServer({ force: true, silent: true });
        showToast('info', 'Сервер удалён', server.name);
      },
    );
  }

  /* ----------------------------------------------------------------------- */
  /*  Actions / events                                                      */
  /* ----------------------------------------------------------------------- */

  function bindEvents() {
    document.addEventListener('click', async (event) => {
      const nav = event.target.closest('[data-nav]');
      if (nav) {
        event.preventDefault();
        showView(nav.dataset.nav);
        return;
      }

      const actionElement = event.target.closest('[data-action]');
      if (actionElement) {
        event.preventDefault();
        event.stopPropagation();
        await handleAction(actionElement.dataset.action, actionElement);
      }
    });

    els.titlebar?.addEventListener('dblclick', (event) => {
      if (event.target.closest('.window-controls')) return;
      api.win.toggleMaximize();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        startGame();
        return;
      }
      if (event.key === 'Escape') {
        if (els.confirmModal?.classList.contains('open')) {
          closeConfirm();
          return;
        }
        if (els.serverModal?.classList.contains('open')) {
          closeServerModal();
          return;
        }
        if (els.onboarding?.classList.contains('open')) {
          closeOnboardingWithoutSubmit();
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        showView(['home', 'server', 'logs', 'settings'][Number(event.key) - 1]);
      }
    });

    els.railTheme?.addEventListener('click', () => {
      const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
      queueConfig({ theme: next }, { immediate: true });
    });

    els.playButton?.addEventListener('click', () => startGame());
    els.serverPlayButton?.addEventListener('click', () => startGame());
    els.cancelLaunch?.addEventListener('click', cancelLaunch);
    $('#confirmAction')?.addEventListener('click', async () => {
      const handler = state.confirmHandler;
      closeConfirm();
      if (handler) await handler();
    });

    els.logFilter?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-log-filter]');
      if (!button) return;
      state.logFilter = button.dataset.logFilter;
      for (const item of $$('button', els.logFilter)) item.classList.toggle('active', item === button);
      renderLogs();
    });

    els.logAutoScroll?.addEventListener('change', () => {
      state.logAutoScroll = Boolean(els.logAutoScroll.checked);
      if (state.logAutoScroll) scrollLogsToBottom();
    });

    els.themeOptions?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-theme-choice]');
      if (!button) return;
      queueConfig({ theme: button.dataset.themeChoice }, { immediate: true });
    });

    bindCheckbox(els.homeShaders, (value) => queueConfig({ shaders: value }, { immediate: true }));
    bindCheckbox(els.homeAnimations, (value) => queueConfig({ animations: value }, { immediate: true }));
    bindCheckbox(els.homeVoiceChat, (value) => queueConfig({ voiceChat: value }, { immediate: true }));
    bindCheckbox(els.homeFsr, (value) => queueConfig({ upscale: value }, { immediate: true }));
    bindCheckbox(els.settingShaders, (value) => queueConfig({ shaders: value }, { immediate: true }));
    bindCheckbox(els.settingAnimations, (value) => queueConfig({ animations: value }, { immediate: true }));
    bindCheckbox(els.settingVoiceChat, (value) => queueConfig({ voiceChat: value }, { immediate: true }));
    bindCheckbox(els.settingUpscale, (value) => queueConfig({ upscale: value }, { immediate: true }));
    bindCheckbox(els.settingAutoConnect, (value) => queueConfig({ autoConnect: value }, { immediate: true }));
    bindCheckbox(els.settingMinimize, (value) => queueConfig({ minimizeOnLaunch: value }, { immediate: true }));
    bindCheckbox(els.settingThemeShortcut, (value) => queueConfig({ themeShortcut: value }, { immediate: true }));

    bindSlider(els.homeRam, () => {
      const value = Number(els.homeRam.value);
      setRangeFill(els.homeRam, value);
      setRangeFill(els.settingRam, value);
      els.homeRamValue.textContent = String(value);
      els.settingsRamValue.textContent = String(value);
      if (els.settingRam.value !== String(value)) els.settingRam.value = String(value);
    }, () => queueConfig({ ram: Number(els.homeRam.value) }, { immediate: true }));

    bindSlider(els.settingRam, () => {
      const value = Number(els.settingRam.value);
      setRangeFill(els.settingRam, value);
      setRangeFill(els.homeRam, value);
      els.homeRamValue.textContent = String(value);
      els.settingsRamValue.textContent = String(value);
      if (els.homeRam.value !== String(value)) els.homeRam.value = String(value);
    }, () => queueConfig({ ram: Number(els.settingRam.value) }, { immediate: true }));

    bindSlider(els.settingUpscaleScale, () => {
      const value = Number(els.settingUpscaleScale.value);
      els.settingsFsrValue.textContent = String(value);
      els.homeFsrValue.textContent = String(value);
      setRangeFill(els.settingUpscaleScale, value);
    }, () => queueConfig({ upscaleScale: Number(els.settingUpscaleScale.value) }));

    els.settingNick?.addEventListener('change', () => {
      const value = sanitizeNick(els.settingNick.value);
      if (value.length < 2) {
        showToast('error', 'Слишком короткий ник', 'Минимум 2 символа.');
        els.settingNick.value = state.config.nick || '';
        return;
      }
      els.settingNick.value = value;
      queueConfig({ nick: value });
    });

    els.settingNick?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        els.settingNick.blur();
      }
    });

    els.settingServer?.addEventListener('change', () => {
      const normalized = normalizeServerInput(els.settingServer.value);
      if (!normalized) {
        showToast('error', 'Неверный адрес', 'Используй формат host:port, например 31.25.31.112:22222.');
        els.settingServer.value = state.config.server || '';
        return;
      }
      els.settingServer.value = normalized;
      if (normalized !== state.config.server) {
        queueConfig({ server: normalized }, { immediate: true });
      }
    });

    els.settingServer?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        els.settingServer.blur();
      }
    });

    if (els.testServerButton) {
      els.testServerButton.addEventListener('click', async () => {
        const normalized = normalizeServerInput(els.settingServer.value);
        if (!normalized) {
          showToast('error', 'Неверный адрес', 'Нужен формат host:port.');
          return;
        }
        if (normalized !== state.config.server) {
          els.settingServer.value = normalized;
          queueConfig({ server: normalized }, { immediate: true });
          await persistConfig();
        }
        state.server = null;
        state.serverCheckedAt = 0;
        pingServer({ manual: true });
      });
    }

    els.onboardingSubmit?.addEventListener('click', () => submitOnboarding());
    els.serverModalSave?.addEventListener('click', saveServerModal);
    els.serverNameInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') els.serverAddressInput?.focus();
    });
    els.serverAddressInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveServerModal();
    });
    els.onboardingServer?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitOnboarding();
    });
    els.onboardingNick?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submitOnboarding();
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.config.theme === 'system') applyTheme();
    });
  }

  function bindCheckbox(element, handler) {
    if (!element) return;
    element.addEventListener('change', () => handler(Boolean(element.checked)));
  }

  function bindSlider(element, onInput, onChange) {
    if (!element) return;
    element.addEventListener('input', onInput);
    element.addEventListener('change', onChange);
  }

  async function handleAction(action, element) {
    switch (action) {
      case 'win-minimize':
        api.win.minimize();
        break;
      case 'win-maximize':
        api.win.toggleMaximize();
        setTimeout(async () => updateMaximizeIcon(await api.win.isMaximized()), 80);
        break;
      case 'win-close':
        api.win.close();
        break;
      case 'copy-ip':
        await copyToClipboard(state.config.server, 'Адрес сервера скопирован', state.config.server);
        break;
      case 'open-server':
        showView('server');
        break;
      case 'add-server':
        openServerModal();
        break;
      case 'edit-server': {
        const server = serverById(element?.dataset?.serverId);
        if (server) openServerModal(server);
        break;
      }
      case 'delete-server': {
        const server = serverById(element?.dataset?.serverId);
        if (server) deleteServer(server);
        break;
      }
      case 'play-server': {
        const server = serverById(element?.dataset?.serverId);
        if (server) await startGame(server.id);
        break;
      }
      case 'copy-server': {
        const server = serverById(element?.dataset?.serverId);
        if (server) await copyToClipboard(server.address, 'Адрес скопирован', server.address);
        break;
      }
      case 'refresh-all-servers':
        await refreshAllServers({ force: true });
        showToast('info', 'Статусы обновлены', 'Проверил все серверы из списка.');
        break;
      case 'close-server-modal':
        closeServerModal();
        break;
      case 'logout':
        openLogout();
        break;
      case 'open-screenshots':
        await openFolder('screenshots');
        break;
      case 'open-game':
        await openFolder('game');
        break;
      case 'open-logs':
        showView('logs');
        break;
      case 'open-launcher-log':
        await openFolder('launcher-log');
        break;
      case 'refresh-server':
        await pingServer({ manual: true });
        break;
      case 'verify-files':
        await verifyFiles();
        break;
      case 'reset-settings':
        openConfirm(
          'Сбросить настройки?',
          'Ник, память, графика и оформление вернутся к значениям по умолчанию. Файлы игры останутся на месте.',
          'Сбросить',
          async () => {
            const config = await api.resetConfig();
            state.config = { ...config };
            state.pendingPatch = {};
            applyConfigToUI();
            syncSettingsForm();
            updateAvatar();
            state.server = null;
            renderServerUI();
            showView('home');
            showToast('success', 'Настройки сброшены', 'Можно настроить всё заново.');
            setTimeout(openOnboarding, 500);
          },
        );
        break;
      case 'cancel-launch':
        await cancelLaunch();
        break;
      case 'refresh-logs':
        await loadLogs(true);
        showToast('info', 'Логи обновлены', 'Загружены последние записи.');
        break;
      case 'copy-logs':
        await copyLogs();
        break;
      case 'close-onboarding':
        await closeOnboardingWithoutSubmit();
        break;
      case 'confirm-cancel':
        closeConfirm();
        break;
      default:
        break;
    }
  }

  async function openFolder(key) {
    const result = await api.openPath(key);
    if (result && result.ok === false) {
      showToast('error', 'Не удалось открыть', result.error || 'Проверь папку вручную.');
    }
  }

  async function copyToClipboard(text, title, message) {
    if (!text) return;
    let okCode = false;
    try {
      if (api.copyText) okCode = await api.copyText(text);
      if (!okCode && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        okCode = true;
      }
    } catch {
      okCode = false;
    }
    if (okCode) showToast('success', title, message);
    else showToast('error', 'Не удалось скопировать', 'Попробуй выделить адрес вручную.');
  }

  function sanitizeNick(value) {
    return String(value || '')
      .trim()
      .replace(/[^\wа-яА-ЯёЁ\-.]/g, '')
      .slice(0, 32);
  }

  function normalizeServerInput(value) {
    let server = String(value || '').trim().replace(/^minecraft:\/\//i, '').replace(/\/+$/, '');
    if (!server) return '';
    if (!server.includes(':')) server += ':25565';
    const index = server.lastIndexOf(':');
    if (index <= 0) return '';
    const host = server.slice(0, index).trim();
    const port = Number(server.slice(index + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    if (!/^[a-zA-Z0-9._:-]+$/.test(host)) return '';
    return `${host}:${port}`;
  }

  // Expose tiny hooks for the screenshot build and UI checks.
  window.__uralcraftShowView = (view) => showView(view);
  window.__uralcraftOpenLogin = () => openOnboarding('switch');
  window.__uralcraftLogout = () => openLogout();

  init();
})();
