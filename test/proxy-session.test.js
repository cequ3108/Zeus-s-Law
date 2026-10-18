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
      for (const item of list) this.keep(item);
    },
    keep(item) {
      const pair = item.split(';')[0];
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
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

async function request(base, jar, urlPath, { form, proto = true } = {}) {
  const headers = {};
  if (proto) headers['x-forwarded-proto'] = 'https';
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

test('反向代理的 HTTPS 會寫下 Secure cookie，登入成功，重啟後工作階段還在', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-proxy-'));
  const db = openDatabase(path.join(dir, 't.db'));
  createServices(db).registerWithPassword('0912777001', '代理來的人', 'proxy-password', 'proxy-password');
  const jar = cookieJar();
  const first = await listen(createApp({ db, sessionSecret: 'proxy-secret' }));
  try {
    const page = await request(first.base, jar, '/login');
    assert.equal(page.status, 200);
    assert.equal(page.cookies.length > 0, true);
    assert.match(page.cookies.join(';'), /zeus\.sid=/);
    assert.match(page.cookies.join(';'), /Secure/i);
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const logged = await request(first.base, jar, '/login/password', {
      form: { _csrf: csrf, mobile: '0912777001', password: 'proxy-password' },
    });
    assert.equal(logged.status, 302);
    assert.equal(logged.location, '/me');
    const me = await request(first.base, jar, '/me');
    assert.match(me.text, /代理來的人/);
    assert.match(me.text, /data-merit="100"/);
  } finally {
    await close(first.server);
  }

  const second = await listen(createApp({ db, sessionSecret: 'proxy-secret' }));
  try {
    const again = await request(second.base, jar, '/me');
    assert.equal(again.status, 200);
    assert.match(again.text, /代理來的人/);
    const rows = db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    assert.equal(rows > 0, true);
  } finally {
    await close(second.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('反向代理的 HTTPS 可以註冊，並寫下 Secure cookie', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-proxy-join-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const jar = cookieJar();
  const app = await listen(createApp({ db, sessionSecret: 'proxy-join-secret' }));
  try {
    const page = await request(app.base, jar, '/login');
    assert.match(page.cookies.join(';'), /Secure/i);
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const joined = await request(app.base, jar, '/join', {
      form: {
        _csrf: csrf,
        mobile: '0912777003',
        display_name: '代理註冊',
        password: 'proxy-password',
        password_confirm: 'proxy-password',
      },
    });
    assert.equal(joined.status, 302);
    assert.equal(joined.location, '/me');
    const me = await request(app.base, jar, '/me');
    assert.match(me.text, /代理註冊/);
    assert.match(me.text, /data-merit="100"/);
  } finally {
    await close(app.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('沒有 cookie 的登入會回到登入表單，並帶新的工作階段', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-csrf-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = await listen(createApp({ db, sessionSecret: 'csrf-secret' }));
  const jar = cookieJar();
  try {
    const stale = await request(app.base, jar, '/login/password', {
      form: { _csrf: 'not-the-token', mobile: '0912777002', password: 'whatever-password' },
    });
    assert.equal(stale.status, 403);
    assert.match(stale.text, /請再送出一次/);
    assert.match(stale.text, /name="_csrf"/);
    assert.match(stale.text, /密碼登入/);
    assert.match(stale.cookies.join(';'), /zeus\.sid=/);
    assert.equal(stale.text.includes('表單已過期，請回上一頁'), false);
  } finally {
    await close(app.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('直接連 HTTP 仍會設定 cookie，而且不加 Secure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-http-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = await listen(createApp({ db, sessionSecret: 'http-secret' }));
  try {
    const response = await fetch(`${app.base}/login`);
    const cookies = response.headers.getSetCookie();
    assert.match(cookies.join(';'), /zeus\.sid=/);
    assert.equal(/;\s*Secure/i.test(cookies.join(';')), false);
    await response.text();
  } finally {
    await close(app.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
