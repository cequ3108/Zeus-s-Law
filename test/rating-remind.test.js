const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { formatTaipei } = require('../src/time');
const remind = require('../public/rating-remind');

const NOW = new Date('2026-10-20T04:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-rating-remind-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, { now: () => NOW });
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

function settle(env, author, helper, title) {
  const post = env.services.createPost(author.id, {
    kind: 'offer',
    category: 'food',
    city: '臺北市',
    amount: 10,
    description: title,
    title,
  });
  env.services.acceptPost(post.id, helper.id);
  env.services.submitValue(post.id, author.id, 4);
  const result = env.services.submitValue(post.id, helper.id, 4);
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
  const app = createApp({ db, now: () => NOW, sessionSecret: 'remind-secret', cookieSecure: false });
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

test('未評分會出現，評完消失，超過十四天不提醒，仍可評分且餘額不變', () => {
  const env = setup();
  try {
    const author = env.services.registerWithPassword('0912333101', '提供的人', 'password-ok', 'password-ok');
    const helper = env.services.registerWithPassword('0912333102', '接受的人', 'password-ok', 'password-ok');
    assert.equal(env.services.pendingRatings(author.id).total, 0);
    const id = settle(env, author, helper, '要評的便當');
    const after = balances(env, '0912333101');
    const other = balances(env, '0912333102');

    const mine = env.services.pendingRatings(author.id);
    const theirs = env.services.pendingRatings(helper.id);
    assert.equal(mine.total, 1);
    assert.equal(mine.items[0].otherName, '接受的人');
    assert.equal(mine.items[0].title, '要評的便當');
    assert.equal(mine.items[0].href, `/posts/${id}#rate`);
    assert.equal(theirs.total, 1);
    assert.equal(theirs.items[0].otherName, '提供的人');
    assert.deepEqual(balances(env, '0912333101'), after);
    assert.deepEqual(balances(env, '0912333102'), other);

    env.services.rate(id, author.id, 5, '');
    assert.equal(env.services.pendingRatings(author.id).total, 0);
    assert.equal(env.services.pendingRatings(helper.id).total, 1);
    assert.deepEqual(balances(env, '0912333101'), after);
    assert.deepEqual(balances(env, '0912333102'), other);

    const tooOld = new Date(NOW.getTime() - 14 * DAY - 1).toISOString();
    env.db.prepare('UPDATE posts SET settled_at = ? WHERE id = ?').run(tooOld, id);
    assert.equal(env.services.pendingRatings(helper.id).total, 0);
    env.services.rate(id, helper.id, 4, '');
    assert.equal(env.db.prepare('SELECT stars FROM ratings WHERE post_id = ? AND rater_id = ?').get(id, helper.id).stars, 4);
    assert.deepEqual(balances(env, '0912333101'), after);
    assert.deepEqual(balances(env, '0912333102'), other);

    const edgeHelper = env.services.registerWithPassword('0912333103', '剛好十四天', 'password-ok', 'password-ok');
    const edgeId = settle(env, author, edgeHelper, '邊界的便當');
    const edgeAt = new Date(NOW.getTime() - 14 * DAY).toISOString();
    env.db.prepare('UPDATE posts SET settled_at = ? WHERE id = ?').run(edgeAt, edgeId);
    const edge = env.services.pendingRatings(edgeHelper.id);
    assert.equal(edge.total, 1);
    assert.equal(edge.items[0].title, '邊界的便當');
    assert.equal(edge.items[0].settledAt, edgeAt);
  } finally {
    env.close();
  }
});

test('首頁列出最多三筆，徽章在有待評分時才出現，外人看不到', async () => {
  const env = setup();
  const password = 'password-ok';
  const author = env.services.registerWithPassword('0912333111', '提供的人', password, password);
  const helpers = ['甲', '乙', '丙', '丁'].map((name, index) => (
    env.services.registerWithPassword(`091233311${index + 2}`, name, password, password)
  ));
  env.services.registerWithPassword('0912333116', '路人', password, password);
  const founder = env.services.ensureFounderAccount('0912333199', 'founder-password');
  env.services.createAnnouncement(founder.user.id, { title: '站內公告', body: '記得給對方評分' });
  const ids = helpers.map((helper, index) => settle(env, author, helper, `第${index + 1}筆`));
  ids.forEach((id, index) => {
    env.db.prepare('UPDATE posts SET settled_at = ? WHERE id = ?').run(
      new Date(NOW.getTime() - (ids.length - 1 - index) * 60 * 60 * 1000).toISOString(),
      id,
    );
  });
  const snap = balances(env, '0912333111');
  assert.equal(env.services.pendingRatings(author.id).total, 4);
  assert.deepEqual(env.services.pendingRatings(author.id).items.map((item) => item.title), ['第4筆', '第3筆', '第2筆', '第1筆']);
  assert.deepEqual(balances(env, '0912333111'), snap);

  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    const guest = await request(app.base, cookieJar(), '/');
    assert.equal(guest.text.includes('還沒給對方評分'), false);
    assert.equal(guest.text.includes('data-rating-due'), false);
    assert.equal(guest.text.includes('data-rating-remind'), false);

    await signIn(app.base, jar, '0912333111', password);
    const home = await request(app.base, jar, '/');
    assert.match(home.text, /你有 4 筆互助還沒給對方評分/);
    assert.match(home.text, /data-rating-remind="4"/);
    assert.match(home.text, /data-rating-due="4"/);
    assert.match(home.text, /查看全部/);
    assert.match(home.text, /href="\/me#pending-ratings"/);
    assert.match(home.text, /稍後再說/);
    assert.match(home.text, /rating-remind\.js/);
    const cardAt = home.text.indexOf('data-rating-remind');
    assert.ok(home.text.indexOf('data-announcement') < cardAt);
    assert.ok(cardAt < home.text.indexOf('class="hero"'));
    for (const title of ['第4筆', '第3筆', '第2筆']) {
      assert.match(home.text, new RegExp(title));
      assert.match(home.text, new RegExp(`href="/posts/\\d+#rate"`));
    }
    const newest = env.services.pendingRatings(author.id).items[0];
    assert.match(home.text, new RegExp(formatTaipei(newest.settledAt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const card = home.text.slice(cardAt, home.text.indexOf('class="hero"'));
    assert.equal(card.includes('第1筆'), false);
    assert.deepEqual(balances(env, '0912333111'), snap);

    const mine = await request(app.base, jar, '/me');
    assert.match(mine.text, /id="pending-ratings"/);
    assert.match(mine.text, /data-rating-due-list="4"/);
    for (const title of ['第4筆', '第3筆', '第2筆', '第1筆']) assert.match(mine.text, new RegExp(title));
    assert.match(mine.text, /data-rating-due="4"/);

    env.services.rate(ids[3], author.id, 5, '');
    const less = await request(app.base, jar, '/');
    assert.match(less.text, /你有 3 筆互助還沒給對方評分/);
    assert.equal(less.text.includes('查看全部'), false);
    assert.match(less.text, /data-rating-due="3"/);
    assert.equal(less.text.includes('第4筆'), false);
    assert.deepEqual(balances(env, '0912333111'), snap);

    const stranger = cookieJar();
    await signIn(app.base, stranger, '0912333116', password);
    const hidden = await request(app.base, stranger, '/');
    assert.equal(hidden.text.includes('還沒給對方評分'), false);
    assert.equal(hidden.text.includes('data-rating-due'), false);
    assert.equal(hidden.text.includes('data-rating-remind'), false);
    const strangerMe = await request(app.base, stranger, '/me');
    assert.equal(strangerMe.text.includes('id="pending-ratings"'), false);
    assert.equal(strangerMe.text.includes('data-rating-due'), false);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('稍後再說只收起當天，記在這支瀏覽器', () => {
  function cardFor(userId, day) {
    const button = {
      listeners: [],
      addEventListener(type, fn) { if (type === 'click') this.listeners.push(fn); },
      click() { this.listeners.forEach((fn) => fn()); },
    };
    return {
      hidden: false,
      button,
      getAttribute(name) {
        if (name === 'data-remind-user') return userId;
        if (name === 'data-remind-day') return day;
        return null;
      },
      querySelector(selector) {
        return selector === '[data-remind-dismiss]' ? button : null;
      },
    };
  }
  function documentFor(card) {
    return {
      querySelector(selector) {
        return selector === '[data-rating-remind]' ? card : null;
      },
    };
  }
  const storage = {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
    setItem(key, value) { this.map.set(String(key), String(value)); },
  };
  const today = cardFor('7', '2026-10-20');
  remind.mount(documentFor(today), storage);
  assert.equal(today.hidden, false);
  today.button.click();
  assert.equal(today.hidden, true);
  assert.equal(storage.getItem(remind.keyFor('7', '2026-10-20')), '1');

  const sameDay = cardFor('7', '2026-10-20');
  remind.mount(documentFor(sameDay), storage);
  assert.equal(sameDay.hidden, true);

  const nextDay = cardFor('7', '2026-10-21');
  remind.mount(documentFor(nextDay), storage);
  assert.equal(nextDay.hidden, false);

  const other = cardFor('8', '2026-10-20');
  remind.mount(documentFor(other), storage);
  assert.equal(other.hidden, false);
});
