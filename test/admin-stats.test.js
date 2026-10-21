const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

const NOW = '2026-10-19T04:00:00.000Z';
const SINCE = '2026-10-12T04:00:00.000Z';
const BEFORE = '2026-10-12T03:59:59.999Z';
const LATER = '2026-10-20T04:00:00.000Z';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-stats-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, { now: () => new Date(NOW) });
  return {
    dir,
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
  const app = createApp({
    db,
    now: () => new Date(NOW),
    sessionSecret: 'stats-secret',
    cookieSecure: false,
  });
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

function insertPost(db, { authorId, city, status = 'open', createdAt = NOW, expiresAt = LATER, settledAt = null }) {
  const info = db.prepare(`
    INSERT INTO posts (
      author_id, kind, category, description, amount, status, created_at, city, expires_at, settled_at
    ) VALUES (?, 'offer', 'food', '測試貼文', 10, ?, ?, ?, ?, ?)
  `).run(authorId, status, createdAt, city, expiresAt, settledAt);
  return Number(info.lastInsertRowid);
}

function insertReceive(db, { payerId, receiverId, amount, createdAt, reason = 'settle_receive' }) {
  db.prepare(`
    INSERT INTO ledger (
      created_at, user_id, delta_merit, delta_quota, merit_after, quota_after, reason, counterparty_id
    ) VALUES (?, ?, ?, 0, 0, 0, ?, ?)
  `).run(createdAt, receiverId, amount, reason, payerId);
}

test('非創辦人不能看社群概況', async () => {
  const env = setup();
  const password = 'founder-password';
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912000101',
    FOUNDER_PASSWORD: password,
  });
  const member = env.services.registerWithPassword('0912000102', '一般會員', 'member-password', 'member-password');
  assert.throws(() => env.services.communityStats(member.id), /只有創辦人/);
  assert.throws(() => env.services.adminSnapshot(member.id), /只有創辦人/);

  const app = await listen(env.db);
  try {
    const anon = await request(app.base, cookieJar(), '/admin');
    assert.equal(anon.status, 302);
    assert.equal(anon.location, '/login');

    const jar = cookieJar();
    await signIn(app.base, jar, '0912000102', 'member-password');
    const denied = await request(app.base, jar, '/admin');
    assert.equal(denied.status, 403);
    assert.doesNotMatch(denied.text, /社群概況/);
    assert.match(denied.text, /只有創辦人可以進入管理頁/);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('只有創辦人時概況全部是 0', async () => {
  const env = setup();
  const password = 'founder-password';
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912000201',
    FOUNDER_PASSWORD: password,
  });
  const founder = env.services.findByMobile('0912000201');
  const ledgerBefore = env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
  const stats = env.services.communityStats(founder.id);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, ledgerBefore);
  assert.deepEqual(stats, {
    users: 0,
    orgs: 0,
    signups: 0,
    openPosts: 0,
    newPosts: 0,
    settledWeek: 0,
    settledAll: 0,
    meritMembers: 0,
    meritFounder: 0,
    ratingAvg: 0,
    ratingCount: 0,
    cities: [],
    banned: 0,
    pendingOrgs: 0,
    openReports: 0,
  });

  const app = await listen(env.db);
  try {
    const jar = cookieJar();
    await signIn(app.base, jar, '0912000201', password);
    const admin = await request(app.base, jar, '/admin');
    assert.equal(admin.status, 200);
    const overview = admin.text.indexOf('社群概況');
    const announce = admin.text.indexOf('站內公告');
    assert.ok(overview >= 0 && overview < announce);
    for (const key of [
      'users', 'orgs', 'signups', 'open-posts', 'new-posts', 'settled-week', 'settled-all',
      'merit-members', 'merit-founder', 'rating-count', 'banned', 'pending-orgs',
    ]) {
      assert.match(admin.text, new RegExp(`data-stat="${key}">0<`));
    }
    assert.match(admin.text, /data-stat="rating-avg">0</);
    assert.match(admin.text, /data-cities="0"/);
    assert.match(admin.text, /查帳號/);
    assert.match(admin.text, /建立福利機構/);
    assert.match(admin.text, /封鎖收取現金的帳號/);
    assert.match(admin.text, /功德帳本/);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('七日邊界、縣市前五與功德流向都算對', async () => {
  const env = setup();
  const password = 'founder-password';
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912000301',
    FOUNDER_PASSWORD: password,
  });
  const founder = env.services.findByMobile('0912000301');
  const userA = env.services.register('0912000302', '甲');
  const userB = env.services.register('0912000303', '乙');
  const userC = env.services.register('0912000304', '丙');
  const org = env.services.createOrg(founder.id, '0912000305', '福利站').user;
  env.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(SINCE, userB.id);
  env.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(BEFORE, userC.id);
  env.services.blockUser(founder.id, '0912000304', '收取現金');

  const openIds = [];
  for (const [city, count] of [
    ['臺北市', 3],
    ['臺中市', 2],
    ['高雄市', 2],
    ['新北市', 1],
    ['桃園市', 1],
    ['臺南市', 1],
  ]) {
    for (let i = 0; i < count; i += 1) {
      openIds.push(insertPost(env.db, { authorId: userA.id, city }));
    }
  }
  insertPost(env.db, { authorId: userA.id, city: '臺北市', expiresAt: NOW });
  insertPost(env.db, { authorId: userA.id, city: '臺北市', status: 'cancelled' });
  insertPost(env.db, { authorId: userA.id, city: '臺北市', status: 'settled', settledAt: SINCE });
  insertPost(env.db, {
    authorId: userA.id,
    city: '臺北市',
    status: 'settled',
    createdAt: BEFORE,
    settledAt: BEFORE,
  });

  insertReceive(env.db, { payerId: userA.id, receiverId: userB.id, amount: 40, createdAt: NOW });
  insertReceive(env.db, { payerId: userA.id, receiverId: userB.id, amount: 15, createdAt: BEFORE });
  insertReceive(env.db, { payerId: org.id, receiverId: userA.id, amount: 7, createdAt: NOW });
  insertReceive(env.db, { payerId: founder.id, receiverId: userA.id, amount: 25, createdAt: NOW });
  insertReceive(env.db, { payerId: founder.id, receiverId: userA.id, amount: 8, createdAt: BEFORE });
  insertReceive(env.db, { payerId: userA.id, receiverId: founder.id, amount: 99, createdAt: NOW });
  insertReceive(env.db, {
    payerId: userA.id,
    receiverId: userB.id,
    amount: 1000,
    createdAt: NOW,
    reason: 'settle_spend',
  });

  env.db.prepare(`
    INSERT INTO ratings (post_id, rater_id, ratee_id, stars, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(openIds[0], userB.id, userA.id, 5, NOW);
  env.db.prepare(`
    INSERT INTO ratings (post_id, rater_id, ratee_id, stars, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(openIds[1], userB.id, userA.id, 4, NOW);
  env.db.prepare(`
    INSERT INTO ratings (post_id, rater_id, ratee_id, stars, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(openIds[2], userC.id, userA.id, 3, NOW);

  env.db.prepare(`
    INSERT INTO org_applications (user_id, org_name, status, created_at) VALUES (?, '待審之家', 'pending', ?)
  `).run(userA.id, NOW);
  env.db.prepare(`
    INSERT INTO org_applications (user_id, org_name, status, created_at) VALUES (?, '已拒絕', 'rejected', ?)
  `).run(userB.id, BEFORE);

  const stats = env.services.communityStats(founder.id);
  assert.equal(stats.users, 3);
  assert.equal(stats.orgs, 1);
  assert.equal(stats.signups, 3);
  assert.equal(stats.openPosts, 10);
  assert.equal(stats.newPosts, 13);
  assert.equal(stats.settledWeek, 1);
  assert.equal(stats.settledAll, 2);
  assert.equal(stats.meritMembers, 47);
  assert.equal(stats.meritFounder, 25);
  assert.equal(stats.ratingAvg, 4);
  assert.equal(stats.ratingCount, 3);
  assert.equal(stats.banned, 1);
  assert.equal(stats.pendingOrgs, 1);
  assert.deepEqual(
    stats.cities.map((city) => [city.city, city.count]),
    [
      ['臺北市', 3],
      ['臺中市', 2],
      ['高雄市', 2],
      ['新北市', 1],
      ['桃園市', 1],
    ],
  );

  const app = await listen(env.db);
  try {
    const jar = cookieJar();
    await signIn(app.base, jar, '0912000301', password);
    const admin = await request(app.base, jar, '/admin');
    assert.equal(admin.status, 200);
    assert.ok(admin.text.indexOf('社群概況') < admin.text.indexOf('站內公告'));
    assert.match(admin.text, /data-stat="users">3</);
    assert.match(admin.text, /data-stat="merit-members">47</);
    assert.match(admin.text, /data-stat="merit-founder">25</);
    assert.match(admin.text, /data-stat="rating-avg">4</);
    assert.match(admin.text, /data-stat="open-posts">10</);
    const cities = [...admin.text.matchAll(/data-city="([^"]+)" data-count="(\d+)"/g)]
      .map((match) => [match[1], Number(match[2])]);
    assert.deepEqual(cities, [
      ['臺北市', 3],
      ['臺中市', 2],
      ['高雄市', 2],
      ['新北市', 1],
      ['桃園市', 1],
    ]);
    assert.doesNotMatch(admin.text, /臺南市/);
  } finally {
    await close(app.server);
    env.close();
  }
});
