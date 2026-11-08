'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  LAUNCHER_NAME,
  GAME_DIR,
  APP_VERSION,
} = require('./paths');
const {
  rulesAllow,
  subst,
  offlineUuid,
} = require('./utils');

function resolveArguments(items, features, context) {
  const output = [];
  for (const item of items || []) {
    if (typeof item === 'string') {
      output.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (!rulesAllow(item.rules, features)) continue;
    const value = item.value;
    if (typeof value === 'string') output.push(value);
    else if (Array.isArray(value)) output.push(...value.filter((entry) => typeof entry === 'string'));
  }
  return output.map((item) => subst(item, context));
}

function buildCommand(version, javaPath, options) {
  const {
    nick,
    server,
    ram,
    classpath,
    nativesDir,
    gameDir = GAME_DIR,
    logConfigPath = null,
  } = options;

  const features = {
    is_demo_user: false,
    has_custom_resolution: false,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: Boolean(server),
    is_quick_play_realms: false,
  };

  const context = {
    auth_player_name: nick,
    version_name: version.id,
    game_directory: gameDir,
    assets_root: options.assetsDir,
    assets_index_name: version.assetIndex?.id || '',
    auth_uuid: offlineUuid(nick),
    auth_access_token: '0',
    clientid: '',
    auth_xuid: '',
    user_type: 'legacy',
    version_type: version.type || 'release',
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: APP_VERSION,
    classpath: classpath.join(path.delimiter),
    resolution_width: '1280',
    resolution_height: '720',
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: server || '',
    quickPlayRealms: '',
  };

  const jvmArguments = [
    `-Xmx${ram}G`,
    `-Xms${Math.min(ram, 2)}G`,
    '-Dfile.encoding=UTF-8',
  ];
  if (logConfigPath) {
    jvmArguments.push(`-Dlog4j.configurationFile=${logConfigPath}`);
  }

  const addJvm = resolveArguments(version.arguments?.jvm, features, context);
  if (addJvm.length) jvmArguments.push(...addJvm);
  if (!jvmArguments.some((argument) => argument.startsWith('-Djava.library.path='))) {
    jvmArguments.push(`-Djava.library.path=${nativesDir}`);
  }

  const gameArguments = resolveArguments(version.arguments?.game, features, context);
  if (server && !gameArguments.includes('--quickPlayMultiplayer')) {
    gameArguments.push('--quickPlayMultiplayer', server);
  }

  return [javaPath, ...jvmArguments, version.mainClass, ...gameArguments];
}

function attachLines(stream, callback) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) callback(line);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) callback(buffer.trim());
    buffer = '';
  });
}

function spawnGame(command, { onLine, onExit, onError } = {}) {
  fs.mkdirSync(path.dirname(path.join(GAME_DIR, 'logs', 'latest.log')), { recursive: true });
  const env = { ...process.env };
  delete env.JAVA_TOOL_OPTIONS;
  delete env._JAVA_OPTIONS;
  const child = spawn(command[0], command.slice(1), {
    cwd: GAME_DIR,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.stdout) attachLines(child.stdout, (line) => onLine?.(line));
  if (child.stderr) attachLines(child.stderr, (line) => onLine?.(line));
  child.once('error', (error) => onError?.(error));
  child.once('exit', (code, signal) => onExit?.({ code, signal }));
  return child;
}

module.exports = {
  buildCommand,
  spawnGame,
  resolveArguments,
};
