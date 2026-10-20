const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

const NOW = new Date('2026-10-20T04:00:00.000Z');

function setup(clock = () => NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-merit-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, { now: clock });
  return {
    db,
    services,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function balances(env, mobile) {
  const user = env.services.findByMobile(mobile);
  return { merit: user.merit, quota: user.quota };
}

function settle(env, host, seeker, amount, title) {
  const post = env.services.createPost(host.id, {
    kind: 'offer',
    category: 'food',
    city: '臺北市',
    amount,
    description: title,
    title,
  });
  env.services.acceptPost(post.id, seeker.id);
  env.services.submitValue(post.id, host.id, amount);
  const result = env.services.submitValue(post.id, seeker.id, amount);
  assert.equal(result.status, 'settled');
  return post.id;
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
  const app = createApp({ db, now: () => NOW, sessionSecret: 'merit-secret', cookieSecure: false });
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
  return { status: response.status, text: await response.text(), location: response.headers.get('location') };
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

test('明細由新到舊，每筆餘額接得上，最新一筆等於現在的功德', () => {
  let now = new Date('2026-09-15T04:00:00.000Z');
  const env = setup(() => now);
  try {
    const host = env.services.registerWithPassword('0912111101', '主人', 'password-ok', 'password-ok');
    const guest = env.services.registerWithPassword('0912111102', '客人', 'password-ok', 'password-ok');
    const other = env.services.registerWithPassword('0912111103', '另一位', 'password-ok', 'password-ok');
    now = new Date('2026-10-20T04:00:00.000Z');
    settle(env, host, guest, 10, '收到的便當');
    settle(env, other, host, 4, '付出的便當');
    const after = balances(env, '0912111101');
    const history = env.services.meritHistory(host.id);
    assert.deepEqual(history.items.map((row) => row.type), ['被招待付出', '招待別人收到', '註冊起始']);
    assert.deepEqual(history.items.map((row) => row.deltaMerit), [-4, 10, 100]);
    assert.deepEqual(history.items.map((row) => row.meritAfter), [106, 110, 100]);
    assert.deepEqual(history.items.map((row) => row.id), [...history.items.map((row) => row.id)].sort((a, b) => b - a));
    for (let i = 0; i < history.items.length - 1; i += 1) {
      assert.equal(history.items[i].meritAfter, history.items[i + 1].meritAfter + history.items[i].deltaMerit);
    }
    assert.equal(history.items[0].meritAfter, history.merit);
    assert.equal(history.merit, after.merit);
    assert.equal(history.quota, after.quota);
    assert.equal(history.received, 10);
    assert.equal(history.paid, 4);
    assert.equal(history.items[0].counterpartyName, '另一位');
    assert.equal(history.items[1].counterpartyName, '客人');
    assert.equal(history.items[2].counterpartyId, null);
    assert.equal(history.items[0].deltaQuota, 4);
    assert.equal(history.items[2].type, '註冊起始');
    const again = env.services.meritHistory(host.id);
    assert.deepEqual(balances(env, '0912111101'), after);
    assert.equal(again.items[0].meritAfter, after.merit);

    const october = env.services.meritHistory(host.id, { month: '2026-10' });
    assert.deepEqual(october.items.map((row) => row.type), ['被招待付出', '招待別人收到']);
    const september = env.services.meritHistory(host.id, { month: '2026-09' });
    assert.deepEqual(september.items.map((row) => row.type), ['註冊起始']);
    assert.equal(october.received, 10);
    assert.equal(october.paid, 4);
    assert.deepEqual(env.services.meritHistory(host.id, { month: '2020-01' }).items, []);
    assert.deepEqual(balances(env, '0912111101'), after);
  } finally {
    env.close();
  }
});

test('別人不能看，沒有紀錄的月份是空的，個人頁和帳號頁進得去', async () => {
  const env = setup();
  const password = 'password-ok';
  const owner = env.services.registerWithPassword('0912111111', '主人', password, password);
  env.services.registerWithPassword('0912111112', '別人', password, password);
  const app = await listen(env.db);
  const ownerJar = cookieJar();
  const otherJar = cookieJar();
  try {
    const loggedOut = await request(app.base, cookieJar(), `/users/${owner.id}/merit`);
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.location, '/login');

    await signIn(app.base, ownerJar, '0912111111', password);
    const mine = await request(app.base, ownerJar, `/users/${owner.id}/merit`);
    assert.equal(mine.status, 200);
    assert.match(mine.text, /我的功德明細/);
    assert.match(mine.text, /data-type="註冊起始"/);
    assert.match(mine.text, /data-merit-after="100"/);
    assert.match(mine.text, /data-merit="100"/);
    assert.match(mine.text, /data-month-received="0"/);
    assert.match(mine.text, /data-month-paid="0"/);
    const profile = await request(app.base, ownerJar, `/users/${owner.id}`);
    assert.match(profile.text, new RegExp(`href="/users/${owner.id}/merit"`));
    const account = await request(app.base, ownerJar, '/account');
    assert.match(account.text, new RegExp(`href="/users/${owner.id}/merit"`));
    const empty = await request(app.base, ownerJar, `/users/${owner.id}/merit?month=2020-01`);
    assert.match(empty.text, /這個月還沒有功德進出/);
    assert.equal(empty.text.includes('data-ledger='), false);

    await signIn(app.base, otherJar, '0912111112', password);
    const denied = await request(app.base, otherJar, `/users/${owner.id}/merit`);
    assert.equal(denied.status, 403);
    assert.match(denied.text, /只能看自己的功德明細/);
    assert.equal(denied.text.includes('data-ledger='), false);
    assert.equal(denied.text.includes('註冊起始'), false);
    const theirProfile = await request(app.base, otherJar, `/users/${owner.id}`);
    assert.equal(theirProfile.text.includes(`/users/${owner.id}/merit`), false);
    assert.deepEqual(balances(env, '0912111111'), { merit: 100, quota: 100 });
  } finally {
    await close(app.server);
    env.close();
  }
});

test('一次二十筆，載入更多接著較舊的，順序和餘額仍接得上', async () => {
  const env = setup();
  const password = 'password-ok';
  const user = env.services.registerWithPassword('0912111121', '很多筆', password, password);
  let merit = 100;
  let quota = 100;
  const insert = env.db.prepare(`
    INSERT INTO ledger (
      created_at, user_id, delta_merit, delta_quota, merit_after, quota_after, reason
    ) VALUES (?, ?, 1, 1, ?, ?, 'settle_receive')
  `);
  for (let i = 0; i < 24; i += 1) {
    merit += 1;
    quota += 1;
    insert.run(NOW.toISOString(), user.id, merit, quota);
  }
  env.db.prepare('UPDATE users SET merit = ?, quota = ? WHERE id = ?').run(merit, quota, user.id);
  const first = env.services.meritHistory(user.id);
  assert.equal(first.items.length, 20);
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].meritAfter, 124);
  assert.equal(first.merit, 124);
  for (let i = 0; i < first.items.length - 1; i += 1) {
    assert.equal(first.items[i].meritAfter, first.items[i + 1].meritAfter + first.items[i].deltaMerit);
  }
  const second = env.services.meritHistory(user.id, { before: first.nextBefore });
  assert.equal(second.items.length, 5);
  assert.equal(second.hasMore, false);
  assert.equal(first.items[first.items.length - 1].meritAfter, second.items[0].meritAfter + first.items[first.items.length - 1].deltaMerit);
  assert.equal(second.items[second.items.length - 1].type, '註冊起始');
  assert.equal(second.items[second.items.length - 1].meritAfter, 100);
  assert.deepEqual(balances(env, '0912111121'), { merit: 124, quota: 124 });

  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912111121', password);
    const page = await request(app.base, jar, `/users/${user.id}/merit`);
    assert.equal(page.text.match(/data-ledger="/g).length, 20);
    assert.match(page.text, new RegExp(`href="/users/${user.id}/merit\\?before=${first.nextBefore}"`));
    assert.match(page.text, /載入更多/);
    const more = await request(app.base, jar, `/users/${user.id}/merit?before=${first.nextBefore}`);
    assert.equal(more.text.match(/data-ledger="/g).length, 5);
    assert.match(more.text, /data-type="註冊起始"/);
    assert.equal(more.text.includes('載入更多'), false);
    assert.equal(more.text.includes(`data-ledger="${first.items[0].id}"`), false);
  } finally {
    await close(app.server);
    env.close();
  }
});
