'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AVATARS_DIR } = require('./paths');
const { APP_VERSION } = require('./paths');

function cachePath(nick) {
  const hash = crypto.createHash('md5').update(String(nick).toLowerCase()).digest('hex');
  return path.join(AVATARS_DIR, `${hash}.png`);
}

async function fetchAvatar(nick) {
  const name = String(nick || '').trim();
  if (!name) return null;
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  const file = cachePath(name);
  try {
    const stat = fs.statSync(file);
    if (stat.size > 100 && Date.now() - stat.mtimeMs < 7 * 24 * 60 * 60 * 1000) {
      return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    }
  } catch {
    // no cache
  }

  try {
    const response = await fetch(`https://mc-heads.net/avatar/${encodeURIComponent(name)}/160`, {
      headers: {
        'User-Agent': `URALCRAFT/${APP_VERSION}`,
        Accept: 'image/png,image/*',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length < 100) return null;
    fs.writeFileSync(file, data);
    return `data:image/png;base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

module.exports = {
  fetchAvatar,
};
