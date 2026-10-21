const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-tags-'));
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
  const app = createApp({ db, sessionSecret: 'tag-secret', cookieSecure: false });
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

function settle(services, host, guest) {
  const post = services.createPost(host.id, {
    kind: 'offer',
    category: 'food',
    description: '一份便當',
    amount: 10,
    city: '臺北市',
  });
  services.acceptPost(post.id, guest.id);
  services.submitValue(post.id, host.id, 8);
  assert.equal(services.submitValue(post.id, guest.id, 8).status, 'settled');
  return post;
}

test('不選標籤也可以送出星等', async () => {
  const env = setup();
  const password = 'rate-password';
  const host = env.services.registerWithPassword('0912888101', '主人', password, password);
  const guest = env.services.registerWithPassword('0912888102', '客人', password, password);
  const post = settle(env.services, host, guest);
  const before = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(host.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    env.services.rate(post.id, guest.id, 5, '沒有標籤');
    const rating = env.db.prepare('SELECT stars, comment FROM ratings').get();
    assert.equal(rating.stars, 5);
    assert.equal(rating.comment, '沒有標籤');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM rating_tags').get().n, 0);
    assert.deepEqual(env.services.getProfile(host.id).tags, []);
    assert.deepEqual(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(host.id), before);

    const other = env.services.registerWithPassword('0912888103', '另一位', password, password);
    const another = settle(env.services, host, other);
    await signIn(app.base, jar, '0912888103', password);
    const page = await request(app.base, jar, `/posts/${another.id}`);
    assert.match(page.text, /name="tags" value="準時"/);
    assert.match(page.text, /name="_csrf"/);
    const forged = await request(app.base, jar, `/posts/${another.id}/rating`, {
      _csrf: 'not-the-token',
      stars: '4',
    });
    assert.equal(forged.status, 303);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings WHERE post_id = ?').get(another.id).n, 0);
    const saved = await request(app.base, jar, `/posts/${another.id}/rating`, {
      _csrf: csrfOf(page.text),
      stars: '4',
    });
    assert.equal(saved.status, 302);
    const stored = env.db.prepare('SELECT stars FROM ratings WHERE post_id = ?').get(another.id);
    assert.equal(stored.stars, 4);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM rating_tags WHERE rating_id = (SELECT id FROM ratings WHERE post_id = ?)').get(another.id).n, 0);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('正向標籤最多三個，超過就整筆不存', () => {
  const env = setup();
  try {
    const host = env.services.register('0912888201', '主人');
    const guest = env.services.register('0912888202', '客人');
    const post = settle(env.services, host, guest);
    assert.throws(
      () => env.services.rate(post.id, guest.id, 5, '', ['準時', '親切', '溝通清楚', '份量實在']),
      /最多選 3/,
    );
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings').get().n, 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM rating_tags').get().n, 0);
    env.services.rate(post.id, guest.id, 5, '', ['準時', '準時', '親切', '守約']);
    assert.equal(env.db.prepare('SELECT stars FROM ratings').get().stars, 5);
    assert.deepEqual(
      env.db.prepare('SELECT tag FROM rating_tags ORDER BY tag').all().map((row) => row.tag),
      ['守約', '準時', '親切'].sort(),
    );
  } finally {
    env.close();
  }
});

test('不在清單裡的標籤會被拒絕', () => {
  const env = setup();
  try {
    const host = env.services.register('0912888301', '主人');
    const guest = env.services.register('0912888302', '客人');
    const post = settle(env.services, host, guest);
    assert.throws(() => env.services.rate(post.id, guest.id, 3, '', ['遲到']), /正向標籤/);
    assert.throws(() => env.services.rate(post.id, guest.id, 3, '', ['準時', '態度差']), /正向標籤/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings').get().n, 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM rating_tags').get().n, 0);
    assert.deepEqual(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(host.id), { merit: 108, quota: 108 });
  } finally {
    env.close();
  }
});

test('個人頁只顯示收到最多的三個正向標籤', async () => {
  const env = setup();
  const password = 'rate-password';
  const host = env.services.registerWithPassword('0912888401', '主人', password, password);
  const guests = [
    ['0912888402', ['準時', '親切', '份量實在']],
    ['0912888403', ['準時', '親切', '守約']],
    ['0912888404', ['準時', '溝通清楚']],
  ];
  for (const [mobile, tags] of guests) {
    const guest = env.services.register(mobile, mobile);
    const post = settle(env.services, host, guest);
    env.services.rate(post.id, guest.id, 5, '', tags);
  }
  const app = await listen(env.db);
  try {
    assert.deepEqual(env.services.getProfile(host.id).tags, [
      { tag: '準時', count: 3 },
      { tag: '親切', count: 2 },
      { tag: '份量實在', count: 1 },
    ]);
    const home = await request(app.base, cookieJar(), `/users/${host.id}`);
    assert.match(home.text, /準時 ×3/);
    assert.match(home.text, /親切 ×2/);
    assert.match(home.text, /份量實在 ×1/);
    assert.equal(home.text.includes('守約'), false);
    assert.equal(home.text.includes('溝通清楚'), false);
    assert.equal(home.text.includes('乾淨整潔'), false);
  } finally {
    await close(app.server);
    env.close();
  }
});
