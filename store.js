const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./settings');

const FILE = path.join(ROOT, 'data', '247.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[store] تعذر حفظ 247:', e.message);
  }
}

module.exports = { load, save };
