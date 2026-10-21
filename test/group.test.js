const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup(iso = '2026-10-03T02:00:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-group-'));
  const dbPath = path.join(dir, 't.db');
  const db = openDatabase(dbPath);
  db.pragma('busy_timeout = 10000');
  let current = new Date(iso);
  const services = createServices(db, { now: () => new Date(current) });
  return {
    dir,
    dbPath,
    db,
    services,
    setNow(value) { current = new Date(value); },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function books(db, userId) {
  const row = db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(userId);
  const reserved = db.prepare(
    'SELECT COALESCE(SUM(reserved_merit), 0) AS n FROM posts WHERE author_id = ?'
  ).get(userId).n;
  return { merit: row.merit, quota: row.quota, reserved, total: row.merit + reserved };
}

function messageOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  assert.fail('應該要拒絕');
}

function need(services, authorId, overrides = {}) {
  return services.createPost(authorId, {
    kind: 'need',
    category: 'food',
    title: '送便當',
    description: '需要有人幫忙送便當',
    amount: 10,
    city: '臺北市',
    expires_hours: 48,
    ...overrides,
  });
}

function settle(services, postId, hostId, seekerId, hostValue, seekerValue) {
  const waiting = services.submitValue(postId, hostId, hostValue);
  assert.equal(waiting.status, 'waiting');
  return services.submitValue(postId, seekerId, seekerValue);
}

const workerSource = `
  const { workerData, parentPort } = require('node:worker_threads');
  const { openDatabase } = require(${JSON.stringify(require.resolve('../src/db'))});
  const { createServices } = require(${JSON.stringify(require.resolve('../src/services'))});
  const db = openDatabase(workerData.dbPath);
  db.pragma('busy_timeout = 10000');
  const services = createServices(db);
  try {
    services.acceptPost(workerData.postId, workerData.userId);
    parentPort.postMessage({ ok: true });
  } catch (err) {
    parentPort.postMessage({ ok: false, message: err.message || String(err) });
  } finally {
    db.close();
  }
`;

function raceAccept(dbPath, postId, userId) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { dbPath, postId, userId },
    });
    worker.on('message', resolve);
    worker.on('error', reject);
  });
}

test('人數為 1 不預留，一般使用者不能發多人', () => {
  const env = setup();
  try {
    const schema = env.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'posts'`).get().sql;
    assert.equal(schema.includes('seats INTEGER NOT NULL UNIQUE'), false);
    const author = env.services.register('0912889001', '發文的人');
    const helper = env.services.register('0912889002', '幫忙的人');
    const single = need(env.services, author.id);
    const row = env.db.prepare('SELECT seats, reserved_merit, filled_count, parent_id FROM posts WHERE id = ?').get(single.id);
    assert.deepEqual(row, { seats: 1, reserved_merit: 0, filled_count: 0, parent_id: null });
    assert.deepEqual(books(env.db, author.id), { merit: 100, quota: 100, reserved: 0, total: 100 });
    env.services.acceptPost(single.id, helper.id);
    const done = settle(env.services, single.id, helper.id, author.id, 10, 10);
    assert.equal(done.status, 'settled');
    assert.equal(done.amount, 10);
    assert.deepEqual(books(env.db, author.id), { merit: 90, quota: 110, reserved: 0, total: 90 });
    assert.deepEqual(books(env.db, helper.id), { merit: 110, quota: 110, reserved: 0, total: 110 });

    const founder = env.services.ensureFounderAccount('0912889003', 'password-ok').user;
    const org = env.services.createOrg(founder.id, '0912889004', '福利站').user;
    const plain = need(env.services, org.id, { seats: 1, amount: 10 });
    assert.equal(env.db.prepare('SELECT reserved_merit FROM posts WHERE id = ?').get(plain.id).reserved_merit, 0);
    assert.equal(books(env.db, org.id).merit, 1000000);

    assert.equal(messageOf(() => need(env.services, author.id, { seats: 2 })), '一般使用者不能發布多人任務。');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id = ?').get(author.id).n, 1);
    assert.equal(messageOf(() => need(env.services, founder.id, { kind: 'offer', seats: 3, description: '可以一起送' })), '多人任務只能發布「我需要」。');
    assert.equal(messageOf(() => need(env.services, org.id, { seats: 51 })), '需要人數請填 1 到 50。');
    assert.equal(books(env.db, org.id).merit, 1000000);
  } finally {
    env.close();
  }
});

test('功德不夠不能發，夠的話先預留且可用加預留等於原本', () => {
  const env = setup();
  try {
    const founder = env.services.ensureFounderAccount('0912889011', 'password-ok').user;
    const org = env.services.createOrg(founder.id, '0912889012', '便當站').user;
    env.db.prepare('UPDATE users SET merit = 20 WHERE id = ?').run(org.id);
    assert.equal(messageOf(() => need(env.services, org.id, { seats: 2, amount: 11 })), '功德不夠預留。這則需要 22（2 人 × 11），你目前可用 20。');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0);
    assert.equal(env.db.prepare('SELECT merit FROM users WHERE id = ?').get(org.id).merit, 20);

    const created = need(env.services, org.id, { seats: 2, amount: 10 });
    assert.deepEqual(books(env.db, org.id), { merit: 0, quota: 1000000, reserved: 20, total: 20 });
    const ledger = env.services.meritHistory(org.id).items.map((item) => item.type);
    assert.ok(ledger.includes('預留功德'));
    assert.equal(env.db.prepare('SELECT seats, reserved_merit FROM posts WHERE id = ?').get(created.id).reserved_merit, 20);

    const rich = env.services.createOrg(founder.id, '0912889013', '另一站').user;
    assert.equal(
      messageOf(() => need(env.services, rich.id, { seats: 2, amount: 600000 })),
      '功德不夠預留。這則需要 1200000（2 人 × 600000），你目前可用 1000000。',
    );
    assert.equal(books(env.db, rich.id).merit, 1000000);
  } finally {
    env.close();
  }
});

test('前 N 人錄取後額滿，同一人不能佔兩個名額', () => {
  const env = setup();
  try {
    const founder = env.services.ensureFounderAccount('0912889021', 'password-ok').user;
    const org = env.services.createOrg(founder.id, '0912889022', '募集站').user;
    const one = env.services.register('0912889023', '甲');
    const two = env.services.register('0912889024', '乙');
    const three = env.services.register('0912889025', '丙');
    const blocked = env.services.register('0912889026', '丁');
    const hidden = env.services.register('0912889027', '戊');
    env.services.blockUser(founder.id, blocked.mobile, '爽約');
    env.db.prepare(
      'INSERT INTO user_hides (user_id, hidden_user_id, created_at) VALUES (?, ?, ?)'
    ).run(hidden.id, org.id, '2026-10-03T02:00:00.000Z');
    const created = need(env.services, org.id, { seats: 2, amount: 10 });
    assert.equal(messageOf(() => env.services.acceptPost(created.id, org.id)), '不能接下自己的貼文。');
    assert.equal(messageOf(() => env.services.acceptPost(created.id, blocked.id)), '你的帳號已被封鎖，不能發布或接下。');
    assert.equal(messageOf(() => env.services.acceptPost(created.id, hidden.id)), '你們已設定不想再遇到，不能接下這則。');

    const first = env.services.acceptPost(created.id, one.id);
    assert.equal(first.group, true);
    assert.equal(messageOf(() => env.services.acceptPost(created.id, one.id)), '你已經搶過這則，不能再佔名額。');
    env.services.acceptPost(created.id, two.id);
    assert.equal(messageOf(() => env.services.acceptPost(created.id, three.id)), '這則已經額滿。');
    const parent = env.db.prepare('SELECT status, filled_count, seats, reserved_merit FROM posts WHERE id = ?').get(created.id);
    assert.equal(parent.filled_count, 2);
    assert.equal(parent.seats, 2);
    assert.equal(parent.reserved_merit, 0);
    assert.equal(parent.status, 'open');
    const slots = env.db.prepare(
      `SELECT status FROM post_slots WHERE post_id = ? AND status = 'accepted'`
    ).all(created.id);
    assert.equal(slots.length, 2);
    assert.equal(env.services.listOpenPosts().some((post) => post.id === created.id), false);
    assert.equal(books(env.db, org.id).total, 1000000);
    const page = env.services.postPage(created.id, three.id);
    assert.equal(page.canAccept, false);
    assert.equal(page.acceptHint, '這則已經額滿。');
    assert.equal(page.filled, 2);
  } finally {
    env.close();
  }
});

test('同時搶不會超額', async () => {
  const env = setup();
  try {
    const founder = env.services.ensureFounderAccount('0912889031', 'password-ok').user;
    const org = env.services.createOrg(founder.id, '0912889032', '同時站').user;
    const people = [3, 4, 5].map((n) => env.services.register(`091288903${n}`, `人${n}`));
    const created = need(env.services, org.id, { seats: 2, amount: 10 });
    env.db.prepare(`UPDATE posts SET expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(created.id);
    const results = await Promise.all(people.map((person) => raceAccept(env.dbPath, created.id, person.id)));
    const won = results.filter((item) => item.ok);
    const lost = results.filter((item) => !item.ok);
    assert.equal(won.length, 2);
    assert.equal(lost.length, 1);
    assert.match(lost[0].message, /額滿/);
    const parent = env.db.prepare('SELECT filled_count, reserved_merit FROM posts WHERE id = ?').get(created.id);
    assert.equal(parent.filled_count, 2);
    assert.equal(parent.reserved_merit, 0);
    assert.equal(env.db.prepare(
      `SELECT COUNT(*) AS n FROM post_slots WHERE post_id = ? AND status = 'accepted'`
    ).get(created.id).n, 2);
    assert.equal(books(env.db, org.id).total, 1000000);
  } finally {
    env.close();
  }
});

test('每個人各自結算，每天一次在接下時就擋下', () => {
  const env = setup();
  try {
    const founder = env.services.ensureFounderAccount('0912889041', 'password-ok').user;
    const org = env.services.createOrg(founder.id, '0912889042', '結算站').user;
    const one = env.services.register('0912889043', '甲');
    const two = env.services.register('0912889044', '乙');
    const created = need(env.services, org.id, { seats: 2, amount: 10 });
    const first = env.services.acceptPost(created.id, one.id);
    const second = env.services.acceptPost(created.id, two.id);
    const low = settle(env.services, first.childId, one.id, org.id, 6, 10);
    assert.equal(low.status, 'settled');
    assert.equal(low.amount, 6);
    const exact = settle(env.services, second.childId, two.id, org.id, 10, 10);
    assert.equal(exact.amount, 10);
    assert.deepEqual(
      env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(one.id),
      { merit: 106, quota: 106 },
    );
    assert.deepEqual(
      env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(two.id),
      { merit: 110, quota: 110 },
    );
    const orgBooks = books(env.db, org.id);
    assert.equal(orgBooks.merit, 1000000 - 16);
    assert.equal(orgBooks.quota, 1000000 + 16);
    assert.equal(orgBooks.reserved, 0);
    assert.equal(orgBooks.total, 1000000 - 16);
    env.services.rate(first.childId, one.id, 5, '', []);
    env.services.rate(first.childId, org.id, 4, '', []);
    assert.equal(books(env.db, org.id).merit, 1000000 - 16);
    assert.equal(env.db.prepare(
      `SELECT status FROM post_slots WHERE child_post_id = ?`
    ).get(first.childId).status, 'settled');

    const again = need(env.services, org.id, { seats: 2, amount: 10 });
    assert.match(
      messageOf(() => env.services.acceptPost(again.id, one.id)),
      /已經結算過一次/,
    );
    const fresh = env.services.register('0912889045', '丙');
    const pending = env.services.acceptPost(again.id, fresh.id);
    assert.match(
      messageOf(() => env.services.acceptPost(need(env.services, org.id, { seats: 2, amount: 10 }).id, fresh.id)),
      /請先完成那一筆再接/,
    );
    env.setNow('2026-10-03T16:00:00.000Z');
    settle(env.services, pending.childId, fresh.id, org.id, 10, 10);
    const tomorrow = need(env.services, org.id, { seats: 2, amount: 10 });
    const next = env.services.acceptPost(tomorrow.id, one.id);
    assert.equal(next.group, true);

    const classicAuthor = env.services.register('0912889046', '單人發文');
    const classicHelper = env.services.register('0912889047', '單人幫忙');
    const classic = need(env.services, classicAuthor.id, { amount: 10 });
    env.services.acceptPost(classic.id, classicHelper.id);
    assert.equal(settle(env.services, classic.id, classicHelper.id, classicAuthor.id, 10, 10).amount, 10);
    const secondClassic = need(env.services, classicAuthor.id, { amount: 10, description: '再一則便當' });
    env.services.acceptPost(secondClassic.id, classicHelper.id);
    const blocked = settle(env.services, secondClassic.id, classicHelper.id, classicAuthor.id, 10, 10);
    assert.equal(blocked.status, 'daily');
    assert.deepEqual(
      env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(classicAuthor.id),
      { merit: 90, quota: 110 },
    );
  } finally {
    env.close();
  }
});

test('過期、下架、移除會退回沒用到的預留', () => {
  const env = setup();
  try {
    const founder = env.services.ensureFounderAccount('0912889051', 'password-ok').user;
    const org = env.services.createOrg(founder.id, '0912889052', '退回站').user;
    const keeper = env.services.register('0912889053', '留下');
    const removed = env.services.register('0912889054', '被移出');
    const replacement = env.services.register('0912889055', '補位');

    const open = need(env.services, org.id, { seats: 2, amount: 15 });
    const joined = env.services.acceptPost(open.id, removed.id);
    const slot = env.db.prepare('SELECT id FROM post_slots WHERE child_post_id = ?').get(joined.childId);
    env.services.removeSlot(open.id, slot.id, org.id);
    assert.equal(messageOf(() => env.services.acceptPost(open.id, removed.id)), '你已經搶過這則，不能再佔名額。');
    assert.equal(messageOf(() => env.services.removeSlot(open.id, slot.id, keeper.id)), '只有發文者可以移出。');
    const refilled = env.services.acceptPost(open.id, replacement.id);
    assert.equal(refilled.group, true);
    assert.equal(env.db.prepare('SELECT filled_count FROM posts WHERE id = ?').get(open.id).filled_count, 1);
    assert.equal(books(env.db, org.id).total, 1000000);

    env.services.cancelPost(open.id, org.id);
    const afterCancel = books(env.db, org.id);
    assert.equal(afterCancel.reserved, 15);
    assert.equal(afterCancel.total, 1000000);
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(open.id).status, 'cancelled');
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(refilled.childId).status, 'matched');

    const expiring = need(env.services, org.id, { seats: 2, amount: 15, expires_hours: 24 });
    env.services.acceptPost(expiring.id, keeper.id);
    env.setNow('2026-10-04T02:00:00.001Z');
    env.services.listOpenPosts();
    const afterExpire = books(env.db, org.id);
    assert.equal(env.db.prepare('SELECT reserved_merit FROM posts WHERE id = ?').get(expiring.id).reserved_merit, 0);
    assert.equal(afterExpire.merit, 1000000 - 30);
    assert.equal(afterExpire.reserved, 30);
    assert.equal(afterExpire.total, 1000000);
    const types = env.services.meritHistory(org.id).items.map((item) => item.type);
    assert.ok(types.includes('退回預留'));
    assert.ok(types.includes('預留功德'));
  } finally {
    env.close();
  }
});

test('舊貼文補上人數 1，表單只有機構和創辦人看得到', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-group-old-'));
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
      created_at TEXT NOT NULL
    );
    INSERT INTO users (mobile, display_name, role, merit, quota, created_at)
    VALUES ('0912889061', '舊會員', 'user', 100, 100, '2026-10-01T00:00:00.000Z');
    INSERT INTO posts (author_id, kind, category, description, amount, status, created_at)
    VALUES (1, 'need', 'food', '舊便當', 10, 'open', '2026-10-01T00:00:00.000Z');
  `);
  legacy.close();
  const db = openDatabase(file);
  try {
    const row = db.prepare('SELECT seats, filled_count, reserved_merit, parent_id FROM posts WHERE id = 1').get();
    assert.deepEqual(row, { seats: 1, reserved_merit: 0, filled_count: 0, parent_id: null });
    assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'post_slots'`).get().name, 'post_slots');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const env = setup();
  const founder = env.services.ensureFounderAccount('0912889062', 'password-ok').user;
  const member = env.services.registerWithPassword('0912889063', '會員', 'password-ok', 'password-ok');
  const org = env.services.createOrg(founder.id, '0912889064', '表單站').user;
  env.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    env.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(member.id).password_hash,
    org.id,
  );
  const app = createApp({ db: env.db, sessionSecret: 'group-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const memberJar = cookieJar();
    await signIn(base, memberJar, member.mobile);
    const memberForm = await request(base, memberJar, '/posts/new');
    assert.equal(memberForm.text.includes('name="seats"'), false);
    const denied = await request(base, memberJar, '/posts', {
      _csrf: csrfOf(memberForm.text),
      kind: 'need',
      category: 'food',
      description: '想發多人',
      amount: '10',
      city: '臺北市',
      seats: '2',
    });
    assert.equal(denied.status, 302);
    const deniedPage = await request(base, memberJar, '/posts/new');
    assert.match(deniedPage.text, /一般使用者不能發布多人任務/);
    assert.equal(books(env.db, member.id).merit, 100);

    const orgJar = cookieJar();
    await signIn(base, orgJar, org.mobile);
    const orgForm = await request(base, orgJar, '/posts/new');
    assert.match(orgForm.text, /name="seats"/);
    assert.match(orgForm.text, /需要人數/);
    const stale = await request(base, orgJar, '/posts', {
      kind: 'need',
      category: 'food',
      description: '沒有驗證',
      amount: '10',
      city: '臺北市',
      seats: '2',
    });
    assert.equal(stale.status, 303);
    assert.equal(books(env.db, org.id).merit, 1000000);
    const posted = await request(base, orgJar, '/posts', {
      _csrf: csrfOf(orgForm.text),
      kind: 'need',
      category: 'food',
      description: '兩人便當',
      amount: '10',
      city: '臺北市',
      seats: '2',
    });
    assert.equal(posted.status, 302);
    const shown = await request(base, orgJar, posted.location);
    assert.match(shown.text, /已錄取 0／2/);
    assert.match(shown.text, /先搶先贏/);
    assert.match(shown.text, /錄取名單/);
    assert.equal(books(env.db, org.id).merit, 999980);
    assert.equal(books(env.db, org.id).reserved, 20);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
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
