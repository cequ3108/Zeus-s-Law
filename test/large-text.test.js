const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const largeText = require('../public/large-text');
const { BOOT_SCRIPT, contentSecurityPolicy } = require('../src/large-text-boot');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { asset } = require('../src/assets');

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

function classList() {
  const set = new Set();
  return {
    contains(name) { return set.has(name); },
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : !!force;
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
  };
}

function button(kind) {
  const attrs = { 'aria-pressed': 'false', 'data-large-text': kind };
  const listeners = [];
  return {
    textContent: kind === 'label' ? '開啟大字模式' : '大字',
    classList: classList(),
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    addEventListener(type, fn) { if (type === 'click') listeners.push(fn); },
    click() { listeners.forEach((fn) => fn()); },
  };
}

function fakeDocument(buttons) {
  return {
    documentElement: { classList: classList() },
    querySelectorAll(selector) {
      return selector === '[data-large-text]' ? buttons : [];
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
  const app = createApp({ db, sessionSecret: 'large-text-secret', cookieSecure: false });
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
    csp: response.headers.get('content-security-policy'),
  };
}

function csrfOf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)[1];
}

test('大字開關會加上和拿掉類別，而且記在這支瀏覽器', () => {
  const storage = memoryStorage();
  const header = button('');
  const account = button('label');
  const page = fakeDocument([header, account]);
  largeText.mount(page, storage);
  assert.equal(page.documentElement.classList.contains('large-text'), false);
  assert.equal(header.getAttribute('aria-pressed'), 'false');
  assert.equal(account.textContent, '開啟大字模式');

  account.click();
  assert.equal(page.documentElement.classList.contains('large-text'), true);
  assert.equal(storage.getItem(largeText.KEY), '1');
  assert.equal(header.getAttribute('aria-pressed'), 'true');
  assert.equal(header.classList.contains('is-on'), true);
  assert.equal(account.getAttribute('aria-pressed'), 'true');
  assert.equal(account.textContent, '關閉大字模式');

  header.click();
  assert.equal(page.documentElement.classList.contains('large-text'), false);
  assert.equal(storage.getItem(largeText.KEY), null);
  assert.equal(account.textContent, '開啟大字模式');
  assert.equal(header.getAttribute('aria-pressed'), 'false');

  storage.setItem(largeText.KEY, '1');
  const again = fakeDocument([button(''), button('label')]);
  largeText.mount(again, storage);
  assert.equal(again.documentElement.classList.contains('large-text'), true);
  assert.equal(again.querySelectorAll('[data-large-text]')[1].textContent, '關閉大字模式');
  assert.equal(largeText.read(memoryStorage()), false);
});

test('頁面在繪製前套用大字，內容安全政策允許這段程式', async () => {
  const hash = crypto.createHash('sha256').update(BOOT_SCRIPT).digest('base64');
  assert.ok(contentSecurityPolicy().includes(`script-src 'self' 'sha256-${hash}'`));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-large-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
  const password = 'large-password';
  services.registerWithPassword('0912555001', '讀者', password, password);
  const app = await listen(db);
  const jar = cookieJar();
  try {
    const home = await request(app.base, jar, '/');
    assert.equal(home.status, 200);
    assert.ok(home.csp.includes(`'sha256-${hash}'`));
    assert.ok(home.text.includes(`<script>${BOOT_SCRIPT}</script>`));
    const scriptAt = home.text.indexOf(BOOT_SCRIPT);
    const styleAt = home.text.indexOf('rel="stylesheet"');
    assert.ok(scriptAt >= 0 && scriptAt < styleAt);
    assert.match(home.text, /class="large-text-toggle"/);
    assert.match(home.text, />大字</);
    assert.match(home.text, new RegExp(`src="${asset('/large-text.js').replace('?', '\\?')}"`));

    const login = await request(app.base, jar, '/login');
    const logged = await request(app.base, jar, '/login/password', {
      _csrf: csrfOf(login.text),
      mobile: '0912555001',
      password,
    });
    assert.equal(logged.status, 302);
    const account = await request(app.base, jar, '/account');
    assert.match(account.text, /大字模式/);
    assert.match(account.text, /data-large-text="label"/);
    assert.match(account.text, /開啟大字模式/);
    assert.match(account.text, /name="city"/);
  } finally {
    await close(app.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
