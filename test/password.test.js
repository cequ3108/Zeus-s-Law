const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase, resolveDbPath } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/password');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-pw-'));
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

test('密碼只存 scrypt 雜湊，明文對不上欄位', () => {
  const env = setup();
  try {
    const user = env.services.registerWithPassword('0912000201', '阿明', '這是測試用的密碼', '這是測試用的密碼');
    const row = env.db.prepare('SELECT password_hash, merit, quota, role FROM users WHERE id = ?').get(user.id);
    assert.equal(row.role, 'user');
    assert.equal(row.merit, 100);
    assert.equal(row.quota, 100);
    assert.equal(row.password_hash.includes('這是測試用的密碼'), false);
    assert.match(row.password_hash, /^scrypt\$/);
    assert.equal(verifyPassword('這是測試用的密碼', row.password_hash), true);
    assert.equal(verifyPassword('wrong-password', row.password_hash), false);
    const again = hashPassword('這是測試用的密碼');
    assert.notEqual(again, row.password_hash);
  } finally {
    env.close();
  }
});

test('密碼登入成功，錯的密碼或太短的註冊會被拒絕', () => {
  const env = setup();
  try {
    env.services.registerWithPassword('0912000202', '阿花', 'flower-password', 'flower-password');
    const user = env.services.loginWithPassword('0912000202', 'flower-password');
    assert.equal(user.display_name, '阿花');
    assert.throws(() => env.services.loginWithPassword('0912000202', 'wrong-password'), /不正確/);
    assert.throws(() => env.services.loginWithPassword('0912000999', 'flower-password'), /不正確/);
    assert.throws(() => env.services.registerWithPassword('0912000203', '新人', '短', '短'), /8 到 64/);
    assert.throws(
      () => env.services.registerWithPassword('0912000203', '新人', 'flower-password', 'other-password'),
      /不一樣/,
    );
  } finally {
    env.close();
  }
});

test('環境變數只在第一次建立創辦人，再次啟動不補餘額', () => {
  const env = setup();
  try {
    const created = env.services.ensureFounderFromEnv({
      FOUNDER_PHONE: '0912000301',
      FOUNDER_PASSWORD: 'founder-login-1',
    });
    assert.equal(created.status, 'created');
    const founder = env.services.findByMobile('0912000301');
    assert.equal(founder.role, 'founder');
    assert.equal(founder.merit, 100_000_000);
    assert.equal(founder.quota, 100_000_000);
    assert.equal(founder.password_hash.includes('founder-login-1'), false);

    env.db.prepare('UPDATE users SET merit = merit - 50, quota = quota WHERE id = ?').run(founder.id);
    const updated = env.services.ensureFounderFromEnv({
      FOUNDER_PHONE: '0912000301',
      FOUNDER_PASSWORD: 'founder-login-2',
    });
    assert.equal(updated.status, 'updated');
    const again = env.services.findByMobile('0912000301');
    assert.equal(again.merit, 100_000_000 - 50);
    assert.equal(again.quota, 100_000_000);
    assert.equal(env.services.loginWithPassword('0912000301', 'founder-login-2').id, founder.id);
    assert.throws(() => env.services.loginWithPassword('0912000301', 'founder-login-1'), /不正確/);

    assert.equal(env.services.ensureFounderFromEnv({}).status, 'skipped');
    assert.equal(env.services.ensureFounderFromEnv({ FOUNDER_PHONE: '0912000302' }).status, 'incomplete');

    env.services.register('0912000303', '普通人');
    const conflict = env.services.ensureFounderFromEnv({
      FOUNDER_PHONE: '0912000303',
      FOUNDER_PASSWORD: 'do-not-promote',
    });
    assert.equal(conflict.status, 'conflict');
    assert.equal(env.services.findByMobile('0912000303').role, 'user');
    assert.equal(env.services.findByMobile('0912000303').merit, 100);
  } finally {
    env.close();
  }
});

test('舊資料庫補上 password_hash 後，原有餘額還在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-migrate-'));
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
    VALUES ('0912000401', '舊帳號', 'user', 70, 130, 0, '2026-10-01T00:00:00.000Z');
  `);
  legacy.close();

  const db = openDatabase(file);
  try {
    const row = db.prepare('SELECT merit, quota, password_hash FROM users WHERE mobile = ?').get('0912000401');
    assert.equal(row.merit, 70);
    assert.equal(row.quota, 130);
    assert.equal(row.password_hash, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DATA_DIR 決定資料庫路徑，DB_PATH 優先', () => {
  assert.equal(resolveDbPath({ DATA_DIR: '/var/zeus' }), path.join('/var/zeus', 'zeus.db'));
  assert.equal(resolveDbPath({ DATA_DIR: '/var/zeus', DB_PATH: '/other/app.db' }), '/other/app.db');
});

test('沒有簡訊時可以用手機與密碼註冊並登入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-http-pw-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = createApp({ db, sessionSecret: 'test-secret', cookieSecure: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {
    cookies: new Map(),
    absorb(response) {
      const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const item of list) {
        const pair = item.split(';')[0];
        const index = pair.indexOf('=');
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
    header() {
      return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    },
  };

  async function request(urlPath, form) {
    const headers = {};
    if (jar.header()) headers.cookie = jar.header();
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form);
    }
    const response = await fetch(base + urlPath, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
    jar.absorb(response);
    return { status: response.status, text: await response.text(), location: response.headers.get('location') };
  }

  try {
    const page = await request('/login');
    assert.match(page.text, /建立帳號/);
    assert.equal(page.text.includes('value="founder"'), false);
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const joined = await request('/join', {
      _csrf: csrf,
      mobile: '0918111222',
      display_name: '手機新人',
      password: 'mobile-password',
      password_confirm: 'mobile-password',
      role: 'founder',
    });
    assert.equal(joined.status, 302);
    const me = await request(joined.location);
    assert.match(me.text, /一般使用者/);
    assert.match(me.text, /data-merit="100"/);
    assert.equal(me.text.includes('100000000'), false);
    const stored = db.prepare('SELECT password_hash, role FROM users WHERE mobile = ?').get('0918111222');
    assert.equal(stored.role, 'user');
    assert.equal(stored.password_hash.includes('mobile-password'), false);

    await request('/logout', { _csrf: me.text.match(/name="_csrf" value="([^"]+)"/)[1] });
    const loginPage = await request('/login');
    const logged = await request('/login/password', {
      _csrf: loginPage.text.match(/name="_csrf" value="([^"]+)"/)[1],
      mobile: '0918111222',
      password: 'mobile-password',
    });
    assert.equal(logged.status, 302);
    const back = await request('/me');
    assert.match(back.text, /手機新人/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
