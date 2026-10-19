const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { RULES_PAGE, RULES_HIGHLIGHTS } = require('../src/rules-copy');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-rules-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
  return {
    dir, db, services,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

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

async function listen(db) {
  const app = createApp({ db, sessionSecret: 'rules-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function request(base, jar, urlPath, form) {
  const headers = {};
  if (jar.header()) headers.cookie = jar.header();
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
  jar.absorb(response);
  return {
    status: response.status,
    text: await response.text(),
    location: response.headers.get('location'),
  };
}

function csrfOf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)[1];
}

async function signIn(base, jar, mobile, password) {
  const page = await request(base, jar, '/login');
  const logged = await request(base, jar, '/login/password', {
    _csrf: csrfOf(page.text),
    mobile,
    password,
    remember: '1',
  });
  assert.equal(logged.status, 302);
  return logged;
}

test('規則與常見問題未登入也能看，個人頁進得去', async () => {
  const env = setup();
  const password = 'rules-password';
  const user = env.services.registerWithPassword('0912999701', '讀者', password, password);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    const page = await request(app.base, cookieJar(), '/rules');
    assert.equal(page.status, 200);
    assert.match(page.text, /規則與常見問題/);
    assert.match(page.text, /功德是什麼/);
    assert.match(page.text, /約等於 1 元新台幣/);
    assert.match(page.text, /不能買賣/);
    assert.match(page.text, /也不能兌現/);
    assert.match(page.text, /禁止收現金/);
    assert.match(page.text, /也禁止轉帳/);
    assert.match(page.text, /結算怎麼算/);
    assert.match(page.text, /較低者/);
    assert.match(page.text, /同一對人每天只加一次額度/);
    assert.match(page.text, /1 到 5 顆星/);
    assert.match(page.text, /超商、捷運站/);
    assert.match(page.text, /請聯絡創辦人/);
    assert.equal(page.text.includes('data-rules-gate'), false);
    assert.equal(RULES_PAGE.sections.some((section) => section.heading === '功德是什麼'), true);
    assert.equal(RULES_HIGHLIGHTS.length, 3);

    const home = await request(app.base, cookieJar(), '/');
    assert.match(home.text, /href="\/rules"/);
    await signIn(app.base, jar, '0912999701', password);
    const account = await request(app.base, jar, '/account');
    assert.match(account.text, /href="\/rules"/);
    const profile = await request(app.base, jar, `/users/${user.id}`);
    assert.match(profile.text, /href="\/rules"/);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('第一次登入出現重點，按我了解後不再出現，餘額不變', async () => {
  const env = setup();
  const password = 'rules-password';
  const user = env.services.registerWithPassword('0912999702', '新人', password, password);
  const other = env.services.registerWithPassword('0912999703', '另一人', password, password);
  const before = env.db.prepare('SELECT merit, quota, blocked FROM users WHERE id = ?').get(user.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    assert.equal(env.db.prepare('SELECT rules_acknowledged_at FROM users WHERE id = ?').get(user.id).rules_acknowledged_at, null);
    const logged = await signIn(app.base, jar, '0912999702', password);
    assert.equal(logged.location, '/me');
    const first = await request(app.base, jar, '/me');
    assert.match(first.text, /data-rules-gate/);
    assert.match(first.text, /禁止現金交易/);
    assert.match(first.text, /公共場所見面/);
    assert.match(first.text, /完成後記得互評/);
    assert.match(first.text, /href="\/rules">看完整規則/);
    assert.match(first.text, /我了解/);

    const stale = await request(app.base, jar, '/rules/ack', { return: '/me' });
    assert.equal(stale.status, 303);
    assert.equal(env.db.prepare('SELECT rules_acknowledged_at FROM users WHERE id = ?').get(user.id).rules_acknowledged_at, null);

    const acked = await request(app.base, jar, '/rules/ack', {
      _csrf: csrfOf(first.text),
      return: '/me',
    });
    assert.equal(acked.status, 302);
    assert.equal(acked.location, '/me');
    const stamp = env.db.prepare('SELECT rules_acknowledged_at FROM users WHERE id = ?').get(user.id).rules_acknowledged_at;
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(env.db.prepare('SELECT merit, quota, blocked FROM users WHERE id = ?').get(user.id), before);
    const second = await request(app.base, jar, '/me');
    assert.equal(second.text.includes('data-rules-gate'), false);
    assert.equal(second.text.includes('我了解'), false);

    const otherJar = cookieJar();
    await signIn(app.base, otherJar, '0912999703', password);
    const otherPage = await request(app.base, otherJar, '/me');
    assert.match(otherPage.text, /data-rules-gate/);
    assert.equal(env.db.prepare('SELECT rules_acknowledged_at FROM users WHERE id = ?').get(other.id).rules_acknowledged_at, null);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('舊資料庫補上規則確認時間後，原有餘額還在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-rules-old-'));
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
    INSERT INTO users (mobile, display_name, role, merit, quota, blocked, created_at)
    VALUES ('0912999704', '舊帳號', 'user', 70, 130, 0, '2026-10-01T00:00:00.000Z');
  `);
  legacy.close();
  const db = openDatabase(file);
  try {
    const row = db.prepare('SELECT merit, quota, rules_acknowledged_at FROM users WHERE mobile = ?').get('0912999704');
    assert.equal(row.merit, 70);
    assert.equal(row.quota, 130);
    assert.equal(row.rules_acknowledged_at, null);
    const services = createServices(db);
    const user = db.prepare('SELECT id FROM users WHERE mobile = ?').get('0912999704');
    services.acknowledgeRules(user.id);
    const after = db.prepare('SELECT merit, quota, rules_acknowledged_at FROM users WHERE id = ?').get(user.id);
    assert.equal(after.merit, 70);
    assert.equal(after.quota, 130);
    assert.ok(after.rules_acknowledged_at);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
