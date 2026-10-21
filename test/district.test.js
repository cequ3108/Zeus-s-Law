const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { CITIES, DISTRICTS, normalizeDistrict, placeLabel } = require('../src/places');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-district-'));
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

function post(env, authorId, fields) {
  return env.services.createPost(authorId, {
    kind: 'offer',
    category: 'food',
    description: fields.title,
    title: fields.title,
    amount: fields.amount || 10,
    city: fields.city,
    district: fields.district,
    meeting_mode: fields.meeting_mode,
  });
}

test('鄉鎮市區清單跟縣市對得上', () => {
  assert.equal(CITIES.length, 22);
  assert.deepEqual(Object.keys(DISTRICTS), CITIES);
  let total = 0;
  for (const city of CITIES) {
    assert.equal(new Set(DISTRICTS[city]).size, DISTRICTS[city].length);
    total += DISTRICTS[city].length;
  }
  assert.equal(total, 368);
  assert.equal(DISTRICTS['雲林縣'].includes('虎尾鎮'), true);
  assert.equal(DISTRICTS['雲林縣'].includes('大安區'), false);
  assert.equal(DISTRICTS['臺北市'].includes('大安區'), true);
  assert.equal(DISTRICTS['臺中市'].includes('大安區'), true);
  assert.equal(DISTRICTS['臺中市'].includes('西區'), true);
  assert.equal(normalizeDistrict('虎尾鎮', '雲林縣'), '虎尾鎮');
  assert.equal(normalizeDistrict('台西鄉', '雲林縣'), '臺西鄉');
  assert.equal(normalizeDistrict('', '雲林縣'), null);
  assert.throws(() => normalizeDistrict('大安區', '雲林縣'), /這個縣市/);
  assert.throws(() => normalizeDistrict('虎尾鎮', null), /先選擇縣市/);
  assert.equal(placeLabel('雲林縣', '虎尾鎮'), '雲林縣・虎尾鎮');
  assert.equal(placeLabel('雲林縣', null), '雲林縣');
  assert.equal(placeLabel(null, '虎尾鎮'), '');
});

test('舊資料沒有鄉鎮仍是 NULL，縣市篩選還看得到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-district-old-'));
  const file = path.join(dir, 'old.db');
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      mobile TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      merit INTEGER NOT NULL,
      quota INTEGER NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      block_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL,
      accepter_id INTEGER,
      host_id INTEGER,
      seeker_id INTEGER,
      kind TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      city TEXT
    );
    INSERT INTO users (mobile, display_name, role, merit, quota, blocked, created_at)
    VALUES ('0912777001', '舊帳號', 'user', 70, 130, 0, '2026-10-01T00:00:00.000Z');
    INSERT INTO posts (author_id, kind, category, description, amount, status, created_at, city)
    VALUES (1, 'offer', 'food', '舊便當', 10, 'open', '2026-10-01T00:00:00.000Z', '雲林縣');
  `);
  legacy.close();
  const db = openDatabase(file);
  try {
    const user = db.prepare('SELECT merit, quota, city, district FROM users WHERE mobile = ?').get('0912777001');
    assert.equal(user.merit, 70);
    assert.equal(user.quota, 130);
    assert.equal(user.district, null);
    const row = db.prepare('SELECT city, district, description FROM posts WHERE author_id = 1').get();
    assert.equal(row.city, '雲林縣');
    assert.equal(row.district, null);
    assert.equal(row.description, '舊便當');
    const services = createServices(db);
    const listed = services.listOpenPosts({ city: '雲林縣' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].district, null);
    assert.equal(placeLabel(listed[0].city, listed[0].district), '雲林縣');
    assert.equal(services.listOpenPosts({ city: '雲林縣', district: '虎尾鎮' }).length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('鄉鎮篩選只留下那個鄉鎮，也能跟種類一起算', () => {
  const env = setup();
  try {
    const author = env.services.register('0912777002', '在雲林');
    post(env, author.id, { title: '虎尾便當', city: '雲林縣', district: '虎尾鎮' });
    post(env, author.id, { title: '斗六便當', city: '雲林縣', district: '斗六市' });
    post(env, author.id, { title: '虎尾共乘', city: '雲林縣', district: '虎尾鎮', amount: 12 });
    env.db.prepare(`UPDATE posts SET category = 'transport' WHERE title = '虎尾共乘'`).run();
    post(env, author.id, { title: '台北便當', city: '臺北市', district: '大安區' });
    env.db.prepare(`
      INSERT INTO posts (author_id, kind, category, description, amount, status, created_at, city, title)
      VALUES (?, 'offer', 'food', '沒填鄉鎮', 8, 'open', '2026-10-02T00:00:00.000Z', '雲林縣', '沒填鄉鎮')
    `).run(author.id);

    const huwei = env.services.listOpenPosts({ city: '雲林縣', district: '虎尾鎮' }).map((item) => item.title);
    assert.deepEqual(huwei.sort(), ['虎尾便當', '虎尾共乘']);
    const county = env.services.listOpenPosts({ city: '雲林縣' }).map((item) => item.title);
    assert.equal(county.includes('沒填鄉鎮'), true);
    assert.equal(county.includes('斗六便當'), true);
    assert.equal(county.includes('台北便當'), false);
    const food = env.services.listOpenPosts({ city: '雲林縣', district: '虎尾鎮', category: 'food' });
    assert.deepEqual(food.map((item) => item.title), ['虎尾便當']);
    assert.equal(env.services.listOpenPosts({ city: '臺北市', district: '虎尾鎮' }).length, 0);
    const mine = env.services.listOpenPosts({
      localCity: '雲林縣',
      localDistrict: '虎尾鎮',
      category: 'food',
    });
    assert.deepEqual(mine.map((item) => item.title), ['虎尾便當']);
  } finally {
    env.close();
  }
});

function cookieJar() {
  const cookies = new Map();
  return {
    absorb(response) {
      const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const item of list) {
        const pair = item.split(';')[0];
        const index = pair.indexOf('=');
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
    header() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    },
  };
}

async function request(base, jar, urlPath, form) {
  const headers = {};
  if (jar && jar.header()) headers.cookie = jar.header();
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form);
  }
  const response = await fetch(base + urlPath, {
    method: form ? 'POST' : 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  if (jar) jar.absorb(response);
  return { status: response.status, text: await response.text(), location: response.headers.get('location') };
}

function csrfOf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)[1];
}

test('縣市和鄉鎮對不上會被拒絕，沒設定鄉鎮就沒有快捷篩選', async () => {
  const env = setup();
  const password = 'password-ok';
  const owner = env.services.registerWithPassword('0912777003', '主人', password, password);
  env.services.registerWithPassword('0912777004', '還沒填', password, password);
  const app = createApp({ db: env.db, sessionSecret: 'district-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = cookieJar();
  const other = cookieJar();
  try {
    assert.throws(
      () => env.services.createPost(owner.id, {
        kind: 'offer', category: 'food', city: '雲林縣', district: '大安區',
        description: '錯的鄉鎮', title: '錯的鄉鎮', amount: 10,
      }),
      /這個縣市/,
    );
    assert.throws(
      () => env.services.updateAccountPlace(owner.id, { city: '雲林縣', district: '大安區' }),
      /這個縣市/,
    );
    assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
    assert.equal(env.services.findByMobile('0912777003').district, null);

    const login = await request(base, jar, '/login');
    const logged = await request(base, jar, '/login/password', {
      _csrf: csrfOf(login.text),
      mobile: '0912777003',
      password,
    });
    assert.equal(logged.status, 302);
    const before = await request(base, jar, '/posts/new');
    assert.equal(before.text.includes('只看我的鄉鎮'), false);
    const rejected = await request(base, jar, '/posts', {
      _csrf: csrfOf(before.text),
      kind: 'offer',
      category: 'food',
      city: '雲林縣',
      district: '大安區',
      amount: '10',
      description: '不該存下來',
      title: '不該存下來',
    });
    assert.equal(rejected.status, 302);
    assert.equal(rejected.location, '/posts/new');
    const again = await request(base, jar, rejected.location);
    assert.match(again.text, /請選擇這個縣市裡的鄉鎮市區/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);

    const account = await request(base, jar, '/account');
    const saved = await request(base, jar, '/account', {
      _csrf: csrfOf(account.text),
      city: '雲林縣',
      district: '虎尾鎮',
      availability: '',
    });
    assert.equal(saved.status, 302);
    const profile = await request(base, jar, `/users/${owner.id}`);
    assert.match(profile.text, /雲林縣・虎尾鎮/);
    assert.equal(profile.text.includes('地址'), false);

    const form = await request(base, jar, '/posts/new');
    assert.match(form.text, /option value="虎尾鎮" data-city="雲林縣" selected/);
    assert.match(form.text, /可以不填/);
    const created = await request(base, jar, '/posts', {
      _csrf: csrfOf(form.text),
      kind: 'offer',
      category: 'food',
      city: '雲林縣',
      district: '虎尾鎮',
      amount: '10',
      description: '虎尾的便當',
      title: '虎尾的便當',
    });
    assert.equal(created.status, 302);
    const page = await request(base, jar, created.location);
    assert.match(page.text, /雲林縣・虎尾鎮/);

    env.services.createPost(owner.id, {
      kind: 'offer', category: 'food', city: '雲林縣', district: '斗六市',
      description: '斗六的便當', title: '斗六的便當', amount: 8,
    });
    const home = await request(base, jar, '/?city=all&local=1&category=food&q=' + encodeURIComponent('便當'));
    assert.match(home.text, /只看我的鄉鎮/);
    assert.match(home.text, /虎尾的便當/);
    assert.equal(home.text.includes('斗六的便當'), false);
    assert.match(home.text, /雲林縣・虎尾鎮/);
    assert.match(home.text, /name="local" value="1" checked/);
    assert.match(home.text, /href="\/\?city=all&amp;category=food&amp;local=1"/);

    const otherLogin = await request(base, other, '/login');
    await request(base, other, '/login/password', {
      _csrf: csrfOf(otherLogin.text),
      mobile: '0912777004',
      password,
    });
    const plain = await request(base, other, '/?city=all');
    assert.equal(plain.text.includes('只看我的鄉鎮'), false);
    const guest = await request(base, null, '/?city=all');
    assert.equal(guest.text.includes('只看我的鄉鎮'), false);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});
