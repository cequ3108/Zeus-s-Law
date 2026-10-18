const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { normalizeCity } = require('../src/places');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-city-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
  return {
    db,
    services,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('台會正規化成臺', () => {
  assert.equal(normalizeCity('台北市'), '臺北市');
  assert.equal(normalizeCity('臺北市'), '臺北市');
  assert.throws(() => normalizeCity('火星市'), /縣市/);
});

test('新貼文必須有縣市，首頁可依縣市篩選，舊貼文留在全部', () => {
  const env = setup();
  try {
    const author = env.services.register('0912100001', '在台北');
    assert.throws(
      () => env.services.createPost(author.id, {
        kind: 'need', category: 'food', description: '沒有縣市', amount: 20,
      }),
      /縣市/,
    );
    const taipei = env.services.createPost(author.id, {
      kind: 'need', category: 'food', description: '公館便當', amount: 40,
      city: '台北市', district: '大安區',
    });
    const kaohsiung = env.services.createPost(author.id, {
      kind: 'offer', category: 'transport', description: '可以共乘', amount: 50,
      city: '高雄市',
    });
    env.db.prepare(`
      INSERT INTO posts (author_id, kind, category, description, amount, status, created_at)
      VALUES (?, 'need', 'other', '舊貼文沒有縣市', 10, 'open', '2026-10-01T00:00:00.000Z')
    `).run(author.id);

    const all = env.services.listOpenPosts();
    assert.equal(all.length, 3);
    const onlyTaipei = env.services.listOpenPosts({ city: '臺北市' });
    assert.deepEqual(onlyTaipei.map((post) => post.id), [taipei.id]);
    assert.equal(onlyTaipei[0].district, '大安區');
    const food = env.services.listOpenPosts({ category: 'food' });
    assert.deepEqual(food.map((post) => post.id), [taipei.id]);
    assert.equal(env.services.listOpenPosts({ city: '高雄市' })[0].id, kaohsiung.id);

    env.services.updateAccountPlace(author.id, { city: '台中市', district: '西區' });
    const saved = env.services.findByMobile('0912100001');
    assert.equal(saved.city, '臺中市');
    assert.equal(saved.district, '西區');
    assert.throws(() => env.services.updateAccountPlace(author.id, { district: '某區' }), /先選擇縣市/);
  } finally {
    env.close();
  }
});
