const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

const DAY = 24 * 60 * 60 * 1000;

function setup(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-extend-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, options);
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
  title: '熱湯',
  description: '可以分一碗熱湯。',
  amount: 10,
  city: '臺北市',
  expires_hours: 48,
};

function balances(db, userId) {
  return db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(userId);
}

function messageOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  assert.fail('應該要拒絕');
}

function withoutDeadline(row) {
  const copy = { ...row };
  delete copy.expires_at;
  delete copy.extended_count;
  return copy;
}

test('延長只改期限，超過 2 次、非本人和非招募中都會被擋', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-extend-old-'));
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
      city TEXT,
      expires_at TEXT
    );
    INSERT INTO users (mobile, display_name, role, merit, quota, blocked, created_at)
    VALUES ('0912888601', '舊帳號', 'user', 70, 130, 0, '2026-10-01T00:00:00.000Z');
    INSERT INTO posts (author_id, kind, category, description, amount, status, created_at, city, expires_at)
    VALUES (1, 'offer', 'food', '舊便當', 10, 'open', '2026-10-01T00:00:00.000Z', '臺北市', '2026-10-22T00:00:00.000Z');
  `);
  legacy.close();
  const migrated = openDatabase(file);
  try {
    const column = migrated.prepare(`PRAGMA table_info(posts)`).all().find((item) => item.name === 'extended_count');
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, '0');
    const row = migrated.prepare('SELECT description, extended_count FROM posts WHERE id = 1').get();
    assert.equal(row.description, '舊便當');
    assert.equal(row.extended_count, 0);
    assert.deepEqual(migrated.prepare('SELECT merit, quota FROM users WHERE id = 1').get(), { merit: 70, quota: 130 });
  } finally {
    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  let now = new Date('2026-10-21T04:00:00.000Z');
  const env = setup({ now: () => now });
  try {
    const author = env.services.register('0912888611', '作者');
    const other = env.services.register('0912888612', '別人');
    const post = env.services.createPost(author.id, fields);
    const before = env.db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    const ledger = env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
    assert.equal(before.extended_count, 0);

    assert.equal(messageOf(() => env.services.extendPost(post.id, author.id, 1)), '只能延長 3 天或 7 天。');
    const extended = env.services.extendPost(post.id, author.id, 3);
    assert.equal(extended.extendedCount, 1);
    const once = env.db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    assert.equal(new Date(once.expires_at) - new Date(before.expires_at), 3 * DAY);
    assert.equal(once.extended_count, 1);
    assert.equal(once.status, 'open');
    assert.deepEqual(withoutDeadline(once), withoutDeadline(before));
    assert.deepEqual(balances(env.db, author.id), { merit: 100, quota: 100 });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, ledger);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings').get().n, 0);

    env.services.extendPost(post.id, author.id, 7);
    const twice = env.db.prepare('SELECT expires_at, extended_count FROM posts WHERE id = ?').get(post.id);
    assert.equal(new Date(twice.expires_at) - new Date(before.expires_at), 10 * DAY);
    assert.equal(twice.extended_count, 2);
    assert.equal(messageOf(() => env.services.extendPost(post.id, author.id, 3)), '這則最多只能延長 2 次。');
    assert.deepEqual(env.db.prepare('SELECT expires_at, extended_count FROM posts WHERE id = ?').get(post.id), twice);

    const fresh = env.services.createPost(author.id, fields);
    assert.equal(messageOf(() => env.services.extendPost(fresh.id, other.id, 3)), '只有發文者可以延長。');
    assert.equal(env.db.prepare('SELECT extended_count FROM posts WHERE id = ?').get(fresh.id).extended_count, 0);

    const matched = env.services.createPost(author.id, { ...fields, title: '進行中' });
    env.services.acceptPost(matched.id, other.id);
    assert.equal(messageOf(() => env.services.extendPost(matched.id, author.id, 3)), '這則已經不能延長。');

    const dropped = env.services.createPost(author.id, { ...fields, title: '已取消' });
    env.services.cancelPost(dropped.id, author.id);
    assert.equal(messageOf(() => env.services.extendPost(dropped.id, author.id, 7)), '這則已經不能延長。');

    const expired = env.services.createPost(author.id, { ...fields, title: '已過期' });
    env.db.prepare(`UPDATE posts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(expired.id);
    assert.equal(messageOf(() => env.services.extendPost(expired.id, author.id, 3)), '這則已經不能延長。');

    const done = env.services.createPost(author.id, fields);
    env.services.extendPost(done.id, author.id, 3);
    env.services.acceptPost(done.id, other.id);
    env.services.submitValue(done.id, author.id, 10);
    const settled = env.services.submitValue(done.id, other.id, 10);
    assert.equal(settled.status, 'settled');
    assert.deepEqual(balances(env.db, author.id), { merit: 110, quota: 110 });
    assert.deepEqual(balances(env.db, other.id), { merit: 90, quota: 110 });
    const settledRow = env.db.prepare('SELECT extended_count, status FROM posts WHERE id = ?').get(done.id);
    assert.equal(settledRow.extended_count, 1);
    assert.equal(messageOf(() => env.services.extendPost(done.id, author.id, 7)), '這則已經不能延長。');
    assert.equal(env.db.prepare('SELECT extended_count FROM posts WHERE id = ?').get(done.id).extended_count, 1);
    assert.deepEqual(balances(env.db, author.id), { merit: 110, quota: 110 });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings').get().n, 0);
  } finally {
    env.close();
  }
});

test('快到期只算招募中且剩不到 24 小時', () => {
  let now = new Date('2026-10-21T00:00:00.000Z');
  const env = setup({ now: () => now });
  try {
    const author = env.services.register('0912888621', '作者');
    const other = env.services.register('0912888622', '別人');
    const exact = env.services.createPost(author.id, { ...fields, expires_hours: 24, title: '剛好一天' });
    const later = env.services.createPost(author.id, { ...fields, expires_hours: 48, title: '兩天' });
    const none = env.db.prepare(`
      INSERT INTO posts (author_id, kind, category, description, amount, status, created_at, city)
      VALUES (?, 'offer', 'food', '沒有期限', 10, 'open', ?, '臺北市')
    `).run(author.id, now.toISOString());
    const card = (title) => env.services.dashboard(author.id).posts.find((post) => post.title === title);

    assert.equal(card('剛好一天').expiringSoon, false);
    assert.equal(card('兩天').expiringSoon, false);
    assert.equal(env.services.expiringSoonCount(author.id), 0);

    now = new Date(now.getTime() + 1);
    assert.equal(card('剛好一天').expiringSoon, true);
    assert.equal(card('兩天').expiringSoon, false);
    assert.equal(env.services.expiringSoonCount(author.id), 1);
    assert.equal(env.services.dashboard(author.id).posts.find((post) => post.description === '沒有期限').expiringSoon, false);

    env.services.acceptPost(exact.id, other.id);
    assert.equal(card('剛好一天').expiringSoon, false);
    assert.equal(env.services.expiringSoonCount(author.id), 0);

    const soon = new Date(now.getTime() + 23 * 60 * 60 * 1000).toISOString();
    env.db.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').run(soon, later.id);
    assert.equal(card('兩天').expiringSoon, true);
    const edge = new Date(now.getTime() + DAY).toISOString();
    env.db.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').run(edge, later.id);
    assert.equal(card('兩天').expiringSoon, false);
    env.db.prepare(`UPDATE posts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(later.id);
    assert.equal(card('兩天').expiringSoon, false);
    assert.equal(env.services.expiringSoonCount(author.id), 0);
    assert.equal(Number(none.lastInsertRowid) > 0, true);
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
      if (value != null) body.append(key, value);
    }
  }
  const response = await fetch(base + urlPath, {
    method: form ? 'POST' : 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  if (jar) jar.absorb(response);
  return {
    status: response.status,
    text: await response.text(),
    location: response.headers.get('location'),
  };
}

function csrfOf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)[1];
}

async function signIn(base, jar, mobile) {
  const page = await request(base, jar, '/login');
  const logged = await request(base, jar, '/login/password', {
    _csrf: csrfOf(page.text),
    mobile,
    password: 'password-ok',
  });
  assert.equal(logged.status, 302);
}

test('我的交易顯示快到期，延長後數字會消失', async () => {
  const env = setup();
  const password = 'password-ok';
  const author = env.services.registerWithPassword('0912888631', '作者', password, password);
  const other = env.services.registerWithPassword('0912888632', '別人', password, password);
  const post = env.services.createPost(author.id, fields);
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  env.db.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').run(soon, post.id);
  const before = env.db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  const app = createApp({ db: env.db, sessionSecret: 'extend-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const authorJar = cookieJar();
    await signIn(base, authorJar, author.mobile);
    const mine = await request(base, authorJar, '/me');
    assert.match(mine.text, /快到期/);
    assert.match(mine.text, /延長3天/);
    assert.match(mine.text, /延長7天/);
    assert.match(mine.text, /data-expiring="1"/);
    const home = await request(base, authorJar, '/');
    assert.match(home.text, /data-expiring="1"/);

    const otherJar = cookieJar();
    await signIn(base, otherJar, other.mobile);
    const foreign = await request(base, otherJar, `/posts/${post.id}`);
    assert.equal(foreign.text.includes('延長3天'), false);
    assert.equal(foreign.text.includes('data-expiring='), false);
    const denied = await request(base, otherJar, `/posts/${post.id}/extend`, {
      _csrf: csrfOf(foreign.text),
      days: '3',
    });
    assert.equal(denied.status, 302);
    const deniedPage = await request(base, otherJar, `/posts/${post.id}`);
    assert.match(deniedPage.text, /只有發文者可以延長。/);
    assert.equal(env.db.prepare('SELECT extended_count FROM posts WHERE id = ?').get(post.id).extended_count, 0);

    const stale = await request(base, authorJar, `/posts/${post.id}/extend`, { days: '3', return: '/me' });
    assert.equal(stale.status, 303);
    assert.equal(env.db.prepare('SELECT extended_count FROM posts WHERE id = ?').get(post.id).extended_count, 0);

    const extended = await request(base, authorJar, `/posts/${post.id}/extend`, {
      _csrf: csrfOf(mine.text),
      days: '3',
      return: '/me',
    });
    assert.equal(extended.status, 302);
    assert.equal(extended.location, '/me');
    const after = env.db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    assert.equal(after.extended_count, 1);
    assert.equal(new Date(after.expires_at) - new Date(before.expires_at), 3 * DAY);
    assert.deepEqual(withoutDeadline(after), withoutDeadline(before));
    const cleared = await request(base, authorJar, '/me');
    assert.match(cleared.text, /已延長 3 天。/);
    assert.equal(cleared.text.includes('快到期'), false);
    assert.equal(cleared.text.includes('data-expiring='), false);
    assert.deepEqual(balances(env.db, author.id), { merit: 100, quota: 100 });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings').get().n, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});
