const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-onboarding-'));
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
  const app = createApp({ db, sessionSecret: 'onboarding-secret', cookieSecure: false });
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

function step(card, id) {
  return card.steps.find((item) => item.id === id);
}

function balances(env, mobile) {
  const user = env.services.findByMobile(mobile);
  return { merit: user.merit, quota: user.quota, dismissed: user.onboarding_dismissed_at };
}

test('四個步驟各自用現有資料判斷', () => {
  const env = setup();
  try {
    const fresh = env.services.registerWithPassword('0912444101', '新手', 'password-ok', 'password-ok');
    const card = env.services.onboardingFor(fresh.id);
    assert.equal(card.done, 0);
    assert.equal(card.total, 4);
    assert.equal(card.complete, false);
    assert.equal(step(card, 'profile').done, false);
    assert.equal(step(card, 'profile').href, '/account');
    assert.equal(step(card, 'profile').label, '填好暱稱和自我介紹');
    assert.equal(step(card, 'city').done, false);
    assert.equal(step(card, 'city').href, '/account');
    assert.equal(step(card, 'rules').done, false);
    assert.equal(step(card, 'rules').href, '/rules');
    assert.equal(step(card, 'start').done, false);
    assert.equal(step(card, 'start').href, '/posts/new');
    assert.equal(balances(env, '0912444101').merit, 100);
    assert.equal(balances(env, '0912444101').quota, 100);

    env.services.updateAvailability(fresh.id, '週末有空');
    assert.equal(step(env.services.onboardingFor(fresh.id), 'profile').done, true);
    env.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('   ', fresh.id);
    assert.equal(step(env.services.onboardingFor(fresh.id), 'profile').done, false);
    env.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('新手', fresh.id);
    assert.equal(step(env.services.onboardingFor(fresh.id), 'profile').done, true);

    env.services.updateAccountPlace(fresh.id, { city: '新北市' });
    assert.equal(step(env.services.onboardingFor(fresh.id), 'city').done, true);

    env.services.acknowledgeRules(fresh.id);
    assert.equal(step(env.services.onboardingFor(fresh.id), 'rules').done, true);
    assert.equal(balances(env, '0912444101').merit, 100);
    assert.equal(balances(env, '0912444101').quota, 100);

    const posted = env.services.createPost(fresh.id, {
      kind: 'need',
      category: 'food',
      description: '需要一份便當',
      amount: 10,
      city: '臺北市',
    });
    assert.equal(step(env.services.onboardingFor(fresh.id), 'start').done, true);
    env.services.cancelPost(posted.id, fresh.id);
    assert.equal(step(env.services.onboardingFor(fresh.id), 'start').done, true);
    assert.equal(env.services.onboardingFor(fresh.id).complete, true);
    assert.equal(balances(env, '0912444101').dismissed, null);
    assert.equal(balances(env, '0912444101').merit, 100);
    assert.equal(balances(env, '0912444101').quota, 100);

    const taker = env.services.registerWithPassword('0912444102', '接下的人', 'password-ok', 'password-ok');
    const offer = env.services.createPost(fresh.id, {
      kind: 'offer',
      category: 'transport',
      description: '可以順路載',
      amount: 8,
      city: '臺北市',
    });
    assert.equal(step(env.services.onboardingFor(taker.id), 'start').done, false);
    env.services.acceptPost(offer.id, taker.id);
    assert.equal(step(env.services.onboardingFor(taker.id), 'start').done, true);
    assert.equal(step(env.services.onboardingFor(taker.id), 'profile').done, false);
    assert.equal(balances(env, '0912444102').merit, 100);
    assert.equal(balances(env, '0912444102').quota, 100);
  } finally {
    env.close();
  }
});

test('先不要顯示會收起卡片，功德和額度不變', async () => {
  const env = setup();
  const password = 'password-ok';
  const user = env.services.registerWithPassword('0912444103', '先跳過', password, password);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    const guest = await request(app.base, cookieJar(), '/');
    assert.equal(guest.text.includes('新手上手'), false);
    assert.equal(guest.text.includes('data-onboarding'), false);
    assert.match(guest.text, /廣場還沒有招募中的貼文/);

    await signIn(app.base, jar, '0912444103', password);
    const home = await request(app.base, jar, '/');
    assert.match(home.text, /新手上手 0\/4/);
    assert.match(home.text, /data-onboarding="0\/4"/);
    assert.match(home.text, /data-step="profile" data-done="0"/);
    assert.match(home.text, /data-step="city" data-done="0"/);
    assert.match(home.text, /data-step="rules" data-done="0"/);
    assert.match(home.text, /data-step="start" data-done="0"/);
    assert.match(home.text, /href="\/account"/);
    assert.match(home.text, /href="\/rules"/);
    assert.match(home.text, /href="\/posts\/new"/);
    assert.match(home.text, /先不要顯示/);

    const forged = await request(app.base, jar, '/onboarding/dismiss', { _csrf: 'nope' });
    assert.equal(forged.status, 303);
    assert.equal(forged.location, '/');
    assert.equal(balances(env, '0912444103').dismissed, null);
    assert.equal(balances(env, '0912444103').merit, 100);
    assert.equal(balances(env, '0912444103').quota, 100);
    const still = await request(app.base, jar, '/');
    assert.match(still.text, /新手上手 0\/4/);

    const dismissed = await request(app.base, jar, '/onboarding/dismiss', { _csrf: csrfOf(still.text) });
    assert.equal(dismissed.status, 302);
    assert.equal(dismissed.location, '/');
    assert.ok(balances(env, '0912444103').dismissed);
    assert.equal(balances(env, '0912444103').merit, 100);
    assert.equal(balances(env, '0912444103').quota, 100);
    const hidden = await request(app.base, jar, '/');
    assert.equal(hidden.text.includes('新手上手'), false);
    assert.equal(hidden.text.includes('先不要顯示'), false);
    assert.equal(env.services.onboardingFor(user.id), null);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('四項都完成時顯示一次完成，之後不再出現', async () => {
  const env = setup();
  const password = 'password-ok';
  const user = env.services.registerWithPassword('0912444104', '快完成', password, password);
  env.services.updateAvailability(user.id, '平日晚上');
  env.services.updateAccountPlace(user.id, { city: '臺中市' });
  env.services.acknowledgeRules(user.id);
  env.services.createPost(user.id, {
    kind: 'need',
    category: 'other',
    description: '需要幫忙搬家',
    amount: 12,
    city: '臺中市',
  });
  assert.equal(env.services.onboardingFor(user.id).complete, true);
  assert.equal(balances(env, '0912444104').dismissed, null);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912444104', password);
    const once = await request(app.base, jar, '/');
    assert.match(once.text, /data-onboarding="complete"/);
    assert.match(once.text, /新手上手 4\/4/);
    assert.match(once.text, /完成！/);
    assert.equal(once.text.includes('先不要顯示'), false);
    assert.ok(balances(env, '0912444104').dismissed);
    assert.equal(balances(env, '0912444104').merit, 100);
    assert.equal(balances(env, '0912444104').quota, 100);
    const again = await request(app.base, jar, '/');
    assert.equal(again.text.includes('新手上手'), false);
    assert.equal(again.text.includes('完成！'), false);
    assert.equal(balances(env, '0912444104').merit, 100);
    assert.equal(balances(env, '0912444104').quota, 100);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('已完成過互助的會員不會看到新手卡，功德和額度不變', async () => {
  const env = setup();
  const password = 'password-ok';
  const host = env.services.registerWithPassword('0912444105', '老手', password, password);
  const seeker = env.services.registerWithPassword('0912444106', '另一位老手', password, password);
  const author = env.services.registerWithPassword('0912444107', '原發布者', password, password);
  const beforeHost = balances(env, '0912444105');
  const beforeSeeker = balances(env, '0912444106');
  env.db.prepare(`
    INSERT INTO posts (
      author_id, kind, category, description, amount, status, created_at, host_id, seeker_id
    ) VALUES (?, 'need', 'food', '早就完成的互助', 10, 'settled', ?, ?, ?)
  `).run(author.id, '2026-10-01T00:00:00.000Z', host.id, seeker.id);
  assert.equal(env.services.onboardingFor(host.id), null);
  assert.equal(env.services.onboardingFor(seeker.id), null);
  assert.deepEqual(balances(env, '0912444105'), beforeHost);
  assert.deepEqual(balances(env, '0912444106'), beforeSeeker);
  assert.equal(env.services.onboardingFor(author.id).steps.find((item) => item.id === 'start').done, true);

  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912444105', password);
    const home = await request(app.base, jar, '/');
    assert.equal(home.text.includes('新手上手'), false);
    assert.equal(home.text.includes('data-onboarding'), false);
    assert.equal(balances(env, '0912444105').merit, 100);
    assert.equal(balances(env, '0912444105').quota, 100);
    assert.equal(balances(env, '0912444105').dismissed, null);
  } finally {
    await close(app.server);
    env.close();
  }
});
