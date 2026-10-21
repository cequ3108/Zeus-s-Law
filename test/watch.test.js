const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  let current = new Date('2026-10-03T02:00:00.000Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-watch-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, { now: () => current });
  const founder = services.ensureFounderAccount('0912889201', 'password-ok').user;
  const watcher = services.registerWithPassword('0912889202', '關注的人', 'password-ok', 'password-ok');
  const author = services.registerWithPassword('0912889203', '發文的人', 'password-ok', 'password-ok');
  const other = services.registerWithPassword('0912889204', '另一位', 'password-ok', 'password-ok');
  services.updateAccountPlace(watcher.id, { city: '臺北市' });
  return {
    db,
    services,
    founder,
    watcher,
    author,
    other,
    setNow(iso) { current = new Date(iso); },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function offer(env, authorId, fields = {}) {
  return env.services.createPost(authorId, {
    kind: 'offer',
    category: fields.category || 'food',
    description: fields.title || '便當',
    title: fields.title || '便當',
    amount: 10,
    city: fields.city || '臺北市',
  });
}

test('計數只算上次查看後、還在招募、而且符合關注的貼文', () => {
  const env = setup();
  try {
    const before = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(env.watcher.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 0);
    assert.equal(env.services.readWatchPrefs(env.watcher.id).active, false);

    const saved = env.services.saveWatchPrefs(env.watcher.id, ['food', 'transport'], ['台北市', '新北市']);
    assert.deepEqual(saved.categories, ['food', 'transport']);
    assert.deepEqual(saved.counties, ['臺北市', '新北市']);
    assert.equal(saved.lastCheckedAt, null);

    const taipeiFood = offer(env, env.author.id, { title: '台北便當', city: '臺北市', category: 'food' });
    offer(env, env.author.id, { title: '高雄便當', city: '高雄市', category: 'food' });
    const xinbeiRide = offer(env, env.author.id, { title: '新北共乘', city: '新北市', category: 'transport' });
    offer(env, env.watcher.id, { title: '自己的便當', city: '臺北市', category: 'food' });
    assert.equal(env.services.watchNewCount(env.watcher.id), 2);

    env.db.prepare(`UPDATE posts SET status = 'cancelled' WHERE id = ?`).run(taipeiFood.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);
    env.db.prepare(`UPDATE posts SET status = 'open' WHERE id = ?`).run(taipeiFood.id);
    env.db.prepare(`UPDATE posts SET status = 'matched' WHERE id = ?`).run(taipeiFood.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);
    env.db.prepare(`UPDATE posts SET status = 'open' WHERE id = ?`).run(taipeiFood.id);
    env.db.prepare(`UPDATE posts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(taipeiFood.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);
    env.db.prepare(`UPDATE posts SET expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(taipeiFood.id);
    env.db.prepare(`UPDATE posts SET seats = 2, filled_count = 2 WHERE id = ?`).run(taipeiFood.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);
    env.db.prepare(`UPDATE posts SET seats = 1, filled_count = 0 WHERE id = ?`).run(taipeiFood.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 2);

    const checked = env.services.markWatchChecked(env.watcher.id);
    assert.equal(checked.lastCheckedAt, '2026-10-03T02:00:00.000Z');
    assert.equal(env.services.watchNewCount(env.watcher.id), 0);
    env.db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(checked.lastCheckedAt, xinbeiRide.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 0);
    env.db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run('2026-10-03T02:00:00.001Z', xinbeiRide.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);

    env.services.saveWatchPrefs(env.watcher.id, 'food', []);
    assert.equal(env.services.readWatchPrefs(env.watcher.id).lastCheckedAt, checked.lastCheckedAt);
    assert.equal(env.services.watchNewCount(env.watcher.id), 0);
    env.services.saveWatchPrefs(env.watcher.id, [], '新北市');
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);

    const listed = env.services.listOpenPosts({
      viewerId: env.watcher.id,
      watchCategories: ['transport'],
      watchCounties: ['新北市'],
    }).map((post) => post.title);
    assert.deepEqual(listed, ['新北共乘']);

    const after = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(env.watcher.id);
    assert.equal(after.merit, before.merit);
    assert.equal(after.quota, before.quota);
    assert.throws(() => env.services.saveWatchPrefs(env.watcher.id, '現金', '臺北市'), /請選擇食物、交通或其他/);
    assert.throws(() => env.services.saveWatchPrefs(env.watcher.id, 'food', '火星'), /請選擇縣市/);
  } finally {
    env.close();
  }
});

test('自己的貼文、被封鎖的人和不想再遇到的人不算', () => {
  const env = setup();
  try {
    env.services.saveWatchPrefs(env.watcher.id, ['food'], ['臺北市']);
    const kept = offer(env, env.author.id, { title: '可看的便當' });
    const hidden = offer(env, env.other.id, { title: '不想再遇到的便當' });
    offer(env, env.watcher.id, { title: '自己發的' });
    assert.equal(env.services.watchNewCount(env.watcher.id), 2);

    env.services.hideUser(env.watcher.id, env.other.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);
    env.services.unhideUser(env.watcher.id, env.other.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 2);
    env.services.hideUser(env.other.id, env.watcher.id);
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);
    env.services.unhideUser(env.other.id, env.watcher.id);

    env.services.blockUser(env.founder.id, '0912889203', '測試');
    assert.equal(env.services.watchNewCount(env.watcher.id), 1);
    env.services.unblockUser(env.founder.id, '0912889203');
    assert.equal(env.services.watchNewCount(env.watcher.id), 2);
    assert.equal(kept.id > 0 && hidden.id > 0, true);

    const cleared = env.services.saveWatchPrefs(env.watcher.id, [], []);
    assert.equal(cleared.active, false);
    assert.equal(env.services.watchNewCount(env.watcher.id), 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM user_watch_prefs').get().count, 0);
  } finally {
    env.close();
  }
});

test('點開後更新上次查看，沒設定關注時首頁不顯示', async () => {
  const env = setup();
  const app = createApp({ db: env.db, sessionSecret: 'watch-secret', cookieSecure: false, now: () => new Date('2026-10-03T02:00:00.000Z') });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = cookieJar();
  try {
    offer(env, env.author.id, { title: '台北便當', city: '臺北市', category: 'food' });
    offer(env, env.author.id, { title: '高雄便當', city: '高雄市', category: 'food' });
    offer(env, env.author.id, { title: '台北共乘', city: '臺北市', category: 'transport' });
    offer(env, env.watcher.id, { title: '自己的便當', city: '臺北市', category: 'food' });

    await signIn(base, jar, '0912889202');
    const account = await request(base, jar, '/account');
    assert.match(account.text, /關注的類別（可以不選）/);
    assert.match(account.text, /關注的縣市（可以不選）/);
    assert.match(account.text, /data-watch-active="0"/);
    assert.match(account.text, /name="counties" value="臺北市" checked/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM user_watch_prefs').get().count, 0);

    const plain = await request(base, jar, '/?city=all');
    assert.equal(plain.text.includes('自上次查看後'), false);
    assert.equal(plain.text.includes('data-watch-new'), false);
    assert.match(plain.text, /台北便當/);
    assert.match(plain.text, /高雄便當/);
    const localHome = await request(base, jar, '/');
    assert.match(localHome.text, /台北便當/);
    assert.equal(localHome.text.includes('高雄便當'), false);

    const saved = await request(base, jar, '/account/watch', {
      _csrf: csrfOf(account.text),
      categories: 'food',
      counties: ['臺北市', '新北市'],
    });
    assert.equal(saved.status, 302);
    const row = env.db.prepare('SELECT categories, counties, last_checked_at FROM user_watch_prefs WHERE user_id = ?').get(env.watcher.id);
    assert.equal(row.categories, 'food');
    assert.equal(row.counties, '臺北市,新北市');
    assert.equal(row.last_checked_at, null);
    const merit = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(env.watcher.id);
    assert.equal(merit.merit, 100);
    assert.equal(merit.quota, 100);

    const home = await request(base, jar, '/?city=all');
    assert.match(home.text, /自上次查看後有 1 則符合你關注的新貼文/);
    assert.match(home.text, /data-watch-new="1"/);

    const stale = await request(base, jar, '/watch/check', { categories: 'food' });
    assert.equal(stale.status, 303);
    assert.equal(env.db.prepare('SELECT last_checked_at FROM user_watch_prefs WHERE user_id = ?').get(env.watcher.id).last_checked_at, null);

    const seen = await request(base, jar, '/watch/check', { _csrf: csrfOf(home.text) });
    assert.equal(seen.status, 302);
    assert.equal(seen.location, '/?watch=1&city=all');
    const checkedAt = env.db.prepare('SELECT last_checked_at FROM user_watch_prefs WHERE user_id = ?').get(env.watcher.id).last_checked_at;
    assert.equal(typeof checkedAt, 'string');
    assert.equal(env.services.watchNewCount(env.watcher.id), 0);

    const filtered = await request(base, jar, seen.location);
    assert.equal(filtered.text.includes('自上次查看後'), false);
    assert.equal(filtered.text.includes('data-watch-new'), false);
    assert.match(filtered.text, /正在看你關注的類別與縣市/);
    assert.match(filtered.text, /台北便當/);
    assert.equal(filtered.text.includes('高雄便當'), false);
    assert.equal(filtered.text.includes('台北共乘'), false);
    assert.match(filtered.text, /自己的便當/);

    const guest = await request(base, null, '/?city=all');
    assert.equal(guest.text.includes('自上次查看後'), false);
    assert.equal(guest.text.includes('data-watch-new'), false);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});

test('舊資料庫補上關注表後，原來的餘額還在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-watch-old-'));
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
    INSERT INTO users (mobile, display_name, role, merit, quota, blocked, created_at)
    VALUES ('0912889209', '舊帳號', 'user', 80, 120, 0, '2026-10-01T00:00:00.000Z');
  `);
  legacy.close();
  const db = openDatabase(file);
  try {
    const user = db.prepare('SELECT merit, quota FROM users WHERE mobile = ?').get('0912889209');
    assert.equal(user.merit, 80);
    assert.equal(user.quota, 120);
    const columns = db.prepare('PRAGMA table_info(user_watch_prefs)').all().map((column) => column.name);
    assert.deepEqual(columns, ['user_id', 'categories', 'counties', 'last_checked_at']);
    const services = createServices(db);
    const row = db.prepare('SELECT id FROM users WHERE mobile = ?').get('0912889209');
    assert.equal(services.watchNewCount(row.id), 0);
    assert.equal(services.readWatchPrefs(row.id).active, false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (item != null) body.append(key, item);
      }
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
