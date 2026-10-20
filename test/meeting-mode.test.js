const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const draft = require('../public/draft');
const { MEETING_MODES, PUBLIC_MEETING_MODES, HOME_VISIT_MODE, HOME_VISIT_NOTE } = require('../src/constants');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-meet-'));
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

function post(env, authorId, extra = {}) {
  return env.services.createPost(authorId, {
    kind: 'need',
    category: 'food',
    description: '便當一份',
    amount: 20,
    city: '臺北市',
    ...extra,
  });
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
  };
}

test('見面方式可以存進貼文再讀出來', () => {
  const env = setup();
  try {
    const author = env.services.register('0912888001', '作者');
    const saved = post(env, author.id, { title: '超商便當', meeting_mode: '超商' });
    const row = env.db.prepare('SELECT meeting_mode FROM posts WHERE id = ?').get(saved.id);
    assert.equal(row.meeting_mode, '超商');
    assert.equal(env.services.listOpenPosts()[0].meeting_mode, '超商');
    assert.equal(env.services.postPage(saved.id, null).meetingMode, '超商');

    const blank = post(env, author.id, { title: '沒選', meeting_mode: '   ' });
    assert.equal(env.db.prepare('SELECT meeting_mode FROM posts WHERE id = ?').get(blank.id).meeting_mode, null);

    const omitted = post(env, author.id, { title: '沒帶欄位' });
    assert.equal(env.services.postPage(omitted.id, null).meetingMode, null);

    const before = env.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    assert.throws(
      () => post(env, author.id, { meeting_mode: '住家' }),
      /見面方式/,
    );
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, before);

    const visit = post(env, author.id, { title: '到府便當', meeting_mode: HOME_VISIT_MODE });
    const again = env.services.repostPost(visit.id, author.id);
    assert.equal(env.db.prepare('SELECT meeting_mode FROM posts WHERE id = ?').get(again.id).meeting_mode, HOME_VISIT_MODE);

    const storage = memoryStorage();
    draft.save(storage, author.id, { title: '草稿便當', meeting_mode: '公園或廣場' });
    assert.equal(draft.load(storage, author.id).meeting_mode, '公園或廣場');
    assert.equal(draft.FIELDS.includes('meeting_mode'), true);
  } finally {
    env.close();
  }
});

test('舊貼文見面方式留白，只看公共場所時排除空白和其他方式', () => {
  const env = setup();
  try {
    const author = env.services.register('0912888002', '作者');
    const titles = {
      超商: '超商標題',
      車站或捷運站: '車站標題',
      公園或廣場: '公園標題',
      公家機關或福利機構: '機關標題',
      到府或上門: '到府標題',
      線上或不需見面: '線上標題',
      其他: '其他標題',
    };
    for (const mode of MEETING_MODES) {
      post(env, author.id, { title: titles[mode], meeting_mode: mode });
    }
    env.db.prepare(`
      INSERT INTO posts (author_id, kind, category, description, amount, status, created_at, city, title)
      VALUES (?, 'need', 'food', '舊貼文沒有見面方式', 10, 'open', '2026-10-01T00:00:00.000Z', '臺北市', '舊貼文標題')
    `).run(author.id);

    const all = env.services.listOpenPosts();
    assert.equal(all.length, 8);
    const old = all.find((item) => item.title === '舊貼文標題');
    assert.equal(old.meeting_mode, null);
    assert.equal(env.services.postPage(old.id, null).meetingMode, null);

    const filtered = env.services.listOpenPosts({ publicMeeting: true });
    assert.deepEqual(
      filtered.map((item) => item.meeting_mode).sort(),
      [...PUBLIC_MEETING_MODES].sort(),
    );
    assert.equal(filtered.some((item) => item.meeting_mode == null), false);
    assert.equal(filtered.some((item) => item.title === '到府標題'), false);
    assert.equal(filtered.some((item) => item.title === '線上標題'), false);
    assert.equal(filtered.some((item) => item.title === '其他標題'), false);
  } finally {
    env.close();
  }
});

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
  const app = createApp({ db, sessionSecret: 'meeting-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function request(base, jar, urlPath, form) {
  const headers = {};
  if (jar && jar.header()) headers.cookie = jar.header();
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form);
  }
  const response = await fetch(base + urlPath, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
  if (jar) jar.absorb(response);
  return { status: response.status, text: await response.text(), location: response.headers.get('location') };
}

function csrfOf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, '頁面應有 CSRF');
  return match[1];
}

async function login(base, jar, mobile, name) {
  let page = await request(base, jar, '/login/code');
  let response = await request(base, jar, '/login', { _csrf: csrfOf(page.text), mobile });
  assert.equal(response.status, 302);
  page = await request(base, jar, response.location);
  const code = page.text.match(/id="dev-code">(\d{6})</)[1];
  response = await request(base, jar, '/verify', { _csrf: csrfOf(page.text), code });
  if (response.location.endsWith('/register')) {
    page = await request(base, jar, '/register');
    response = await request(base, jar, '/register', {
      _csrf: csrfOf(page.text), display_name: name, role: 'user',
    });
  }
  return response;
}

test('到府或上門才顯示公共場所提醒，首頁篩選只留公共場所', async () => {
  const env = setup();
  const web = await listen(env.db);
  try {
    const author = env.services.register('0912888003', '作者');
    const visit = post(env, author.id, { title: '到府便當', meeting_mode: HOME_VISIT_MODE });
    const store = post(env, author.id, { title: '超商便當', meeting_mode: '超商' });
    const other = post(env, author.id, { title: '其他便當', meeting_mode: '其他' });
    const online = post(env, author.id, { title: '線上便當', meeting_mode: '線上或不需見面' });
    const info = env.db.prepare(`
      INSERT INTO posts (author_id, kind, category, description, amount, status, created_at, city, title)
      VALUES (?, 'need', 'food', '舊貼文沒有見面方式', 10, 'open', '2026-10-01T00:00:00.000Z', '臺北市', '舊貼文標題')
    `).run(author.id);

    const guest = await request(web.base, null, `/posts/${visit.id}`);
    assert.equal(guest.text.includes(HOME_VISIT_NOTE), true);
    assert.equal(guest.text.includes('data-home-visit'), true);
    assert.ok(guest.text.indexOf('登入後接下') > guest.text.indexOf('data-home-visit'));

    for (const item of [store, other, online, { id: Number(info.lastInsertRowid) }]) {
      const page = await request(web.base, null, `/posts/${item.id}`);
      assert.equal(page.text.includes(HOME_VISIT_NOTE), false, item.id);
      assert.equal(page.text.includes('data-home-visit'), false);
    }
    const storePage = await request(web.base, null, `/posts/${store.id}`);
    assert.equal(storePage.text.includes('data-meeting-mode="超商"'), true);

    const helperJar = cookieJar();
    await login(web.base, helperJar, '0912888004', '幫手');
    const taken = await request(web.base, helperJar, `/posts/${visit.id}`);
    const warningAt = taken.text.indexOf('data-home-visit');
    const buttonAt = taken.text.indexOf('接下這則');
    assert.ok(warningAt !== -1);
    assert.ok(buttonAt > warningAt);
    assert.equal(taken.text.includes(HOME_VISIT_NOTE), true);

    const home = await request(web.base, null, '/?city=all');
    assert.equal(home.text.includes('只看公共場所見面'), true);
    assert.equal(home.text.includes('name="public"'), true);
    assert.equal(home.text.includes('data-meeting-mode="超商"'), true);
    assert.equal(home.text.includes('到府便當'), true);
    assert.equal(home.text.includes('舊貼文標題'), true);

    const filtered = await request(web.base, null, '/?city=all&public=1');
    assert.equal(filtered.text.includes('checked'), true);
    assert.equal(filtered.text.includes('超商便當'), true);
    assert.equal(filtered.text.includes('到府便當'), false);
    assert.equal(filtered.text.includes('其他便當'), false);
    assert.equal(filtered.text.includes('線上便當'), false);
    assert.equal(filtered.text.includes('舊貼文標題'), false);

    const authorJar = cookieJar();
    await login(web.base, authorJar, '0912888003', '作者');
    const form = await request(web.base, authorJar, '/posts/new');
    const block = form.text.slice(form.text.indexOf('id="meeting_mode"'), form.text.indexOf('id="meeting_place"'));
    assert.equal(block.includes('selected'), false);
    for (const mode of MEETING_MODES) assert.equal(block.includes(`value="${mode}"`), true);
    assert.equal(block.includes('可以不選'), true);
  } finally {
    await close(web.server);
    env.close();
  }
});
