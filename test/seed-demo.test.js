const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo');

test('示範資料可以重跑，不會把已結算的餘額再加一次', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-demo-'));
  const db = openDatabase(path.join(dir, 't.db'));
  try {
    const first = seedDemo(db);
    assert.equal(first.ming.merit, 70);
    assert.equal(first.ming.quota, 130);
    assert.equal(first.hua.merit, 130);
    assert.equal(first.hua.city, '臺北市');
    assert.equal(first.ming.availability, '今天 14:00–18:00 可以');
    const again = seedDemo(db);
    assert.equal(again.ming.merit, 70);
    assert.equal(again.hua.merit, 130);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM posts`).get().count, 3);
    const profile = db.prepare('SELECT comment FROM ratings').all();
    assert.equal(profile.length, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
