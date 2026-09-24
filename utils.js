// دوال مساعدة بدون أي اعتماد خارجي (سهلة الاختبار)

const COMMANDS = {
  play: ['ش', 'شغل', 'play'],
  skip: ['س', 'سكب', 'تخطي', 'skip'],
  stop: ['ايقاف', 'توقف', 'وقف', 'stop'],
  '247': ['247'],
};

// يوحّد الهمزات والتشكيل عشان "إيقاف" و "ايقاف" يكونون نفس الشي
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

const ALIASES = new Map();
for (const [cmd, list] of Object.entries(COMMANDS)) for (const a of list) ALIASES.set(normalize(a), cmd);

function parseCommand(content, prefix, allowNoPrefix) {
  let text = String(content || '').trim();
  if (!text) return null;
  let usedPrefix = false;
  if (prefix && text.startsWith(prefix)) {
    text = text.slice(prefix.length).trim();
    usedPrefix = true;
  } else if (!allowNoPrefix) {
    return null;
  }
  const parts = text.split(/\s+/);
  const cmd = ALIASES.get(normalize(parts.shift() || ''));
  if (!cmd) return null;
  return { cmd, args: parts, usedPrefix };
}

const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s).trim());

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function progressBar(pos, len, size = 14) {
  if (!len || len <= 0) return '▬'.repeat(size);
  const idx = Math.max(0, Math.min(size - 1, Math.floor((pos / len) * size)));
  return '▬'.repeat(idx) + '🔘' + '▬'.repeat(size - idx - 1);
}

const truncate = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { COMMANDS, normalize, parseCommand, isUrl, formatTime, progressBar, truncate, shuffle };
