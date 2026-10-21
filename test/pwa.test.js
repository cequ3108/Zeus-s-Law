const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { asset, manifest } = require('../src/assets');
const { shouldHandle, OFFLINE_HTML } = require('../public/sw-policy');

function pngSize(name) {
  const body = fs.readFileSync(path.join(__dirname, '..', 'public', name));
  assert.equal(body.toString('ascii', 1, 4), 'PNG');
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

function listen(db) {
  const app = createApp({ db, sessionSecret: 'pwa-secret', cookieSecure: false });
  const server = app.listen(0);
  return new Promise((resolve) => {
    server.once('listening', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function requestFor(method, url, { mode = 'navigate', cookie = '' } = {}) {
  return {
    method,
    mode,
    url,
    headers: { get: (name) => (name === 'cookie' ? cookie : '') },
  };
}

test('清單帶正確欄位，圖示與頁首都走版本網址', async () => {
  assert.equal(manifest.name, '宙斯法則');
  assert.equal(manifest.short_name, '宙斯法則');
  assert.equal(manifest.lang, 'zh-Hant');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.theme_color, '#9d1c1c');
  assert.equal(manifest.background_color, '#f3eadb');
  assert.deepEqual(
    manifest.icons.map((icon) => [icon.sizes, icon.purpose]),
    [
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['192x192', 'maskable'],
      ['512x512', 'maskable'],
    ],
  );
  for (const icon of manifest.icons) {
    assert.match(icon.src, /\?v=[0-9a-f]{12}$/);
  }
  assert.deepEqual(pngSize('icon-192.png'), { width: 192, height: 192 });
  assert.deepEqual(pngSize('icon-512.png'), { width: 512, height: 512 });
  assert.deepEqual(pngSize('icon-maskable-192.png'), { width: 192, height: 192 });
  assert.deepEqual(pngSize('icon-maskable-512.png'), { width: 512, height: 512 });
  assert.deepEqual(pngSize('apple-touch-icon.png'), { width: 180, height: 180 });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-pwa-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = await listen(db);
  try {
    const home = await fetch(`${app.base}/`);
    const html = await home.text();
    assert.match(html, /name="theme-color" content="#9d1c1c"/);
    assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(html, /name="apple-mobile-web-app-title" content="宙斯法則"/);
    assert.match(html, new RegExp(`rel="apple-touch-icon"[^>]*href="${asset('/apple-touch-icon.png').replace('?', '\\?')}"`));
    assert.match(html, new RegExp(`rel="manifest" href="${asset('/manifest.webmanifest').replace('?', '\\?')}"`));
    assert.match(html, new RegExp(`data-sw="${asset('/sw.js').replace('?', '\\?')}"`));

    const listed = await fetch(`${app.base}${asset('/manifest.webmanifest')}`);
    assert.equal(listed.status, 200);
    assert.match(listed.headers.get('content-type'), /application\/manifest\+json/);
    assert.deepEqual(await listed.json(), manifest);

    const rules = await fetch(`${app.base}/rules`);
    const rulesHtml = await rules.text();
    assert.match(rulesHtml, /如何加到主畫面/);
    assert.match(rulesHtml, /加入主畫面/);
    assert.match(rulesHtml, /安裝應用程式/);
    assert.match(rulesHtml, /data-install-prompt hidden/);
    assert.match(rulesHtml, /安裝到主畫面/);
    const installJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'install.js'), 'utf8');
    assert.match(installJs, /zeus-install-dismissed/);
    assert.match(installJs, /outcome !== 'dismissed'/);
  } finally {
    await close(app.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('服務工作不攔截非 GET 與已登入路徑，也不快取', async () => {
  assert.match(OFFLINE_HTML, /目前離線，請連上網路再試/);
  assert.equal(shouldHandle(requestFor('POST', 'https://zeus.example/')), false);
  assert.equal(shouldHandle(requestFor('POST', 'https://zeus.example/login')), false);
  assert.equal(shouldHandle(requestFor('POST', 'https://zeus.example/posts/9/settle')), false);
  assert.equal(shouldHandle(requestFor('PUT', 'https://zeus.example/')), false);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/login')), false);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/account')), false);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/me')), false);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/admin')), false);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/posts/new')), false);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/posts/9/settle')), false);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/', { cookie: 'zeus.sid=abc' })), false);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/rules', { cookie: 'zeus.mobile=0912000000' })), true);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/')), true);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/rules')), true);
  assert.equal(shouldHandle(requestFor('GET', 'https://zeus.example/styles.css', { mode: 'no-cors' })), false);

  const worker = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(worker, /shouldHandle\(event\.request\)/);
  assert.doesNotMatch(worker, /caches\.(open|put|match|add)/);
  assert.match(OFFLINE_HTML, /目前離線，請連上網路再試/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-pwa-sw-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = await listen(db);
  try {
    const sw = await fetch(`${app.base}/sw.js`);
    const body = await sw.text();
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('cache-control'), /no-cache/);
    assert.doesNotMatch(sw.headers.get('cache-control') || '', /immutable/);
    assert.match(body, /importScripts\('\/sw-policy\.js\?v=[0-9a-f]{12}'\)/);
    assert.doesNotMatch(body, /caches\.(open|put|match|add)/);
    const policy = await fetch(`${app.base}/sw-policy.js`);
    const policyBody = await policy.text();
    assert.match(policy.headers.get('cache-control'), /no-cache/);
    assert.match(policyBody, /目前離線，請連上網路再試/);
    assert.match(policyBody, /zeus\\.sid/);
  } finally {
    await close(app.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
