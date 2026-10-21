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
  const app = createApp({ db, sessionSecret: 'task-secret', cookieSecure: false });
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
}

function titles(html) {
  return [...html.matchAll(/<h3><a href="\/posts\/\d+(?:#rate)?">([^<]+)/g)].map((match) => match[1]);
}

function tasks(html) {
  return [...html.matchAll(/data-task="([^"]+)"/g)].map((match) => match[1]);
}

const postBase = {
  kind: 'offer',
  category: 'food',
  city: '臺北市',
  amount: 10,
  description: '一份便當',
};

test('我的交易把待辦放最上面，並在連結顯示件數', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-tasks-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
  const app = await listen(db);
  try {
    const author = services.registerWithPassword('0912555001', '發布的人', 'author-password', 'author-password');
    const helper = services.registerWithPassword('0912555002', '幫忙的人', 'helper-password', 'helper-password');
    const settled = services.createPost(author.id, { ...postBase, title: '要評的' });
    services.acceptPost(settled.id, helper.id);
    services.submitValue(settled.id, author.id, 8);
    assert.equal(services.submitValue(settled.id, helper.id, 12).status, 'settled');
    const waiting = services.createPost(author.id, { ...postBase, title: '等對方的' });
    services.acceptPost(waiting.id, helper.id);
    assert.equal(services.submitValue(waiting.id, author.id, 10).status, 'waiting');
    services.createPost(author.id, { ...postBase, title: '最新開放' });

    const authorJar = cookieJar();
    await signIn(app.base, authorJar, '0912555001', 'author-password');
    const mine = await request(app.base, authorJar, '/me');
    assert.deepEqual(titles(mine.text), ['要評的', '最新開放', '等對方的']);
    assert.deepEqual(tasks(mine.text), ['待評分', '等對方填']);
    assert.match(mine.text, /我的交易 \(1\)/);
    assert.match(mine.text, />我的交易 \(1\)</);
    assert.match(mine.text, /href="\/posts\/\d+#rate"/);

    const helperJar = cookieJar();
    await signIn(app.base, helperJar, '0912555002', 'helper-password');
    const theirs = await request(app.base, helperJar, '/me');
    assert.deepEqual(titles(theirs.text), ['等對方的', '要評的']);
    assert.deepEqual(tasks(theirs.text), ['待填估價', '待評分']);
    assert.match(theirs.text, /我的交易 \(2\)/);

    services.rate(settled.id, author.id, 5, '');
    const after = await request(app.base, authorJar, '/me');
    assert.deepEqual(tasks(after.text), ['等對方填']);
    assert.equal(after.text.includes('我的交易 ('), false);
    const still = await request(app.base, helperJar, '/me');
    assert.match(still.text, /我的交易 \(2\)/);
  } finally {
    await close(app.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('估價結算後帶到評分，配對中的雙方看得到步驟', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-rate-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
  const app = await listen(db);
  try {
    const author = services.registerWithPassword('0912555011', '發布的人', 'author-password', 'author-password');
    const helper = services.registerWithPassword('0912555012', '幫忙的人', 'helper-password', 'helper-password');
    services.registerWithPassword('0912555013', '路人', 'other-password', 'other-password');
    const post = services.createPost(author.id, { ...postBase, title: '要結算的' });
    services.acceptPost(post.id, helper.id);
    const open = services.createPost(author.id, { ...postBase, title: '還開放的' });

    const authorJar = cookieJar();
    await signIn(app.base, authorJar, '0912555011', 'author-password');
    const matched = await request(app.base, authorJar, `/posts/${post.id}`);
    assert.match(matched.text, /id="settle-steps"/);
    assert.match(matched.text, /填齊就會結算，然後才能評分/);
    const openPage = await request(app.base, authorJar, `/posts/${open.id}`);
    assert.equal(openPage.text.includes('id="settle-steps"'), false);

    const first = await request(app.base, authorJar, `/posts/${post.id}/value`, {
      _csrf: csrfOf(matched.text),
      value: '30',
      confirm_done: '1',
    });
    assert.equal(first.status, 302);
    assert.equal(first.location, `/posts/${post.id}`);
    const waiting = await request(app.base, authorJar, first.location);
    assert.match(waiting.text, /等對方/);
    assert.equal(waiting.text.includes('id="rate"'), false);

    const otherJar = cookieJar();
    await signIn(app.base, otherJar, '0912555013', 'other-password');
    const stranger = await request(app.base, otherJar, `/posts/${post.id}`);
    assert.equal(stranger.text.includes('id="settle-steps"'), false);

    const helperJar = cookieJar();
    await signIn(app.base, helperJar, '0912555012', 'helper-password');
    const helperPage = await request(app.base, helperJar, `/posts/${post.id}`);
    assert.match(helperPage.text, /待對方|對方還沒填|id="settle-steps"/);
    const second = await request(app.base, helperJar, `/posts/${post.id}/value`, {
      _csrf: csrfOf(helperPage.text),
      value: '20',
      confirm_done: '1',
    });
    assert.equal(second.status, 302);
    assert.equal(second.location, `/posts/${post.id}#rate`);
    const settled = await request(app.base, helperJar, second.location.split('#')[0]);
    assert.match(settled.text, /結算完成，給對方星等吧/);
    assert.match(settled.text, /id="rate"/);
    assert.match(settled.text, /data-settled="20"/);
    const payer = db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(author.id);
    const receiver = db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(helper.id);
    assert.equal(payer.merit, 120);
    assert.equal(payer.quota, 120);
    assert.equal(receiver.merit, 80);
    assert.equal(receiver.quota, 120);
  } finally {
    await close(app.server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
