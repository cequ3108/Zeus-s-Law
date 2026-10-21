const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { asset } = require('../src/assets');

function fileVersion(name) {
  const body = fs.readFileSync(path.join(__dirname, '..', 'public', name));
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

test('head.ejs 的樣式表網址帶啟動時算出的內容雜湊', async () => {
  const cssVersion = fileVersion('styles.css');
  const iconVersion = fileVersion('favicon.svg');
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/partials/head.ejs'), {
    title: '登入',
    compactAuth: false,
    asset,
  });
  assert.match(html, new RegExp(`href="/styles.css\\?v=${cssVersion}"`));
  assert.match(html, new RegExp(`href="/favicon.svg\\?v=${iconVersion}"`));
  assert.equal(asset('/styles.css'), `/styles.css?v=${cssVersion}`);

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zeus-asset-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = createApp({ db, sessionSecret: 'asset-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${base}/login`);
    const text = await page.text();
    assert.match(text, new RegExp(`href="/styles.css\\?v=${cssVersion}"`));
    const css = await fetch(`${base}/styles.css?v=${cssVersion}`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('cache-control'), /max-age=31536000/);
    assert.match(css.headers.get('cache-control'), /immutable/);
    await css.text();
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
