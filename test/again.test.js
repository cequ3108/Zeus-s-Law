const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const draft = require('../public/draft');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-again-'));
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

const fields = {
  kind: 'offer',
  category: 'food',
  title: '熱便當',
  description: '一份熱便當就好。',
  amount: 30,
  city: '高雄市',
  district: '前金區',
  meeting_mode: '超商',
  meeting_place: '公館捷運站',
  meeting_time: '週六下午三點',
  expires_hours: 24,
  slots: ['週末白天', '平日晚上'],
};

test('再發一次只讀自己已結束的貼文，不帶時間', () => {
  const env = setup();
  try {
    const author = env.services.register('0912888201', '作者');
    const other = env.services.register('0912888202', '別人');
    const post = env.services.createPost(author.id, fields);
    env.services.acceptPost(post.id, other.id);
    env.services.submitValue(post.id, author.id, 10);
    const settled = env.services.submitValue(post.id, other.id, 10);
    assert.equal(settled.status, 'settled');
    const before = env.db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);

    const source = env.services.repeatSource(post.id, author.id);
    assert.equal(source.title, '熱便當');
    assert.equal(source.description, '一份熱便當就好。');
    assert.equal(source.category, 'food');
    assert.equal(source.amount, 30);
    assert.equal(source.city, '高雄市');
    assert.equal(source.district, '前金區');
    assert.equal(source.meetingMode, '超商');
    assert.equal(source.meetingPlace, '公館捷運站');
    assert.equal(source.slots, '平日晚上,週末白天');
    assert.equal(source.meetingTime, undefined);
    assert.equal(source.expiresAt, undefined);
    assert.equal(env.services.repeatSource(post.id, other.id), null);
    assert.deepEqual(env.db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id), before);

    const open = env.services.createPost(author.id, { ...fields, title: '還在招募' });
    assert.equal(env.services.repeatSource(open.id, author.id), null);
    const matched = env.services.createPost(author.id, { ...fields, title: '進行中' });
    env.services.acceptPost(matched.id, other.id);
    assert.equal(env.services.repeatSource(matched.id, author.id), null);

    const expired = env.services.createPost(author.id, { ...fields, title: '過期便當' });
    env.db.prepare(`UPDATE posts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(expired.id);
    assert.equal(env.services.repeatSource(expired.id, author.id).title, '過期便當');
    const dropped = env.services.createPost(author.id, { ...fields, title: '已取消這則' });
    env.services.cancelPost(dropped.id, author.id);
    assert.equal(env.services.repeatSource(dropped.id, author.id).title, '已取消這則');
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(post.id).status, 'settled');
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

function cardOf(html, title) {
  const start = html.indexOf(title);
  assert.notEqual(start, -1, title);
  const article = html.lastIndexOf('<article', start);
  return html.slice(article, html.indexOf('</article>', start));
}

test('再發一次帶入舊欄位、清空時間，送出才產生新貼文', async () => {
  const env = setup();
  const password = 'password-ok';
  const author = env.services.registerWithPassword('0912888203', '作者', password, password);
  const seeker = env.services.registerWithPassword('0912888204', '客人', password, password);
  env.services.updateAccountPlace(author.id, { city: '臺北市', district: '大安區' });
  const created = env.services.createPost(author.id, fields);
  env.services.toggleBookmark(author.id, created.id);
  env.services.acceptPost(created.id, seeker.id);
  env.services.submitValue(created.id, author.id, 10);
  env.services.submitValue(created.id, seeker.id, 10);
  env.services.rate(created.id, author.id, 5, '謝謝');
  const before = env.db.prepare('SELECT * FROM posts WHERE id = ?').get(created.id);
  const beforeRatings = env.db.prepare('SELECT * FROM ratings WHERE post_id = ?').all(created.id);
  const beforeBookmark = env.db.prepare('SELECT * FROM bookmarks WHERE post_id = ?').all(created.id);
  const open = env.services.createPost(author.id, { ...fields, title: '還在招募', amount: 12 });
  const dropped = env.services.createPost(author.id, { ...fields, title: '已取消這則', amount: 11 });
  env.services.cancelPost(dropped.id, author.id);
  const expired = env.services.createPost(author.id, { ...fields, title: '過期便當', amount: 9 });
  env.db.prepare(`UPDATE posts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(expired.id);
  const matched = env.services.createPost(author.id, { ...fields, title: '進行中的', amount: 8 });
  env.services.acceptPost(matched.id, seeker.id);

  const app = createApp({ db: env.db, sessionSecret: 'again-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const authorJar = cookieJar();
  const seekerJar = cookieJar();
  try {
    const login = await request(base, authorJar, '/login');
    await request(base, authorJar, '/login/password', {
      _csrf: csrfOf(login.text),
      mobile: '0912888203',
      password,
    });
    const mine = await request(base, authorJar, '/me');
    const listed = mine.text.slice(mine.text.indexOf('我參與的互助'));
    assert.match(cardOf(listed, '熱便當'), new RegExp(`href="/posts/new\\?from=${created.id}"`));
    assert.match(cardOf(listed, '熱便當'), /再發一次/);
    assert.match(cardOf(listed, '已取消這則'), /再發一次/);
    assert.match(cardOf(listed, '過期便當'), /再發一次/);
    assert.equal(cardOf(listed, '還在招募').includes('再發一次'), false);
    assert.equal(cardOf(listed, '進行中的').includes('再發一次'), false);

    const page = await request(base, authorJar, `/posts/${created.id}`);
    assert.match(page.text, new RegExp(`href="/posts/new\\?from=${created.id}"`));
    const guest = await request(base, null, `/posts/${created.id}`);
    assert.equal(guest.text.includes('再發一次'), false);

    const seekerLogin = await request(base, seekerJar, '/login');
    await request(base, seekerJar, '/login/password', {
      _csrf: csrfOf(seekerLogin.text),
      mobile: '0912888204',
      password,
    });
    const theirs = await request(base, seekerJar, `/posts/${created.id}`);
    assert.equal(theirs.text.includes('再發一次'), false);
    const theirList = await request(base, seekerJar, '/me');
    assert.equal(theirList.text.includes('再發一次'), false);
    const stolen = await request(base, seekerJar, `/posts/new?from=${created.id}`);
    assert.equal(stolen.text.includes('熱便當'), false);
    assert.equal(stolen.text.includes('data-repeat'), false);

    const form = await request(base, authorJar, `/posts/new?from=${created.id}`);
    assert.match(form.text, /data-repeat="1"/);
    assert.match(form.text, /value="offer" checked/);
    assert.match(form.text, /value="food" selected/);
    assert.match(form.text, /value="熱便當"/);
    assert.match(form.text, /一份熱便當就好。/);
    assert.match(form.text, /value="30"/);
    assert.match(form.text, /value="高雄市" selected/);
    assert.match(form.text, /value="前金區" data-city="高雄市" selected/);
    assert.match(form.text, /value="超商" selected/);
    assert.match(form.text, /value="公館捷運站"/);
    assert.match(form.text, /id="meeting_time" name="meeting_time" maxlength="80" value=""/);
    assert.match(form.text, /name="slots" value="平日晚上" checked/);
    assert.match(form.text, /name="slots" value="週末白天" checked/);
    const hours = form.text.slice(form.text.indexOf('id="expires_hours"'), form.text.indexOf('id="description"'));
    assert.match(hours, /value="" selected/);
    assert.equal(/value="24"[^>]*selected/.test(hours), false);
    assert.equal(/value="48"[^>]*selected/.test(hours), false);

    const countBefore = env.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count;
    const rejected = await request(base, authorJar, '/posts', {
      _csrf: csrfOf(form.text),
      kind: 'offer',
      category: 'food',
      title: '熱便當',
      description: '請發現金',
      amount: '30',
      city: '高雄市',
      district: '前金區',
      expires_hours: '72',
    });
    assert.equal(rejected.status, 302);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, countBefore);
    assert.deepEqual(env.db.prepare('SELECT * FROM posts WHERE id = ?').get(created.id), before);

    const sent = await request(base, authorJar, '/posts', {
      _csrf: csrfOf(form.text),
      kind: 'offer',
      category: 'food',
      title: '熱便當',
      description: '一份熱便當就好。',
      amount: '30',
      city: '高雄市',
      district: '前金區',
      meeting_mode: '超商',
      meeting_place: '公館捷運站',
      meeting_time: '',
      expires_hours: '72',
      slots: ['平日晚上', '週末白天'],
    });
    assert.equal(sent.status, 302);
    const nextId = Number(String(sent.location).split('/').pop());
    assert.notEqual(nextId, created.id);
    const fresh = env.db.prepare('SELECT * FROM posts WHERE id = ?').get(nextId);
    assert.equal(fresh.status, 'open');
    assert.equal(fresh.title, '熱便當');
    assert.equal(fresh.description, '一份熱便當就好。');
    assert.equal(fresh.amount, 30);
    assert.equal(fresh.city, '高雄市');
    assert.equal(fresh.district, '前金區');
    assert.equal(fresh.meeting_mode, '超商');
    assert.equal(fresh.meeting_place, '公館捷運站');
    assert.equal(fresh.meeting_time, null);
    assert.equal(fresh.slots, '平日晚上,週末白天');
    assert.equal(fresh.settled_amount, null);
    const span = new Date(fresh.expires_at) - new Date(fresh.created_at);
    assert.equal(span, 72 * 60 * 60 * 1000);
    assert.deepEqual(env.db.prepare('SELECT * FROM posts WHERE id = ?').get(created.id), before);
    assert.deepEqual(env.db.prepare('SELECT * FROM ratings WHERE post_id = ?').all(created.id), beforeRatings);
    assert.deepEqual(env.db.prepare('SELECT * FROM bookmarks WHERE post_id = ?').all(created.id), beforeBookmark);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM ratings WHERE post_id = ?').get(nextId).count, 0);
    const authorRow = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(author.id);
    const seekerRow = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(seeker.id);
    assert.equal(authorRow.merit, 110);
    assert.equal(authorRow.quota, 110);
    assert.equal(seekerRow.merit, 90);
    assert.equal(seekerRow.quota, 110);
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(open.id).status, 'open');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});

test('再發一次的表單不會被舊草稿蓋掉', () => {
  const storage = {
    getItem() { return JSON.stringify({ title: '草稿標題', meeting_time: '明天' }); },
    setItem() {},
    removeItem() {},
    key() { return null; },
    get length() { return 0; },
  };
  const title = { type: 'text', value: '熱便當' };
  const time = { type: 'text', value: '' };
  const form = {
    getAttribute(name) {
      if (name === 'data-draft-user') return '4';
      if (name === 'data-repeat') return '1';
      return null;
    },
    elements: {
      namedItem(name) {
        if (name === 'title') return title;
        if (name === 'meeting_time') return time;
        return { type: 'text', value: '' };
      },
    },
    addEventListener() {},
  };
  draft.mount({
    body: { getAttribute() { return null; } },
    defaultView: { addEventListener() {} },
    querySelector(selector) {
      if (selector === 'form[data-draft-user]') return form;
      return null;
    },
  }, { storage, setTimer() { return 1; }, clearTimer() {} });
  assert.equal(title.value, '熱便當');
  assert.equal(time.value, '');
});
