const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, migrate } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-announce-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
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
  const app = createApp({ db, sessionSecret: 'announce-secret', cookieSecure: false });
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

function countAnnouncements(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n;
}

test('創辦人可以發布、修改與撤下站內公告', async () => {
  const env = setup();
  const columns = env.db.prepare('PRAGMA table_info(users)').all();
  migrate(env.db);
  assert.deepEqual(env.db.prepare('PRAGMA table_info(users)').all(), columns);
  const password = 'founder-password';
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912777109',
    FOUNDER_PASSWORD: password,
  });
  const founder = env.services.findByMobile('0912777109');
  const meritBefore = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(founder.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912777109', password);
    const admin = await request(app.base, jar, '/admin');
    assert.match(admin.text, /站內公告/);
    assert.match(admin.text, /name="hours" inputmode="numeric" value="72"/);
    const forged = await request(app.base, jar, '/admin/announcements', {
      _csrf: 'not-the-token',
      body: '不該寫進去',
    });
    assert.equal(forged.status, 303);
    assert.equal(countAnnouncements(env.db), 0);

    const created = await request(app.base, jar, '/admin/announcements', {
      _csrf: csrfOf(admin.text),
      title: '週六維護',
      body: '晚上暫停登入一小時',
      hours: '72',
    });
    assert.equal(created.status, 302);
    assert.equal(created.location, '/admin');
    const row = env.db.prepare('SELECT * FROM announcements').get();
    const span = new Date(row.expires_at) - new Date(row.created_at);
    assert.ok(Math.abs(span - 72 * 60 * 60 * 1000) < 5000);
    assert.equal(row.removed_at, null);
    assert.deepEqual(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(founder.id), meritBefore);

    const home = await request(app.base, jar, '/');
    assert.match(home.text, /週六維護/);
    assert.match(home.text, /晚上暫停登入一小時/);
    assert.match(home.text, />知道了</);
    const guest = await request(app.base, cookieJar(), '/');
    assert.match(guest.text, /晚上暫停登入一小時/);
    assert.equal(guest.text.includes('知道了'), false);

    const edited = await request(app.base, jar, `/admin/announcements/${row.id}`, {
      _csrf: csrfOf(admin.text),
      title: '週日維護',
      body: '改到週日早上',
      hours: '48',
    });
    assert.equal(edited.status, 302);
    const afterEdit = await request(app.base, jar, '/');
    assert.match(afterEdit.text, /改到週日早上/);
    assert.equal(afterEdit.text.includes('晚上暫停登入一小時'), false);

    const removed = await request(app.base, jar, `/admin/announcements/${row.id}/remove`, {
      _csrf: csrfOf(admin.text),
    });
    assert.equal(removed.status, 302);
    assert.notEqual(env.db.prepare('SELECT removed_at FROM announcements WHERE id = ?').get(row.id).removed_at, null);
    const afterRemove = await request(app.base, jar, '/');
    assert.equal(afterRemove.text.includes('改到週日早上'), false);
    assert.equal(countAnnouncements(env.db), 1);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('一般會員不能發布或修改公告', async () => {
  const env = setup();
  const password = 'member-password';
  const member = env.services.registerWithPassword('0912777201', '會員', password, password);
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912777209',
    FOUNDER_PASSWORD: 'founder-password',
  });
  const founder = env.services.findByMobile('0912777209');
  const announcement = env.services.createAnnouncement(founder.id, { body: '只有創辦人能改' });
  assert.throws(() => env.services.createAnnouncement(member.id, { body: '會員自發' }), /只有創辦人/);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912777201', password);
    const page = await request(app.base, jar, '/me');
    const token = csrfOf(page.text);
    const create = await request(app.base, jar, '/admin/announcements', {
      _csrf: token,
      body: '會員自發',
    });
    const edit = await request(app.base, jar, `/admin/announcements/${announcement.id}`, {
      _csrf: token,
      body: '會員改寫',
    });
    const remove = await request(app.base, jar, `/admin/announcements/${announcement.id}/remove`, {
      _csrf: token,
    });
    assert.equal(create.status, 403);
    assert.equal(edit.status, 403);
    assert.equal(remove.status, 403);
    const stored = env.db.prepare('SELECT body, removed_at FROM announcements WHERE id = ?').get(announcement.id);
    assert.equal(stored.body, '只有創辦人能改');
    assert.equal(stored.removed_at, null);
    assert.equal(countAnnouncements(env.db), 1);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('到期的公告不會出現在廣場', async () => {
  const env = setup();
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912777309',
    FOUNDER_PASSWORD: 'founder-password',
  });
  const founder = env.services.findByMobile('0912777309');
  const announcement = env.services.createAnnouncement(founder.id, { title: '舊公告', body: '這則已經到期' });
  env.db.prepare(`UPDATE announcements SET expires_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', announcement.id);
  const app = await listen(env.db);
  try {
    const home = await request(app.base, cookieJar(), '/');
    assert.equal(home.status, 200);
    assert.equal(home.text.includes('這則已經到期'), false);
    assert.equal(home.text.includes('data-announcement'), false);
    assert.equal(env.services.currentAnnouncement(null), null);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('會員按知道了之後，同一則公告不再出現', async () => {
  const env = setup();
  const password = 'member-password';
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912777409',
    FOUNDER_PASSWORD: 'founder-password',
  });
  const founder = env.services.findByMobile('0912777409');
  const announcement = env.services.createAnnouncement(founder.id, { body: '請看這一次就好' });
  env.services.registerWithPassword('0912777401', '甲', password, password);
  env.services.registerWithPassword('0912777402', '乙', password, password);
  const app = await listen(env.db);
  const jarA = cookieJar();
  const jarB = cookieJar();
  try {
    await signIn(app.base, jarA, '0912777401', password);
    await signIn(app.base, jarB, '0912777402', password);
    const first = await request(app.base, jarA, '/');
    assert.match(first.text, /請看這一次就好/);
    const forged = await request(app.base, jarA, `/announcements/${announcement.id}/dismiss`, {
      _csrf: 'not-the-token',
    });
    assert.equal(forged.status, 303);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM announcement_dismissals').get().n, 0);
    const dismissed = await request(app.base, jarA, `/announcements/${announcement.id}/dismiss`, {
      _csrf: csrfOf(first.text),
    });
    assert.equal(dismissed.status, 302);
    const again = await request(app.base, jarA, '/');
    assert.equal(again.text.includes('請看這一次就好'), false);
    assert.match(again.text, /已知道這則公告/);
    const other = await request(app.base, jarB, '/');
    assert.match(other.text, /請看這一次就好/);
    await request(app.base, jarA, `/announcements/${announcement.id}/dismiss`, {
      _csrf: csrfOf(again.text),
    });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM announcement_dismissals').get().n, 1);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('新的公告會再出現，舊的已讀不會擋到它', async () => {
  const env = setup();
  const password = 'member-password';
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912777509',
    FOUNDER_PASSWORD: 'founder-password',
  });
  const founder = env.services.findByMobile('0912777509');
  const first = env.services.createAnnouncement(founder.id, { body: '第一則公告' });
  const member = env.services.registerWithPassword('0912777501', '甲', password, password);
  env.services.dismissAnnouncement(member.id, first.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912777501', password);
    const hidden = await request(app.base, jar, '/');
    assert.equal(hidden.text.includes('第一則公告'), false);
    const founderJar = cookieJar();
    await signIn(app.base, founderJar, '0912777509', 'founder-password');
    const admin = await request(app.base, founderJar, '/admin');
    const created = await request(app.base, founderJar, '/admin/announcements', {
      _csrf: csrfOf(admin.text),
      body: '第二則公告',
    });
    assert.equal(created.status, 302);
    const home = await request(app.base, jar, '/');
    assert.match(home.text, /第二則公告/);
    assert.equal(home.text.includes('第一則公告'), false);
    assert.match(home.text, />知道了</);
  } finally {
    await close(app.server);
    env.close();
  }
});
