const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./settings');

const { ROOT } = config;
const KEEP = /(WARN|ERROR|Exception|ready to accept|[Pp]lugin|Downloading|Started Launcher)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let stopping = false;
let restarts = 0;

function findJar() {
  const f = fs.readdirSync(ROOT).find((n) => /^lavalink.*\.jar$/i.test(n));
  return f ? path.join(ROOT, f) : null;
}

function javaMajor() {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (r.error) return null;
  const m = `${r.stderr || ''}${r.stdout || ''}`.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  const major = Number(m[1]);
  return major === 1 ? Number(m[2]) : major;
}

// يرجع رمز الاستجابة (0 = ما فيه رد)
async function ping() {
  const { host, port, password } = config.lavalink;
  try {
    const res = await fetch(`http://${host}:${port}/version`, {
      headers: { Authorization: password },
      signal: AbortSignal.timeout(2500),
    });
    return res.status;
  } catch {
    return 0;
  }
}

function spawnJava(jar) {
  const { port, password, xmx, logs, ytOauth, ytRefreshToken } = config.lavalink;
  const env = {
    ...process.env,
    SERVER_PORT: String(port),
    SERVER_ADDRESS: '127.0.0.1',
    LAVALINK_SERVER_PASSWORD: password,
  };
  delete env.DISCORD_TOKEN; // ما نمرر توكن البوت لعملية Java
  if (ytOauth) env.PLUGINS_YOUTUBE_OAUTH_ENABLED = 'true';
  if (ytRefreshToken) env.PLUGINS_YOUTUBE_OAUTH_REFRESHTOKEN = ytRefreshToken;

  child = spawn('java', ['-Xms32m', `-Xmx${xmx}`, '-XX:+UseSerialGC', '-jar', jar], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onData = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (line.trim() && (logs || KEEP.test(line))) console.log('[Lavalink]', line.slice(0, 300));
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => console.error('[Lavalink] خطأ تشغيل:', e.message));
  child.on('exit', (code, sig) => {
    console.warn(`[Lavalink] توقف (code=${code} signal=${sig})`);
    child = null;
    if (!stopping && restarts < 5) {
      restarts++;
      setTimeout(() => spawnJava(jar), 5000);
    }
  });
}

async function startLavalink() {
  if ((await ping()) > 0) {
    console.log('[Lavalink] شغّال مسبقاً على نفس المنفذ، سأتصل به مباشرة');
    return;
  }
  const jar = findJar();
  if (!jar) throw new Error('ما لقيت ملف Lavalink.jar داخل مجلد المشروع (بجانب index.js)');

  const major = javaMajor();
  if (major === null) throw new Error('Java غير مثبتة على هذا السيرفر. Lavalink يحتاج Java 17 أو أعلى.');
  if (major < 17) throw new Error(`نسخة Java هنا ${major} وLavalink يحتاج 17 أو أعلى.`);

  console.log(`[Lavalink] تشغيل ${path.basename(jar)} (Java ${major}) ... أول مرة قد ياخذ دقيقة لتنزيل إضافة يوتيوب`);
  spawnJava(jar);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!child && restarts >= 5) throw new Error('Lavalink يتوقف باستمرار. فعّل LAVALINK_LOGS=true لمعرفة السبب.');
    if ((await ping()) > 0) {
      console.log('✅ Lavalink جاهز');
      return;
    }
    await sleep(2000);
  }
  throw new Error('Lavalink ما جهز خلال 3 دقائق. فعّل LAVALINK_LOGS=true لمعرفة السبب.');
}

function stopLavalink() {
  stopping = true;
  if (child) child.kill('SIGTERM');
}

module.exports = { startLavalink, stopLavalink };
