'use strict';

const fs = require('fs');
const {
  LAUNCHER_LOG,
  JAVA_LOG,
  LATEST_GAME_LOG,
} = require('./paths');

function readTail(file, maxLines = 400, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return [];
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const lines = buffer.toString('utf8').split(/\r?\n/);
      return lines.slice(-maxLines).filter((line) => line.length > 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function readLogs() {
  return {
    launcher: readTail(LAUNCHER_LOG, 400),
    game: readTail(JAVA_LOG, 500),
    latest: readTail(LATEST_GAME_LOG, 500),
  };
}

module.exports = {
  readTail,
  readLogs,
};
