const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

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
  return { status: response.status, text: await response.text(), location: response.headers.get('location') };
}

test('底部分頁有四個入口，未登入會先去登入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-tabs-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = createApp({ db, sessionSecret: 'test-secret', cookieSecure: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = cookieJar();
  try {
    const home = await request(base, jar, '/');
    assert.match(home.text, /class="tabbar"/);
    assert.match(home.text, />首頁</);
    assert.match(home.text, /href="\/login\?next=\/posts\/new"/);
    assert.match(home.text, /href="\/login\?next=\/me"/);
    assert.match(home.text, /href="\/login\?next=\/account"/);
    assert.match(home.text, /開發模式/);

    const account = await request(base, jar, '/account');
    assert.equal(account.status, 302);
    assert.equal(account.location, '/login');

    const services = require('../src/services').createServices(db);
    services.registerWithPassword('0918333001', '分頁人', 'tab-password', 'tab-password');
    const login = await request(base, jar, '/login');
    const csrf = login.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const signed = await request(base, jar, '/login/password', {
      _csrf: csrf,
      mobile: '0918333001',
      password: 'tab-password',
    });
    assert.equal(signed.status, 302);
    const page = await request(base, jar, '/account');
    assert.equal(page.status, 200);
    assert.match(page.text, /我的帳號/);
    assert.match(page.text, /0918333001/);
    assert.match(page.text, /href="\/me"/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
