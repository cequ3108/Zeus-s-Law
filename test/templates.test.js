const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { templatesFor } = require('../src/templates');

test('機構看不到共乘這種提供模板', () => {
  const labels = templatesFor('org').map((item) => item.label);
  assert.equal(labels.includes('共乘'), false);
  assert.equal(labels.includes('便當'), true);
  assert.equal(templatesFor('user').some((item) => item.kind === 'offer'), true);
});

test('模板帶出的標題會存進貼文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-tpl-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
  try {
    const user = services.register('0912200001', '模板人');
    const template = templatesFor('user').find((item) => item.id === 'bento');
    const post = services.createPost(user.id, {
      kind: template.kind,
      category: template.category,
      title: template.title,
      description: template.description,
      amount: template.min,
      city: '臺北市',
    });
    const row = db.prepare('SELECT title, description FROM posts WHERE id = ?').get(post.id);
    assert.equal(row.title, '需要一份便當');
    assert.match(row.description, /地點：/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('發文頁套用便當模板', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-tpl-http-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = createApp({ db, sessionSecret: 'test-secret', cookieSecure: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  async function request(urlPath, form) {
    const headers = {};
    if (cookies.size) headers.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form);
    }
    const response = await fetch(base + urlPath, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
    for (const item of response.headers.getSetCookie()) {
      const pair = item.split(';')[0];
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return { status: response.status, text: await response.text() };
  }
  try {
    const services = createServices(db);
    services.registerWithPassword('0912200002', '模板頁', 'template-pass', 'template-pass');
    const login = await request('/login');
    const csrf = login.text.match(/name="_csrf" value="([^"]+)"/)[1];
    await request('/login/password', { _csrf: csrf, mobile: '0912200002', password: 'template-pass' });
    const page = await request('/posts/new?template=bento');
    assert.match(page.text, /需要一份便當/);
    assert.match(page.text, /地點：/);
    assert.match(page.text, /建議 60–120/);
    assert.match(page.text, /value="need" checked/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
