const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-bookmark-'));
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
  const app = createApp({ db, sessionSecret: 'bookmark-secret', cookieSecure: false });
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

function openPost(services, authorId, title) {
  return services.createPost(authorId, {
    kind: 'offer',
    category: 'food',
    description: title,
    title,
    amount: 10,
    city: '臺北市',
  });
}

function bookmarkCount(db, userId, postId) {
  if (postId) {
    return db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ? AND post_id = ?').get(userId, postId).n;
  }
  return db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?').get(userId).n;
}

test('收藏與取消收藏', async () => {
  const env = setup();
  const password = 'bookmark-password';
  const author = env.services.registerWithPassword('0912999101', '作者', password, password);
  const reader = env.services.registerWithPassword('0912999102', '讀者', password, password);
  const post = openPost(env.services, author.id, '便當一份');
  const before = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(reader.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    const guest = await request(app.base, cookieJar(), `/posts/${post.id}`);
    assert.equal(guest.text.includes('aria-label="收藏"'), false);
    const guestHome = await request(app.base, cookieJar(), '/');
    assert.equal(guestHome.text.includes('aria-label="收藏"'), false);

    await signIn(app.base, jar, '0912999102', password);
    const home = await request(app.base, jar, '/');
    assert.match(home.text, /aria-label="收藏"/);
    assert.match(home.text, /data-bookmarked="0"/);
    const detail = await request(app.base, jar, `/posts/${post.id}`);
    assert.match(detail.text, /aria-label="收藏"/);
    const saved = await request(app.base, jar, `/posts/${post.id}/bookmark`, {
      _csrf: csrfOf(detail.text),
      return: `/posts/${post.id}`,
    });
    assert.equal(saved.status, 302);
    assert.equal(saved.location, `/posts/${post.id}`);
    assert.equal(bookmarkCount(env.db, reader.id, post.id), 1);
    assert.deepEqual(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(reader.id), before);
    const marked = await request(app.base, jar, `/posts/${post.id}`);
    assert.match(marked.text, /aria-label="取消收藏"/);
    assert.match(marked.text, /data-bookmarked="1"/);
    assert.equal(marked.text.includes('人收藏'), false);
    const mine = await request(app.base, jar, '/me');
    assert.match(mine.text, /我的收藏/);
    assert.match(mine.text, /便當一份/);
    const authorPage = await request(app.base, cookieJar(), `/users/${author.id}`);
    assert.equal(authorPage.text.includes('我的收藏'), false);
    assert.equal(authorPage.text.includes('便當一份'), false);

    const removed = await request(app.base, jar, `/posts/${post.id}/bookmark`, {
      _csrf: csrfOf(mine.text),
      return: '/me',
    });
    assert.equal(removed.status, 302);
    assert.equal(removed.location, '/me');
    assert.equal(bookmarkCount(env.db, reader.id, post.id), 0);
    const after = await request(app.base, jar, '/me');
    assert.equal(after.text.includes('便當一份'), false);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('同一人對同一則只會有一筆收藏', () => {
  const env = setup();
  try {
    const author = env.services.register('0912999201', '作者');
    const reader = env.services.register('0912999202', '讀者');
    const post = openPost(env.services, author.id, '只收一次');
    assert.equal(env.services.toggleBookmark(reader.id, post.id).saved, true);
    assert.equal(bookmarkCount(env.db, reader.id, post.id), 1);
    assert.throws(
      () => env.db.prepare(
        'INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)'
      ).run(reader.id, post.id, '2026-01-01T00:00:00.000Z'),
      /UNIQUE/,
    );
    assert.equal(bookmarkCount(env.db, reader.id, post.id), 1);
  } finally {
    env.close();
  }
});

test('只能看到自己的收藏，而且新的排前面', async () => {
  const env = setup();
  const password = 'bookmark-password';
  const author = env.services.register('0912999301', '作者');
  const a = env.services.registerWithPassword('0912999302', '甲', password, password);
  const b = env.services.registerWithPassword('0912999303', '乙', password, password);
  const first = openPost(env.services, author.id, '先收的');
  const second = openPost(env.services, author.id, '後收的');
  const theirs = openPost(env.services, author.id, '乙的收藏');
  env.services.toggleBookmark(a.id, first.id);
  env.services.toggleBookmark(a.id, second.id);
  env.services.toggleBookmark(b.id, theirs.id);
  env.db.prepare('UPDATE bookmarks SET created_at = ? WHERE user_id = ? AND post_id = ?')
    .run('2026-01-01T00:00:00.000Z', a.id, first.id);
  env.db.prepare('UPDATE bookmarks SET created_at = ? WHERE user_id = ? AND post_id = ?')
    .run('2026-02-01T00:00:00.000Z', a.id, second.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    assert.deepEqual(env.services.listBookmarks(a.id).map((item) => item.title), ['後收的', '先收的']);
    assert.deepEqual(env.services.listBookmarks(b.id).map((item) => item.title), ['乙的收藏']);
    await signIn(app.base, jar, '0912999302', password);
    const mine = await request(app.base, jar, '/me');
    const titles = [...mine.text.matchAll(/<h3><a href="\/posts\/\d+">([^<]+)/g)].map((match) => match[1]);
    assert.deepEqual(titles, ['後收的', '先收的']);
    assert.equal(mine.text.includes('乙的收藏'), false);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('結束的收藏仍列出狀態，而且可以取消', async () => {
  const env = setup();
  const password = 'bookmark-password';
  const author = env.services.registerWithPassword('0912999401', '作者', password, password);
  const reader = env.services.registerWithPassword('0912999402', '讀者', password, password);
  const cancelled = openPost(env.services, author.id, '已撤下的');
  const expired = openPost(env.services, author.id, '過期的');
  const settled = openPost(env.services, author.id, '完成的');
  env.services.toggleBookmark(reader.id, cancelled.id);
  env.services.toggleBookmark(reader.id, expired.id);
  env.services.toggleBookmark(reader.id, settled.id);
  env.services.cancelPost(cancelled.id, author.id);
  env.db.prepare(`UPDATE posts SET expires_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', expired.id);
  env.db.prepare(`UPDATE posts SET status = 'settled', settled_amount = 8 WHERE id = ?`).run(settled.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    const rows = env.services.listBookmarks(reader.id);
    assert.equal(rows.every((item) => item.closed), true);
    await signIn(app.base, jar, '0912999402', password);
    const mine = await request(app.base, jar, '/me');
    assert.match(mine.text, /已撤下的/);
    assert.match(mine.text, /已取消/);
    assert.match(mine.text, /過期的/);
    assert.match(mine.text, /已過期/);
    assert.match(mine.text, /完成的/);
    assert.match(mine.text, /已結算/);
    assert.match(mine.text, /is-closed/);
    const removed = await request(app.base, jar, `/posts/${cancelled.id}/bookmark`, {
      _csrf: csrfOf(mine.text),
      return: '/me',
    });
    assert.equal(removed.status, 302);
    assert.equal(bookmarkCount(env.db, reader.id, cancelled.id), 0);
    const after = await request(app.base, jar, '/me');
    assert.equal(after.text.includes('已撤下的'), false);
    assert.match(after.text, /過期的/);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('不想再遇到的雙方不能收藏，被封鎖的人也不能', () => {
  const env = setup();
  try {
    const founder = env.services.seedFounder('0912999509', '創辦人');
    const a = env.services.register('0912999501', '甲');
    const b = env.services.register('0912999502', '乙');
    const fromA = openPost(env.services, a.id, '甲的便當');
    const fromB = openPost(env.services, b.id, '乙的便當');
    env.services.hideUser(a.id, b.id);
    assert.throws(() => env.services.toggleBookmark(a.id, fromB.id), /不想再遇到/);
    assert.throws(() => env.services.toggleBookmark(b.id, fromA.id), /不想再遇到/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n, 0);
    assert.equal(env.services.postPage(fromB.id, a.id).canBookmark, false);
    assert.deepEqual(env.services.listBookmarks(a.id), []);

    const banned = env.services.register('0912999503', '被封鎖');
    const open = openPost(env.services, a.id, '還開著');
    env.services.blockUser(founder.id, banned.mobile, '收取現金');
    assert.throws(() => env.services.toggleBookmark(banned.id, open.id), /已被封鎖，不能收藏/);
    assert.equal(env.services.postPage(open.id, banned.id).canBookmark, false);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n, 0);
  } finally {
    env.close();
  }
});
