const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function cookieJar() {
  const cookies = new Map();
  return {
    absorb(response) {
      const list = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
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

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function request(base, jar, urlPath, { form } = {}) {
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
    cookies: typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [],
  };
}

function csrfOf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, '頁面應有 CSRF');
  return match[1];
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-auth-'));
  const db = openDatabase(path.join(dir, 't.db'));
  return { dir, db, services: createServices(db) };
}

test('登入頁只有密碼登入，記住我會保留 30 天並記住手機號碼', async () => {
  const env = setup();
  const password = 'remember-password';
  env.services.registerWithPassword('0912444001', '記得我', password, password);
  const jar = cookieJar();
  const app = await listen(createApp({ db: env.db, sessionSecret: 'remember-secret', cookieSecure: false }));
  try {
    const page = await request(app.base, jar, '/login');
    assert.match(page.text, /autocomplete="username"/);
    assert.match(page.text, /autocomplete="current-password"/);
    assert.match(page.text, /name="remember" value="1" checked/);
    assert.match(page.text, /href="\/join"/);
    assert.match(page.text, /href="\/forgot"/);
    assert.equal(page.text.includes('用驗證碼登入'), false);
    const forgot = await request(app.base, jar, '/forgot');
    assert.match(forgot.text, /用驗證碼登入/);
    assert.match(forgot.text, /href="\/login\/code"/);
    assert.equal(page.text.includes('name="display_name"'), false);
    assert.equal(page.text.includes('action="/join"'), false);
    assert.equal(page.text.includes('請不要留下真實個資'), false);
    assert.match(page.text, /示範站，驗證碼顯示在畫面上/);
    const home = await request(app.base, cookieJar(), '/');
    assert.match(home.text, /請不要留下真實個資/);

    const logged = await request(app.base, jar, '/login/password', {
      form: { _csrf: csrfOf(page.text), mobile: '0912444001', password, remember: '1' },
    });
    assert.equal(logged.status, 302);
    const sid = logged.cookies.find((item) => item.startsWith('zeus.sid='));
    const phone = logged.cookies.find((item) => item.startsWith('zeus.mobile='));
    assert.ok(sid);
    assert.match(sid, /Expires=/i);
    const expiresAt = new Date(sid.match(/Expires=([^;]+)/i)[1]).getTime();
    const days = (expiresAt - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 29 && days < 31, `cookie 應約 30 天，實際 ${days}`);
    assert.match(phone, /zeus\.mobile=0912444001/);
    assert.equal(logged.cookies.join('\n').includes(password), false);

    const me = await request(app.base, jar, '/me');
    await request(app.base, jar, '/logout', { form: { _csrf: csrfOf(me.text) } });
    const again = await request(app.base, jar, '/login');
    assert.match(again.text, /value="0912444001"/);
    assert.equal(again.text.includes(password), false);
  } finally {
    await close(app.server);
    env.db.close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test('沒勾記住我時 cookie 只活到瀏覽器關閉，工作階段仍寫進資料庫', async () => {
  const env = setup();
  const password = 'session-password';
  env.services.registerWithPassword('0912444002', '這次就好', password, password);
  const jar = cookieJar();
  const app = await listen(createApp({ db: env.db, sessionSecret: 'session-secret', cookieSecure: false }));
  try {
    const page = await request(app.base, jar, '/login');
    const logged = await request(app.base, jar, '/login/password', {
      form: { _csrf: csrfOf(page.text), mobile: '0912444002', password },
    });
    assert.equal(logged.status, 302);
    const sid = logged.cookies.find((item) => item.startsWith('zeus.sid='));
    assert.ok(sid);
    assert.equal(/Expires=/i.test(sid), false);
    assert.equal(/Max-Age=/i.test(sid), false);
    assert.equal(logged.cookies.join('\n').includes(password), false);
    const me = await request(app.base, jar, '/me');
    assert.match(me.text, /這次就好/);
    const row = env.db.prepare('SELECT expire, sess FROM sessions').get();
    assert.ok(row);
    assert.ok(row.expire > Date.now());
    assert.equal(row.sess.includes(password), false);
  } finally {
    await close(app.server);
    env.db.close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test('忘記密碼用驗證碼換成新密碼，餘額不變，也不存明文', async () => {
  const env = setup();
  const oldPassword = 'old-password';
  const newPassword = 'new-password';
  const user = env.services.registerWithPassword('0912444003', '忘記的人', oldPassword, oldPassword);
  const jar = cookieJar();
  const app = await listen(createApp({ db: env.db, sessionSecret: 'forgot-secret', cookieSecure: false }));
  try {
    const forgot = await request(app.base, jar, '/forgot');
    assert.match(forgot.text, /忘記密碼/);
    const sent = await request(app.base, jar, '/forgot', {
      form: { _csrf: csrfOf(forgot.text), mobile: '0912444003' },
    });
    assert.equal(sent.status, 302);
    assert.equal(sent.location, '/forgot/reset');
    const reset = await request(app.base, jar, '/forgot/reset');
    const code = reset.text.match(/id="dev-code">(\d{6})</)[1];
    const done = await request(app.base, jar, '/forgot/reset', {
      form: {
        _csrf: csrfOf(reset.text),
        code,
        password: newPassword,
        password_confirm: newPassword,
      },
    });
    assert.equal(done.status, 302);
    assert.equal(done.location, '/account');
    const account = await request(app.base, jar, '/account');
    assert.match(account.text, /忘記的人/);
    const stored = env.db.prepare('SELECT password_hash, merit, quota FROM users WHERE id = ?').get(user.id);
    assert.equal(stored.merit, 100);
    assert.equal(stored.quota, 100);
    assert.equal(stored.password_hash.includes(newPassword), false);
    assert.equal(stored.password_hash.includes(oldPassword), false);
    const sessions = env.db.prepare('SELECT sess FROM sessions').all();
    assert.equal(sessions.some((row) => row.sess.includes(newPassword)), false);

    await request(app.base, jar, '/logout', { form: { _csrf: csrfOf(account.text) } });
    const login = await request(app.base, jar, '/login');
    const rejected = await request(app.base, jar, '/login/password', {
      form: { _csrf: csrfOf(login.text), mobile: '0912444003', password: oldPassword, remember: '1' },
    });
    assert.equal(rejected.status, 302);
    assert.equal(rejected.location, '/login');
    const fresh = await request(app.base, jar, '/login');
    const accepted = await request(app.base, jar, '/login/password', {
      form: { _csrf: csrfOf(fresh.text), mobile: '0912444003', password: newPassword, remember: '1' },
    });
    assert.equal(accepted.status, 302);
    assert.equal(accepted.location, '/me');
  } finally {
    await close(app.server);
    env.db.close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test('創辦人可重設暫時密碼，一般使用者不行，餘額與明文都留不住', async () => {
  const env = setup();
  const oldPassword = 'member-password';
  const member = env.services.registerWithPassword('0912444004', '被重設的人', oldPassword, oldPassword);
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912444005',
    FOUNDER_PASSWORD: 'founder-password',
  });
  const founderJar = cookieJar();
  const memberJar = cookieJar();
  const app = await listen(createApp({ db: env.db, sessionSecret: 'founder-secret', cookieSecure: false }));
  try {
    const memberLogin = await request(app.base, memberJar, '/login');
    await request(app.base, memberJar, '/login/password', {
      form: {
        _csrf: csrfOf(memberLogin.text),
        mobile: '0912444004',
        password: oldPassword,
        remember: '1',
      },
    });
    const memberPage = await request(app.base, memberJar, '/me');
    const denied = await request(app.base, memberJar, '/admin/password', {
      form: { _csrf: csrfOf(memberPage.text), mobile: '0912444005' },
    });
    assert.equal(denied.status, 403);
    assert.equal(env.services.loginWithPassword('0912444005', 'founder-password').role, 'founder');

    const founderLogin = await request(app.base, founderJar, '/login');
    await request(app.base, founderJar, '/login/password', {
      form: {
        _csrf: csrfOf(founderLogin.text),
        mobile: '0912444005',
        password: 'founder-password',
        remember: '1',
      },
    });
    const admin = await request(app.base, founderJar, '/admin');
    const reset = await request(app.base, founderJar, '/admin/password', {
      form: { _csrf: csrfOf(admin.text), mobile: '0912444004' },
    });
    assert.equal(reset.status, 200);
    const temporary = reset.text.match(/id="temporary-password">([^<]+)</)[1];
    assert.ok(temporary.length >= 8);
    const stored = env.db.prepare('SELECT password_hash, merit, quota FROM users WHERE id = ?').get(member.id);
    assert.equal(stored.merit, 100);
    assert.equal(stored.quota, 100);
    assert.equal(stored.password_hash.includes(temporary), false);
    const sessions = env.db.prepare('SELECT sess FROM sessions').all();
    assert.equal(sessions.some((row) => row.sess.includes(temporary)), false);
    assert.throws(() => env.services.loginWithPassword('0912444004', oldPassword), /不正確/);
    assert.equal(env.services.loginWithPassword('0912444004', temporary).id, member.id);
  } finally {
    await close(app.server);
    env.db.close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});
