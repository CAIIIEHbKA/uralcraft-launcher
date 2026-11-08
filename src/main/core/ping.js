'use strict';

const net = require('net');
const { parseServer } = require('./utils');

const MC_COLORS = {
  '0': '#000000',
  '1': '#0000aa',
  '2': '#00aa00',
  '3': '#00aaaa',
  '4': '#aa0000',
  '5': '#aa00aa',
  '6': '#ffaa00',
  '7': '#aaaaaa',
  '8': '#555555',
  '9': '#5555ff',
  a: '#55ff55',
  b: '#55ffff',
  c: '#ff5555',
  d: '#ff55ff',
  e: '#ffff55',
  f: '#ffffff',
  g: '#dddddd',
};

const NAMED_COLORS = {
  black: '#000000',
  dark_blue: '#0000aa',
  dark_green: '#00aa00',
  dark_aqua: '#00aaaa',
  dark_red: '#aa0000',
  dark_purple: '#aa00aa',
  gold: '#ffaa00',
  gray: '#aaaaaa',
  grey: '#aaaaaa',
  dark_gray: '#555555',
  dark_grey: '#555555',
  blue: '#5555ff',
  green: '#55ff55',
  aqua: '#55ffff',
  red: '#ff5555',
  light_purple: '#ff55ff',
  yellow: '#ffff55',
  white: '#ffffff',
};

function normalizeColor(color) {
  if (!color) return null;
  if (typeof color === 'string' && color.startsWith('#')) return color;
  return NAMED_COLORS[String(color).toLowerCase()] || null;
}

function legacySegments(text, inherited = {}) {
  const segments = [];
  const base = {
    color: inherited.color || null,
    bold: Boolean(inherited.bold),
    italic: Boolean(inherited.italic),
    underlined: Boolean(inherited.underlined),
    strikethrough: Boolean(inherited.strikethrough),
    obfuscated: Boolean(inherited.obfuscated),
  };
  let style = { ...base };
  const parts = String(text).split(/(§[0-9A-FK-ORX])/gi);
  for (const part of parts) {
    if (!part) continue;
    if (/^§[0-9A-FK-ORX]$/i.test(part)) {
      const code = part[1].toLowerCase();
      if (MC_COLORS[code]) style = { ...style, color: MC_COLORS[code] };
      else if (code === 'l') style = { ...style, bold: true };
      else if (code === 'o') style = { ...style, italic: true };
      else if (code === 'n') style = { ...style, underlined: true };
      else if (code === 'm') style = { ...style, strikethrough: true };
      else if (code === 'k') style = { ...style, obfuscated: true };
      else if (code === 'r') style = { ...base };
      continue;
    }
    segments.push({ text: part, ...style });
  }
  return segments;
}

function componentSegments(component, inherited = {}) {
  if (component === null || component === undefined) return [];
  if (typeof component === 'string') {
    return legacySegments(component, inherited);
  }
  if (Array.isArray(component)) {
    return component.flatMap((item) => componentSegments(item, inherited));
  }
  if (typeof component !== 'object') {
    return [{ text: String(component), ...inherited }];
  }

  const style = {
    ...inherited,
    color: normalizeColor(component.color) || inherited.color || null,
    bold: component.bold !== undefined ? Boolean(component.bold) : Boolean(inherited.bold),
    italic: component.italic !== undefined ? Boolean(component.italic) : Boolean(inherited.italic),
    underlined: component.underlined !== undefined ? Boolean(component.underlined) : Boolean(inherited.underlined),
    strikethrough: component.strikethrough !== undefined ? Boolean(component.strikethrough) : Boolean(inherited.strikethrough),
    obfuscated: component.obfuscated !== undefined ? Boolean(component.obfuscated) : Boolean(inherited.obfuscated),
  };

  const result = [];
  if (component.text !== undefined) {
    result.push(...legacySegments(String(component.text), style));
  } else if (component.translate) {
    const args = Array.isArray(component.with)
      ? component.with.map((arg) => (typeof arg === 'string' ? arg : String(arg?.text || ''))).join(' ')
      : '';
    result.push({ ...style, text: args || String(component.translate) });
  }
  for (const extra of component.extra || []) {
    result.push(...componentSegments(extra, style));
  }
  return result;
}

function descriptionToText(description) {
  const segments = componentSegments(description);
  return {
    segments: segments.filter((segment) => segment.text),
    plain: segments.map((segment) => segment.text).join('').replace(/\s+/g, ' ').trim(),
  };
}

function readVarInt(buffer, offset = 0) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

function writeVarInt(value) {
  const bytes = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);
  return Buffer.from(bytes);
}

function writeString(value) {
  const data = Buffer.from(String(value), 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

function parseStatusPacket(buffer) {
  const lengthInfo = readVarInt(buffer, 0);
  if (!lengthInfo) return null;
  if (buffer.length < lengthInfo.offset + lengthInfo.value) return null;
  const end = lengthInfo.offset + lengthInfo.value;
  let cursor = lengthInfo.offset;
  const packetId = readVarInt(buffer, cursor);
  if (!packetId) return null;
  cursor = packetId.offset;
  const stringLength = readVarInt(buffer, cursor);
  if (!stringLength) return null;
  cursor = stringLength.offset;
  if (cursor + stringLength.value > end) return null;
  const json = buffer.subarray(cursor, cursor + stringLength.value).toString('utf8');
  return JSON.parse(json);
}

function pingServer(address, { timeout = 3500, protocol = 777 } = {}) {
  const parsed = parseServer(address);
  if (!parsed) return Promise.resolve({ online: false, error: 'Некорректный адрес сервера' });
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = net.createConnection({ host: parsed.host, port: parsed.port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => {
      finish({ online: false, error: 'Сервер не отвечает', address: parsed.address, latency: Date.now() - started });
    });
    socket.on('connect', () => {
      const host = Buffer.from(parsed.host, 'utf8');
      const handshake = Buffer.concat([
        writeVarInt(0),
        writeVarInt(protocol),
        writeVarInt(host.length),
        host,
        Buffer.from([(parsed.port >> 8) & 0xff, parsed.port & 0xff]),
        writeVarInt(1),
      ]);
      socket.write(Buffer.concat([writeVarInt(handshake.length), handshake]));
      socket.write(Buffer.concat([writeVarInt(1), writeVarInt(0)]));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const status = parseStatusPacket(buffer);
        if (!status) return;
        const description = descriptionToText(status.description);
        finish({
          online: true,
          address: parsed.address,
          host: parsed.host,
          port: parsed.port,
          latency: Date.now() - started,
          version: status.version || null,
          players: status.players || null,
          motd: description.plain,
          motdSegments: description.segments,
          rawDescription: status.description,
          favicon: status.favicon || null,
        });
      } catch (error) {
        finish({ online: false, error: error.message, address: parsed.address });
      }
    });
    socket.on('error', (error) => {
      finish({ online: false, error: error.code === 'ECONNREFUSED' ? 'Сервер выключен' : 'Не удалось подключиться', address: parsed.address, latency: Date.now() - started });
    });
    socket.on('close', () => {
      finish({ online: false, error: 'Сервер закрыл соединение', address: parsed.address, latency: Date.now() - started });
    });
  });
}

module.exports = {
  pingServer,
  descriptionToText,
  legacySegments,
  MC_COLORS,
};
