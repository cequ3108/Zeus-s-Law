const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { lastSeenLabel, LAST_SEEN_INTERVAL_MS } = require('../src/time');

const START = '2026-10-20T04:00:00.000Z';
const LABELS = ['今天上線', '3天內上線', '一週內上線', '超過一週'];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-seen-'));
  const db = openDatabase(path.join(dir, 't.db'));
  let current = new Date(START);
  const services = createServices(db, { now: () => new Date(current) });
  return {
    db,
    services,
    setNow(value) { current = new Date(value); },
    now() { return new Date(current); },
    seen(id) {
      return db.prepare('SELECT last_seen_at, hide_last_seen, merit, quota FROM users WHERE id = ?').get(id);
    },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('上線時間十分鐘內只寫一次', () => {
  const env = setup();
  try {
    const user = env.services.register('0912666001', '作者');
    assert.equal(env.seen(user.id).last_seen_at, null);
    env.services.touchLastSeen(user.id);
    const first = env.seen(user.id).last_seen_at;
    assert.equal(first, START);
    env.services.touchLastSeen(user.id);
    assert.equal(env.seen(user.id).last_seen_at, first);
    env.setNow(new Date(new Date(START).getTime() + LAST_SEEN_INTERVAL_MS - 1).toISOString());
    env.services.touchLastSeen(user.id);
    assert.equal(env.seen(user.id).last_seen_at, first);
    const later = new Date(new Date(START).getTime() + LAST_SEEN_INTERVAL_MS).toISOString();
    env.setNow(later);
    env.services.touchLastSeen(user.id);
    assert.equal(env.seen(user.id).last_seen_at, later);
    assert.equal(env.seen(user.id).merit, 100);
    assert.equal(env.seen(user.id).quota, 100);
  } finally {
    env.close();
  }
});

test('上線狀態只分成今天、三天、一週和超過一週', () => {
  const now = new Date('2026-10-20T04:00:00.000Z');
  assert.equal(lastSeenLabel(null, now), '');
  assert.equal(lastSeenLabel('', now), '');
  assert.equal(lastSeenLabel('不是時間', now), '');
  assert.equal(lastSeenLabel('2026-10-19T16:30:00.000Z', now), '今天上線');
  assert.equal(lastSeenLabel('2026-10-19T15:30:00.000Z', now), '3天內上線');
  assert.equal(lastSeenLabel(new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(), now), '3天內上線');
  assert.equal(lastSeenLabel(new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000 - 1).toISOString(), now), '一週內上線');
  assert.equal(lastSeenLabel(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), now), '一週內上線');
  assert.equal(lastSeenLabel(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 - 1).toISOString(), now), '超過一週');
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

async function listen(env) {
  const app = createApp({
    db: env.db,
    now: () => env.now(),
    sessionSecret: 'seen-secret',
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
  if (jar && jar.header()) headers.cookie = jar.header();
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
  if (jar) jar.absorb(response);
  return { status: response.status, text: await response.text(), location: response.headers.get('location') };
}

function csrfOf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, '頁面應有 CSRF');
  return match[1];
}

async function login(base, jar, mobile, password) {
  const page = await request(base, jar, '/login');
  const response = await request(base, jar, '/login/password', {
    _csrf: csrfOf(page.text),
    mobile,
    password,
  });
  assert.equal(response.status, 302);
  return response;
}

test('沒有上線時間就不顯示，隱藏後其他人看不到，十分鐘內的請求不會重寫', async () => {
  const env = setup();
  const web = await listen(env);
  try {
    const author = env.services.registerWithPassword('0912666002', '作者', 'author-pass-1', 'author-pass-1');
    const helper = env.services.registerWithPassword('0912666003', '幫手', 'helper-pass-1', 'helper-pass-1');
    const quiet = env.services.register('0912666004', '安靜');
    const post = env.services.createPost(author.id, {
      kind: 'need', category: 'food', description: '便當一份', amount: 20, city: '臺北市', title: '作者便當',
    });
    env.services.createPost(quiet.id, {
      kind: 'offer', category: 'food', description: '可以分', amount: 20, city: '臺北市', title: '安靜便當',
    });
    env.services.touchLastSeen(author.id);
    env.services.touchLastSeen(helper.id);
    const stamp = env.seen(author.id).last_seen_at;
    assert.equal(env.seen(quiet.id).last_seen_at, null);

    const guestHome = await request(web.base, null, '/?city=all');
    assert.equal(guestHome.text.includes('今天上線'), true);
    assert.equal(guestHome.text.includes(stamp), false);
    const quietStart = guestHome.text.indexOf('安靜便當');
    const quietEnd = guestHome.text.indexOf('作者便當', quietStart + 1);
    const quietCard = guestHome.text.slice(quietStart, quietEnd === -1 ? undefined : quietEnd);
    for (const label of LABELS) assert.equal(quietCard.includes(label), false);

    const guestProfile = await request(web.base, null, `/users/${quiet.id}`);
    for (const label of LABELS) assert.equal(guestProfile.text.includes(label), false);
    const authorProfile = await request(web.base, null, `/users/${author.id}`);
    assert.equal(authorProfile.text.includes('今天上線'), true);
    assert.equal(authorProfile.text.includes(stamp), false);
    assert.equal(authorProfile.text.includes('不顯示我的上線狀態'), false);

    env.services.acceptPost(post.id, helper.id);
    const detail = await request(web.base, null, `/posts/${post.id}`);
    assert.equal(detail.text.includes('今天上線'), true);
    const hostAt = detail.text.indexOf('>作者</a>');
    const seekerAt = detail.text.indexOf('>幫手</a>');
    assert.match(detail.text.slice(hostAt, hostAt + 120), /今天上線/);
    assert.match(detail.text.slice(seekerAt, seekerAt + 120), /今天上線/);

    const jar = cookieJar();
    await login(web.base, jar, '0912666002', 'author-pass-1');
    assert.equal(env.seen(author.id).last_seen_at, stamp);
    env.setNow(new Date(new Date(START).getTime() + LAST_SEEN_INTERVAL_MS - 1).toISOString());
    const early = await request(web.base, jar, '/account');
    assert.equal(early.status, 200);
    assert.equal(early.text.includes('不顯示我的上線狀態'), true);
    assert.equal(env.seen(author.id).last_seen_at, stamp);

    const forged = await request(web.base, jar, '/account/last-seen', { hide_last_seen: '1' });
    assert.equal(forged.status, 303);
    assert.equal(env.seen(author.id).hide_last_seen, 0);

    const saved = await request(web.base, jar, '/account/last-seen', {
      _csrf: csrfOf(early.text),
      hide_last_seen: '1',
    });
    assert.equal(saved.status, 302);
    assert.equal(env.seen(author.id).hide_last_seen, 1);
    assert.equal(env.seen(author.id).merit, 100);
    assert.equal(env.seen(author.id).quota, 100);

    const hiddenHome = await request(web.base, null, '/?city=all');
    assert.equal(hiddenHome.text.includes('今天上線'), false);
    const hiddenProfile = await request(web.base, null, `/users/${author.id}`);
    for (const label of LABELS) assert.equal(hiddenProfile.text.includes(label), false);

    const own = await request(web.base, jar, `/users/${author.id}`);
    assert.equal(own.text.includes('今天上線'), true);
    assert.equal(own.text.includes('checked'), true);

    const later = new Date(new Date(START).getTime() + LAST_SEEN_INTERVAL_MS).toISOString();
    env.setNow(later);
    await request(web.base, jar, '/me');
    assert.equal(env.seen(author.id).last_seen_at, later);
  } finally {
    await close(web.server);
    env.close();
  }
});
