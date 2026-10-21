const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const draft = require('../public/draft');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { SLOTS, parseSlots, normalizeSlots } = require('../src/slots');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-slots-'));
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

function post(env, authorId, fields) {
  return env.services.createPost(authorId, {
    kind: 'offer',
    category: 'food',
    description: fields.description || fields.title,
    title: fields.title,
    amount: fields.amount || 10,
    city: fields.city || '臺北市',
    slots: fields.slots,
  });
}

test('舊資料沒有時段仍是 NULL，功德和今日空檔不變', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-slots-old-'));
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
      availability TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL,
      accepter_id INTEGER,
      host_id INTEGER,
      seeker_id INTEGER,
      kind TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      city TEXT
    );
    INSERT INTO users (mobile, display_name, role, merit, quota, blocked, availability, created_at)
    VALUES ('0912888001', '舊帳號', 'user', 70, 130, 0, '今天早上', '2026-10-01T00:00:00.000Z');
    INSERT INTO posts (author_id, kind, category, description, amount, status, created_at, city)
    VALUES (1, 'offer', 'food', '舊便當', 10, 'open', '2026-10-01T00:00:00.000Z', '臺北市');
  `);
  legacy.close();
  const db = openDatabase(file);
  try {
    const user = db.prepare('SELECT merit, quota, availability, slots FROM users WHERE mobile = ?').get('0912888001');
    assert.equal(user.merit, 70);
    assert.equal(user.quota, 130);
    assert.equal(user.availability, '今天早上');
    assert.equal(user.slots, null);
    const row = db.prepare('SELECT description, slots FROM posts WHERE author_id = 1').get();
    assert.equal(row.description, '舊便當');
    assert.equal(row.slots, null);
    const services = createServices(db);
    const listed = services.listOpenPosts({ city: '臺北市' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].slots, null);
    const fitted = services.listOpenPosts({ fitSlots: ['平日晚上', '週末白天'] });
    assert.equal(fitted.length, 1);
    assert.equal(fitted[0].description, '舊便當');
    assert.equal(db.prepare('SELECT merit, quota, availability FROM users WHERE id = 1').get().availability, '今天早上');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('設定方便時段不會改到今日空檔或功德', () => {
  const env = setup();
  try {
    assert.deepEqual(SLOTS, ['平日白天', '平日晚上', '週末白天', '週末晚上']);
    const user = env.services.register('0912888002', '有空的人');
    env.services.updateAvailability(user.id, '今天 14:00–18:00');
    const before = env.db.prepare('SELECT merit, quota, availability FROM users WHERE id = ?').get(user.id);
    const saved = env.services.updateSlots(user.id, ['週末晚上', '平日白天', '平日白天']);
    assert.equal(saved.slots, '平日白天,週末晚上');
    assert.equal(normalizeSlots('  週末白天 , 平日晚上 '), '平日晚上,週末白天');
    assert.equal(normalizeSlots('   '), null);
    assert.equal(normalizeSlots([]), null);
    assert.deepEqual(parseSlots('不知道,平日晚上,凌晨'), ['平日晚上']);
    assert.throws(() => env.services.updateSlots(user.id, '凌晨'), /方便時段/);
    const after = env.db.prepare('SELECT merit, quota, availability, slots FROM users WHERE id = ?').get(user.id);
    assert.equal(after.merit, before.merit);
    assert.equal(after.quota, before.quota);
    assert.equal(after.availability, '今天 14:00–18:00');
    assert.equal(after.slots, '平日白天,週末晚上');
    env.services.updateSlots(user.id, undefined);
    assert.equal(env.db.prepare('SELECT availability, slots FROM users WHERE id = ?').get(user.id).slots, null);
    assert.equal(env.db.prepare('SELECT availability FROM users WHERE id = ?').get(user.id).availability, '今天 14:00–18:00');
  } finally {
    env.close();
  }
});

test('符合時段會留下沒填時段的貼文，也跟關鍵字一起算', () => {
  const env = setup();
  try {
    const author = env.services.register('0912888003', '發文的人');
    post(env, author.id, { title: '晚上便當', description: '晚上便當', slots: '平日晚上' });
    post(env, author.id, { title: '只有週末晚上', description: '只有週末晚上的便當', slots: '週末晚上' });
    post(env, author.id, { title: '白天也能', description: '白天便當', slots: ['平日白天', '週末白天'] });
    post(env, author.id, { title: '沒填時段', description: '沒填時段便當' });
    env.db.prepare(`UPDATE posts SET slots = '' WHERE title = '沒填時段'`).run();
    post(env, author.id, { title: '晚上共乘', description: '不是便當', slots: '平日晚上' });
    env.db.prepare(`UPDATE posts SET category = 'transport' WHERE title = '晚上共乘'`).run();
    const fit = ['平日晚上', '週末白天'];
    const titles = env.services.listOpenPosts({ fitSlots: fit }).map((item) => item.title);
    assert.deepEqual(new Set(titles), new Set(['晚上便當', '晚上共乘', '白天也能', '沒填時段']));
    assert.equal(titles.length, 4);
    const food = env.services.listOpenPosts({ fitSlots: fit, query: '便當', category: 'food' }).map((item) => item.title);
    assert.deepEqual(new Set(food), new Set(['晚上便當', '白天也能', '沒填時段']));
    assert.equal(food.length, 3);
    assert.equal(food.includes('只有週末晚上'), false);
  } finally {
    env.close();
  }
});

test('結算流程不因時段改變功德', () => {
  const env = setup();
  try {
    const host = env.services.register('0912888004', '主人');
    const seeker = env.services.register('0912888005', '客人');
    env.services.updateAvailability(host.id, '今天晚上');
    env.services.updateSlots(host.id, '平日晚上');
    env.services.updateAvailability(seeker.id, '明天下午');
    env.services.updateSlots(seeker.id, '週末白天');
    const created = post(env, host.id, { title: '結算便當', amount: 10, slots: '平日晚上,週末晚上' });
    env.services.acceptPost(created.id, seeker.id);
    env.services.submitValue(created.id, host.id, 10);
    const result = env.services.submitValue(created.id, seeker.id, 10);
    assert.equal(result.status, 'settled');
    assert.equal(result.amount, 10);
    const hostRow = env.db.prepare('SELECT merit, quota, availability, slots FROM users WHERE id = ?').get(host.id);
    const seekerRow = env.db.prepare('SELECT merit, quota, availability, slots FROM users WHERE id = ?').get(seeker.id);
    assert.equal(hostRow.merit, 110);
    assert.equal(hostRow.quota, 110);
    assert.equal(seekerRow.merit, 90);
    assert.equal(seekerRow.quota, 110);
    assert.equal(hostRow.availability, '今天晚上');
    assert.equal(hostRow.slots, '平日晚上');
    assert.equal(seekerRow.availability, '明天下午');
    assert.equal(seekerRow.slots, '週末白天');
    assert.equal(env.db.prepare('SELECT slots, status FROM posts WHERE id = ?').get(created.id).slots, '平日晚上,週末晚上');
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

async function request(base, jar, urlPath, form) {
  const headers = {};
  if (jar && jar.header()) headers.cookie = jar.header();
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (Array.isArray(value)) value.forEach((item) => body.append(key, item));
      else if (value != null) body.append(key, value);
    }
  }
  const response = await fetch(base + urlPath, {
    method: form ? 'POST' : 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  if (jar) jar.absorb(response);
  return { status: response.status, text: await response.text(), location: response.headers.get('location') };
}

function csrfOf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)[1];
}

function checkedSlots(html, legend) {
  const start = html.indexOf(legend);
  const block = html.slice(start, html.indexOf('</fieldset>', start));
  return [...block.matchAll(/name="slots" value="([^"]+)"([^>]*)>/g)].map((match) => ({
    value: match[1],
    checked: /\bchecked\b/.test(match[2]),
  }));
}

function checkboxGroup(selected) {
  const nodes = SLOTS.map((choice) => ({
    type: 'checkbox',
    value: choice,
    checked: selected.includes(choice),
  }));
  const group = { length: nodes.length };
  nodes.forEach((node, index) => { group[index] = node; });
  return group;
}

test('帳號、發文和廣場會顯示時段，沒設定就改成帳號頁提示', async () => {
  const env = setup();
  const password = 'password-ok';
  const owner = env.services.registerWithPassword('0912888010', '有時段', password, password);
  env.services.registerWithPassword('0912888011', '還沒選', password, password);
  env.services.updateAvailability(owner.id, '今天晚上');
  const app = createApp({ db: env.db, sessionSecret: 'slots-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = cookieJar();
  const other = cookieJar();
  try {
    const login = await request(base, jar, '/login');
    const logged = await request(base, jar, '/login/password', {
      _csrf: csrfOf(login.text),
      mobile: '0912888010',
      password,
    });
    assert.equal(logged.status, 302);

    const blank = await request(base, jar, '/');
    assert.match(blank.text, /只看符合我時段要先在<a href="\/account">帳號頁<\/a>/);
    assert.equal(blank.text.includes('name="fit"'), false);

    const account = await request(base, jar, '/account');
    assert.match(account.text, /方便互助時段（可以不選）/);
    assert.match(account.text, /今日空檔/);
    const saved = await request(base, jar, '/account', {
      _csrf: csrfOf(account.text),
      city: '臺北市',
      availability: '今天晚上',
      slots: ['週末晚上', '平日晚上'],
    });
    assert.equal(saved.status, 302);
    const again = await request(base, jar, '/account');
    assert.deepEqual(
      checkedSlots(again.text, '方便互助時段').filter((item) => item.checked).map((item) => item.value),
      ['平日晚上', '週末晚上'],
    );
    assert.match(again.text, /value="今天晚上"/);
    const row = env.db.prepare('SELECT merit, availability, slots FROM users WHERE id = ?').get(owner.id);
    assert.equal(row.merit, 100);
    assert.equal(row.availability, '今天晚上');
    assert.equal(row.slots, '平日晚上,週末晚上');

    const profile = await request(base, jar, `/users/${owner.id}`);
    assert.match(profile.text, /今日空檔：今天晚上/);
    assert.match(profile.text, /class="tag tag-slot">平日晚上</);
    assert.match(profile.text, /class="tag tag-slot">週末晚上</);

    const form = await request(base, jar, '/posts/new');
    assert.deepEqual(
      checkedSlots(form.text, '希望時段').filter((item) => item.checked).map((item) => item.value),
      ['平日晚上', '週末晚上'],
    );
    const created = await request(base, jar, '/posts', {
      _csrf: csrfOf(form.text),
      kind: 'offer',
      category: 'food',
      city: '臺北市',
      amount: '10',
      title: '晚上便當',
      description: '晚上便當',
      slots: '平日晚上',
    });
    assert.equal(created.status, 302);
    env.services.createPost(owner.id, {
      kind: 'offer', category: 'food', city: '臺北市', amount: 8,
      title: '任何時段', description: '任何時段便當',
    });
    env.services.createPost(owner.id, {
      kind: 'offer', category: 'food', city: '臺北市', amount: 8,
      title: '平日白天便當', description: '平日白天便當', slots: '平日白天',
    });
    const home = await request(base, jar, '/?city=all&category=food&fit=1&q=' + encodeURIComponent('便當'));
    assert.match(home.text, /name="fit" value="1" checked/);
    assert.match(home.text, /class="tag tag-slot">平日晚上</);
    assert.match(home.text, /晚上便當/);
    assert.match(home.text, /任何時段/);
    assert.equal(home.text.includes('平日白天便當'), false);
    assert.match(home.text, /href="\/\?city=all&amp;category=food&amp;fit=1"/);

    const page = await request(base, jar, created.location);
    assert.match(page.text, /class="tag tag-slot">平日晚上</);
    assert.match(page.text, /今日空檔 今天晚上/);

    const otherLogin = await request(base, other, '/login');
    await request(base, other, '/login/password', {
      _csrf: csrfOf(otherLogin.text),
      mobile: '0912888011',
      password,
    });
    const hint = await request(base, other, '/?city=all');
    assert.match(hint.text, /只看符合我時段要先在<a href="\/account">帳號頁<\/a>/);
    assert.equal(hint.text.includes('name="fit"'), false);
    const guest = await request(base, null, '/?city=all');
    assert.equal(guest.text.includes('只看符合我時段'), false);

    const seeker = env.services.findByMobile('0912888011');
    env.services.updateSlots(seeker.id, '週末白天');
    const postId = Number(created.location.split('/').pop());
    env.services.acceptPost(postId, seeker.id);
    const matched = await request(base, jar, created.location);
    assert.match(matched.text, /提供幫助的人[\s\S]*class="tag tag-slot">平日晚上</);
    assert.match(matched.text, /接受幫助的人[\s\S]*class="tag tag-slot">週末白天</);

    assert.equal(draft.FIELDS.includes('slots'), true);
    const group = checkboxGroup(['平日晚上']);
    const fields = { slots: group };
    const fake = {
      getAttribute() { return '7'; },
      elements: { namedItem(name) { return fields[name] || null; } },
    };
    assert.equal(draft.readForm(fake).slots, '平日晚上');
    draft.writeForm(fake, { slots: '週末白天,週末晚上' });
    assert.deepEqual(SLOTS.filter((slot) => group[SLOTS.indexOf(slot)].checked), ['週末白天', '週末晚上']);
    draft.writeForm(fake, { slots: '' });
    assert.equal(SLOTS.some((slot, index) => group[index].checked), false);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});
