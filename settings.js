const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

// الأولوية: متغيرات السيرفر > .env > config.json
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* dotenv اختياري */ }
try {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  for (const [k, v] of Object.entries(file)) {
    if (process.env[k] === undefined && v !== null && String(v) !== '') process.env[k] = String(v);
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.error('[config] ملف config.json فيه خطأ:', e.message);
}

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

const OWNER_ID = '884513208017256488';
const autostart = bool(env.LAVALINK_AUTOSTART, true);

module.exports = {
  ROOT,
  token: env.DISCORD_TOKEN,
  owners: new Set([OWNER_ID, ...(env.OWNER_IDS || '').split(/[,\s]+/).filter(Boolean)]),
  prefix: env.PREFIX || '-',
  noPrefix: bool(env.NO_PREFIX, true),
  defaultVolume: clamp(int(env.DEFAULT_VOLUME, 80), 1, 150),
  idleLeaveMs: clamp(int(env.IDLE_LEAVE_SECONDS, 120), 10, 3600) * 1000,
  emptyLeaveMs: 60_000,
  searchPrefix: env.SEARCH_PREFIX || 'ytsearch',
  lavalink: {
    autostart,
    host: autostart ? '127.0.0.1' : env.LAVALINK_HOST || '127.0.0.1',
    port: int(env.LAVALINK_PORT, 2333),
    password: env.LAVALINK_PASSWORD || 'youshallnotpass',
    secure: bool(env.LAVALINK_SECURE, false),
    xmx: env.LAVALINK_XMX || '384m',
    logs: bool(env.LAVALINK_LOGS, false),
    ytOauth: bool(env.YT_OAUTH, false),
    ytRefreshToken: env.YT_REFRESH_TOKEN || '',
  },
};
