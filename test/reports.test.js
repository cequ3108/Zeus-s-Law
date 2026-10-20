const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

const NOW = new Date('2026-10-20T04:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-reports-'));
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
  const app = createApp({ db, now: () => NOW, sessionSecret: 'report-secret', cookieSecure: false });
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

function reportCount(env) {
  return env.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n;
}

test('可以檢舉貼文和會員，對方和其他人看不到內容', async () => {
  const env = setup();
  const password = 'password-ok';
  const author = env.services.registerWithPassword('0912222101', '發布的人', password, password);
  const reporter = env.services.registerWithPassword('0912222102', '檢舉的人', password, password);
  const other = env.services.registerWithPassword('0912222103', '另一位', password, password);
  const founder = env.services.ensureFounderAccount('0912222199', 'founder-password');
  const post = env.services.createPost(author.id, {
    kind: 'offer',
    category: 'food',
    city: '臺北市',
    amount: 10,
    description: '一份便當',
    title: '可疑便當',
  });
  const before = balances(env, '0912222101');
  const ledger = env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912222102', password);
    const postPage = await request(app.base, jar, `/posts/${post.id}`);
    assert.match(postPage.text, new RegExp(`href="/posts/${post.id}/report"`));
    const form = await request(app.base, jar, `/posts/${post.id}/report`);
    assert.equal(form.status, 200);
    assert.match(form.text, /要求現金或轉帳/);
    assert.match(form.text, /騷擾或不當言行/);
    assert.match(form.text, /不實或可疑內容/);
    assert.match(form.text, /爽約/);
    assert.match(form.text, /其他/);
    const sent = await request(app.base, jar, `/posts/${post.id}/report`, {
      _csrf: csrfOf(form.text),
      reason: '不實或可疑內容',
      note: '內容跟見面方式對不上',
    });
    assert.equal(sent.status, 302);
    assert.equal(sent.location, `/posts/${post.id}`);
    const done = await request(app.base, jar, sent.location);
    assert.match(done.text, /已收到，創辦人會盡快處理/);
    const row = env.db.prepare('SELECT * FROM reports WHERE target_type = ? AND target_id = ?').get('post', post.id);
    assert.equal(row.reporter_id, reporter.id);
    assert.equal(row.reason, '不實或可疑內容');
    assert.equal(row.note, '內容跟見面方式對不上');
    assert.equal(row.status, 'open');
    assert.equal(row.handled_at, null);
    assert.equal(row.handled_by, null);
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(post.id).status, 'open');
    assert.deepEqual(balances(env, '0912222101'), before);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, ledger);

    const profile = await request(app.base, jar, `/users/${other.id}`);
    assert.match(profile.text, new RegExp(`href="/users/${other.id}/report"`));
    const userForm = await request(app.base, jar, `/users/${other.id}/report`);
    const userSent = await request(app.base, jar, `/users/${other.id}/report`, {
      _csrf: csrfOf(userForm.text),
      reason: '騷擾或不當言行',
      note: '',
    });
    assert.equal(userSent.status, 302);
    assert.equal(userSent.location, `/users/${other.id}`);
    const userRow = env.db.prepare('SELECT * FROM reports WHERE target_type = ? AND target_id = ?').get('user', other.id);
    assert.equal(userRow.reason, '騷擾或不當言行');
    assert.equal(userRow.note, null);
    assert.equal(userRow.status, 'open');

    const authorJar = cookieJar();
    await signIn(app.base, authorJar, '0912222101', password);
    const seen = await request(app.base, authorJar, `/posts/${post.id}`);
    assert.equal(seen.text.includes('檢舉的人'), false);
    assert.equal(seen.text.includes('不實或可疑內容'), false);
    assert.equal(seen.text.includes('內容跟見面方式對不上'), false);
    assert.equal(seen.text.includes(`/posts/${post.id}/report`), false);
    assert.equal(seen.text.includes('data-open-reports'), false);
    const authorProfile = await request(app.base, authorJar, `/users/${author.id}`);
    assert.equal(authorProfile.text.includes(`/users/${author.id}/report`), false);

    const founderJar = cookieJar();
    await signIn(app.base, founderJar, '0912222199', 'founder-password');
    const admin = await request(app.base, founderJar, '/admin');
    assert.match(admin.text, /data-stat="open-reports">2</);
    assert.match(admin.text, /待處理檢舉數/);
    assert.match(admin.text, /data-open-reports="2"/);
    assert.match(admin.text, /可疑便當/);
    assert.match(admin.text, /不實或可疑內容/);
    assert.match(admin.text, /內容跟見面方式對不上/);
    assert.match(admin.text, /檢舉的人/);
    assert.match(admin.text, new RegExp(`href="/posts/${post.id}"`));
    assert.match(admin.text, new RegExp(`href="/users/${other.id}"`));
    assert.match(admin.text, /同一對象共 1 則/);
    const postCard = admin.text.indexOf('可疑便當');
    const userCard = admin.text.indexOf('>另一位<');
    assert.ok(userCard >= 0 && userCard < postCard);
    assert.equal(env.services.openReportCount(), 2);
    assert.equal(founder.user.role, 'founder');
  } finally {
    await close(app.server);
    env.close();
  }
});

test('未登入不能檢舉', async () => {
  const env = setup();
  const author = env.services.registerWithPassword('0912222111', '發布的人', 'password-ok', 'password-ok');
  const post = env.services.createPost(author.id, {
    kind: 'need', category: 'other', city: '臺北市', amount: 5, description: '需要幫忙', title: '需要幫忙',
  });
  const app = await listen(env.db);
  try {
    const page = await request(app.base, cookieJar(), `/posts/${post.id}/report`);
    assert.equal(page.status, 302);
    assert.equal(page.location, '/login');
    const userPage = await request(app.base, cookieJar(), `/users/${author.id}/report`);
    assert.equal(userPage.status, 302);
    assert.equal(userPage.location, '/login');
    const posted = await request(app.base, cookieJar(), `/posts/${post.id}/report`, {
      reason: '其他',
      note: '沒有登入',
    });
    assert.equal(posted.status, 302);
    assert.equal(posted.location, '/login');
    assert.equal(reportCount(env), 0);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('不能檢舉自己或自己的貼文', () => {
  const env = setup();
  try {
    const author = env.services.registerWithPassword('0912222121', '發布的人', 'password-ok', 'password-ok');
    const post = env.services.createPost(author.id, {
      kind: 'offer', category: 'food', city: '臺北市', amount: 8, description: '我的便當', title: '我的便當',
    });
    assert.throws(
      () => env.services.fileReport(author.id, 'post', post.id, { reason: '其他', note: '' }),
      /不能檢舉自己的貼文/,
    );
    assert.throws(
      () => env.services.fileReport(author.id, 'user', author.id, { reason: '爽約' }),
      /不能檢舉自己/,
    );
    assert.equal(reportCount(env), 0);
    assert.deepEqual(balances(env, '0912222121'), { merit: 100, quota: 100 });
  } finally {
    env.close();
  }
});

test('同一人 24 小時內不能重複檢舉同一對象', () => {
  const env = setup();
  try {
    const author = env.services.registerWithPassword('0912222131', '發布的人', 'password-ok', 'password-ok');
    const reporter = env.services.registerWithPassword('0912222132', '檢舉的人', 'password-ok', 'password-ok');
    const post = env.services.createPost(author.id, {
      kind: 'offer', category: 'transport', city: '臺北市', amount: 6, description: '共乘', title: '共乘',
    });
    env.services.fileReport(reporter.id, 'post', post.id, { reason: '爽約', note: '第一次' });
    assert.throws(
      () => env.services.fileReport(reporter.id, 'post', post.id, { reason: '其他', note: '再一次' }),
      /你已經檢舉過了，請 24 小時後再送/,
    );
    assert.equal(reportCount(env), 1);
    env.db.prepare('UPDATE reports SET created_at = ?').run(new Date(NOW.getTime() - DAY + 1).toISOString());
    assert.throws(
      () => env.services.fileReport(reporter.id, 'post', post.id, { reason: '其他' }),
      /你已經檢舉過了/,
    );
    env.db.prepare('UPDATE reports SET created_at = ?').run(new Date(NOW.getTime() - DAY).toISOString());
    const again = env.services.fileReport(reporter.id, 'post', post.id, { reason: '要求現金或轉帳', note: '隔天' });
    assert.equal(reportCount(env), 2);
    assert.equal(env.db.prepare('SELECT reason FROM reports WHERE id = ?').get(again.id).reason, '要求現金或轉帳');
    const userOk = env.services.fileReport(reporter.id, 'user', author.id, { reason: '其他' });
    assert.ok(userOk.id);
  } finally {
    env.close();
  }
});

test('補充說明超過 200 字不能送出', () => {
  const env = setup();
  try {
    const author = env.services.registerWithPassword('0912222141', '發布的人', 'password-ok', 'password-ok');
    const reporter = env.services.registerWithPassword('0912222142', '檢舉的人', 'password-ok', 'password-ok');
    const post = env.services.createPost(author.id, {
      kind: 'need', category: 'food', city: '高雄市', amount: 4, description: '便當', title: '便當',
    });
    env.services.fileReport(reporter.id, 'post', post.id, { reason: '其他', note: '字'.repeat(200) });
    assert.equal(env.db.prepare('SELECT note FROM reports').get().note, '字'.repeat(200));
    const second = env.services.createPost(author.id, {
      kind: 'need', category: 'food', city: '高雄市', amount: 4, description: '另一份', title: '另一份',
    });
    assert.throws(
      () => env.services.fileReport(reporter.id, 'post', second.id, { reason: '其他', note: '字'.repeat(201) }),
      /補充說明請不要超過 200 個字/,
    );
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE target_id = ?').get(second.id).n, 0);
    assert.deepEqual(balances(env, '0912222141'), { merit: 100, quota: 100 });
  } finally {
    env.close();
  }
});

test('不是創辦人不能看也不能處理檢舉，處理後會寫下狀態', async () => {
  const env = setup();
  const password = 'password-ok';
  const author = env.services.registerWithPassword('0912222151', '發布的人', password, password);
  const reporter = env.services.registerWithPassword('0912222152', '檢舉的人', password, password);
  const member = env.services.registerWithPassword('0912222153', '一般會員', password, password);
  const founder = env.services.ensureFounderAccount('0912222198', 'founder-password').user;
  const first = env.services.createPost(author.id, {
    kind: 'offer', category: 'food', city: '臺北市', amount: 5, description: '第一則', title: '第一則',
  });
  const second = env.services.createPost(author.id, {
    kind: 'offer', category: 'food', city: '臺北市', amount: 5, description: '第二則', title: '第二則',
  });
  const resolved = env.services.fileReport(reporter.id, 'post', first.id, { reason: '其他', note: '請看第一則' });
  const dismissed = env.services.fileReport(reporter.id, 'post', second.id, { reason: '要求現金或轉帳', note: '請看第二則' });
  env.services.fileReport(member.id, 'post', first.id, { reason: '其他', note: '我也看到' });
  const before = balances(env, '0912222151');
  const app = await listen(env.db);
  try {
    const memberJar = cookieJar();
    await signIn(app.base, memberJar, '0912222153', password);
    const denied = await request(app.base, memberJar, '/admin');
    assert.equal(denied.status, 403);
    assert.match(denied.text, /只有創辦人可以進入管理頁/);
    assert.equal(denied.text.includes('請看第一則'), false);
    const home = await request(app.base, memberJar, '/');
    const forged = await request(app.base, memberJar, `/admin/reports/${resolved.id}/resolve`, {
      _csrf: csrfOf(home.text),
    });
    assert.equal(forged.status, 403);
    assert.equal(env.db.prepare('SELECT status, handled_at, handled_by FROM reports WHERE id = ?').get(resolved.id).status, 'open');

    const founderJar = cookieJar();
    await signIn(app.base, founderJar, '0912222198', 'founder-password');
    const admin = await request(app.base, founderJar, '/admin');
    assert.match(admin.text, /data-target-count="2"/);
    assert.match(admin.text, /同一對象共 2 則/);
    const keep = await request(app.base, founderJar, `/admin/reports/${resolved.id}/resolve`, {
      _csrf: csrfOf(admin.text),
    });
    assert.equal(keep.status, 302);
    const kept = env.db.prepare('SELECT status, handled_at, handled_by FROM reports WHERE id = ?').get(resolved.id);
    assert.equal(kept.status, 'resolved');
    assert.equal(kept.handled_by, founder.id);
    assert.ok(kept.handled_at);
    const drop = await request(app.base, founderJar, `/admin/reports/${dismissed.id}/dismiss`, {
      _csrf: csrfOf(admin.text),
    });
    assert.equal(drop.status, 302);
    const dropped = env.db.prepare('SELECT status, handled_at, handled_by FROM reports WHERE id = ?').get(dismissed.id);
    assert.equal(dropped.status, 'dismissed');
    assert.equal(dropped.handled_by, founder.id);
    assert.ok(dropped.handled_at);
    const stillOpen = env.db.prepare(`SELECT id FROM reports WHERE status = 'open' ORDER BY id`).all();
    const memberReport = env.db.prepare(
      'SELECT id FROM reports WHERE reporter_id = ? AND target_id = ?'
    ).get(member.id, first.id);
    assert.deepEqual(stillOpen.map((row) => row.id), [memberReport.id]);
    const after = await request(app.base, founderJar, '/admin');
    assert.match(after.text, /data-stat="open-reports">1</);
    assert.equal(after.text.includes('請看第二則'), false);
    assert.equal(after.text.includes(`data-report="${resolved.id}"`), false);
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(first.id).status, 'open');
    assert.deepEqual(balances(env, '0912222151'), before);
    assert.equal(env.db.prepare('SELECT blocked FROM users WHERE id = ?').get(author.id).blocked, 0);
  } finally {
    await close(app.server);
    env.close();
  }
});
