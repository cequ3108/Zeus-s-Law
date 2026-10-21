const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, migrate } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-hide-'));
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
  const app = createApp({ db, sessionSecret: 'hide-secret', cookieSecure: false });
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

function openPost(services, authorId, title) {
  return services.createPost(authorId, {
    kind: 'offer',
    category: 'food',
    description: title,
    title,
    amount: 10,
    city: '臺北市',
  });
}

function titlesOf(services, viewerId) {
  const filter = viewerId ? { viewerId } : {};
  return services.listOpenPosts(filter).map((post) => post.title);
}

function hideCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM user_hides').get().n;
}

test('封鎖與解除會更新清單，雙方廣場都看不到對方', async () => {
  const env = setup();
  const password = 'hide-password';
  const a = env.services.registerWithPassword('0912666101', '甲', password, password);
  const b = env.services.registerWithPassword('0912666102', '乙', password, password);
  env.services.registerWithPassword('0912666103', '丙', password, password);
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912666109',
    FOUNDER_PASSWORD: 'founder-password',
  });
  const postA = openPost(env.services, a.id, '甲的便當');
  openPost(env.services, b.id, '乙的便當');
  openPost(env.services, env.services.findByMobile('0912666103').id, '丙的便當');
  const app = await listen(env.db);
  const jarA = cookieJar();
  const jarB = cookieJar();
  try {
    await signIn(app.base, jarA, '0912666101', password);
    const own = await request(app.base, jarA, `/users/${a.id}`);
    assert.equal(own.text.includes('不想再遇到這個人'), false);
    const profile = await request(app.base, jarA, `/users/${b.id}`);
    assert.match(profile.text, /不想再遇到這個人/);
    assert.match(profile.text, new RegExp(`action="/users/${b.id}/hide"`));
    const postPage = await request(app.base, jarA, `/posts/${postA.id}`);
    assert.equal(postPage.text.includes('不想再遇到這個人'), false);
    const otherPost = env.db.prepare("SELECT id FROM posts WHERE title = '乙的便當'").get();
    const bPost = await request(app.base, jarA, `/posts/${otherPost.id}`);
    assert.match(bPost.text, /不想再遇到這個人/);
    assert.match(bPost.text, />接下這則</);

    const preview = await request(app.base, jarA, `/users/${b.id}/hide`, {
      _csrf: csrfOf(profile.text),
    });
    assert.equal(preview.status, 200);
    assert.match(preview.text, /確定，不想再遇到/);
    assert.match(preview.text, /對方不會收到通知/);
    assert.equal(hideCount(env.db), 0);

    const saved = await request(app.base, jarA, `/users/${b.id}/hide`, {
      _csrf: csrfOf(preview.text),
      confirm: '1',
    });
    assert.equal(saved.status, 302);
    assert.equal(saved.location, '/me');
    assert.equal(hideCount(env.db), 1);
    const mine = await request(app.base, jarA, '/me');
    assert.match(mine.text, /我封鎖的人/);
    assert.match(mine.text, /乙/);
    assert.match(mine.text, new RegExp(`action="/users/${b.id}/unhide"`));
    assert.match(mine.text, />解除</);
    assert.match(mine.text, /已列入不想再遇到/);

    const homeA = await request(app.base, jarA, '/');
    assert.equal(homeA.text.includes('乙的便當'), false);
    assert.match(homeA.text, /甲的便當/);
    assert.match(homeA.text, /丙的便當/);
    await signIn(app.base, jarB, '0912666102', password);
    const homeB = await request(app.base, jarB, '/');
    assert.equal(homeB.text.includes('甲的便當'), false);
    assert.match(homeB.text, /乙的便當/);
    const hiddenProfile = await request(app.base, jarB, `/users/${b.id}`);
    assert.equal(hiddenProfile.text.includes('不想再遇到'), false);
    const publicProfile = await request(app.base, cookieJar(), `/users/${b.id}`);
    assert.equal(publicProfile.text.includes('不想再遇到'), false);

    const founderJar = cookieJar();
    await signIn(app.base, founderJar, '0912666109', 'founder-password');
    const admin = await request(app.base, founderJar, '/admin?mobile=0912666102');
    assert.match(admin.text, /不想再遇到：1 位會員把這個人列入自己的清單/);
    assert.equal(admin.text.includes('action="/users/'), false);

    const cleared = await request(app.base, jarA, `/users/${b.id}/unhide`, {
      _csrf: csrfOf(mine.text),
    });
    assert.equal(cleared.status, 302);
    assert.equal(hideCount(env.db), 0);
    const restored = await request(app.base, jarA, '/');
    assert.match(restored.text, /乙的便當/);
    const after = await request(app.base, jarA, '/me');
    assert.match(after.text, /目前沒有/);
    assert.equal(env.db.prepare('SELECT blocked FROM users WHERE id = ?').get(b.id).blocked, 0);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('一方列入後，雙方廣場都藏起對方，其他人仍看得到', () => {
  const env = setup();
  try {
    const columns = env.db.prepare('PRAGMA table_info(users)').all();
    migrate(env.db);
    assert.deepEqual(env.db.prepare('PRAGMA table_info(users)').all(), columns);
    assert.deepEqual(
      env.db.prepare('PRAGMA table_info(user_hides)').all().map((column) => column.name),
      ['user_id', 'hidden_user_id', 'created_at'],
    );
    const a = env.services.register('0912666201', '甲');
    const b = env.services.register('0912666202', '乙');
    const c = env.services.register('0912666203', '丙');
    openPost(env.services, a.id, '甲的便當');
    openPost(env.services, b.id, '乙的便當');
    openPost(env.services, c.id, '丙的便當');
    env.services.hideUser(a.id, b.id);
    env.services.hideUser(a.id, b.id);
    assert.equal(hideCount(env.db), 1);
    assert.deepEqual(titlesOf(env.services, a.id), ['丙的便當', '甲的便當']);
    assert.deepEqual(titlesOf(env.services, b.id), ['丙的便當', '乙的便當']);
    assert.deepEqual(titlesOf(env.services, c.id), ['丙的便當', '乙的便當', '甲的便當']);
    assert.deepEqual(titlesOf(env.services), ['丙的便當', '乙的便當', '甲的便當']);
    env.services.unhideUser(a.id, b.id);
    assert.deepEqual(titlesOf(env.services, a.id), ['丙的便當', '乙的便當', '甲的便當']);
    assert.deepEqual(titlesOf(env.services, b.id), ['丙的便當', '乙的便當', '甲的便當']);
  } finally {
    env.close();
  }
});

test('伺服器拒絕不想再遇到的雙方接下', async () => {
  const env = setup();
  const password = 'hide-password';
  const a = env.services.registerWithPassword('0912666301', '甲', password, password);
  const b = env.services.registerWithPassword('0912666302', '乙', password, password);
  const byA = openPost(env.services, a.id, '甲的便當');
  const byB = openPost(env.services, b.id, '乙的便當');
  env.services.hideUser(a.id, b.id);
  const app = await listen(env.db);
  const jarB = cookieJar();
  try {
    assert.throws(() => env.services.acceptPost(byB.id, a.id), /你們已設定不想再遇到，不能接下這則。/);
    assert.throws(() => env.services.acceptPost(byA.id, b.id), /你們已設定不想再遇到，不能接下這則。/);
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(byA.id).status, 'open');
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(byB.id).status, 'open');

    await signIn(app.base, jarB, '0912666302', password);
    const page = await request(app.base, jarB, `/posts/${byA.id}`);
    assert.equal(page.text.includes('>接下這則<'), false);
    assert.match(page.text, /你們已設定不想再遇到，不能接下這則。/);
    const rejected = await request(app.base, jarB, `/posts/${byA.id}/accept`, {
      _csrf: csrfOf(page.text),
    });
    assert.equal(rejected.status, 302);
    const again = await request(app.base, jarB, rejected.location);
    assert.match(again.text, /你們已設定不想再遇到，不能接下這則。/);
    assert.equal(env.db.prepare('SELECT status, accepter_id FROM posts WHERE id = ?').get(byA.id).accepter_id, null);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('進行中與已完成的互助不會因為不想再遇到而改動', () => {
  const env = setup();
  try {
    const a = env.services.register('0912666401', '甲');
    const b = env.services.register('0912666402', '乙');
    const post = openPost(env.services, a.id, '進行中的便當');
    env.services.acceptPost(post.id, b.id);
    const meritBefore = env.db.prepare('SELECT merit, quota, blocked FROM users WHERE id = ?').get(a.id);
    const ledgerBefore = env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
    env.services.hideUser(a.id, b.id);
    const matched = env.db.prepare('SELECT status, accepter_id, settled_amount, host_value, seeker_value FROM posts WHERE id = ?').get(post.id);
    assert.equal(matched.status, 'matched');
    assert.equal(matched.accepter_id, b.id);
    assert.equal(matched.settled_amount, null);
    assert.equal(matched.host_value, null);
    assert.equal(matched.seeker_value, null);
    assert.deepEqual(env.db.prepare('SELECT merit, quota, blocked FROM users WHERE id = ?').get(a.id), meritBefore);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, ledgerBefore);

    assert.equal(env.services.submitValue(post.id, a.id, 8).status, 'waiting');
    assert.equal(env.services.submitValue(post.id, b.id, 12).status, 'settled');
    env.services.rate(post.id, a.id, 4, '只留在資料庫');
    const settled = env.db.prepare('SELECT status, settled_amount FROM posts WHERE id = ?').get(post.id);
    assert.equal(settled.status, 'settled');
    assert.equal(settled.settled_amount, 8);
    const rating = env.db.prepare('SELECT stars, comment, ratee_id FROM ratings WHERE post_id = ?').get(post.id);
    env.services.hideUser(b.id, a.id);
    assert.deepEqual(env.db.prepare('SELECT stars, comment, ratee_id FROM ratings WHERE post_id = ?').get(post.id), rating);
    assert.equal(env.db.prepare('SELECT settled_amount FROM posts WHERE id = ?').get(post.id).settled_amount, 8);
    const profile = env.services.getProfile(b.id);
    assert.equal(profile.ratings.length, 1);
    assert.equal(profile.ratings[0].stars, 4);
    assert.equal(profile.user.blocked, 0);
    const page = env.services.postPage(post.id, a.id);
    assert.equal(page.canSubmitValue, false);
    assert.equal(page.settledAmount, 8);
    assert.equal(page.myStars, 4);
  } finally {
    env.close();
  }
});

test('創辦人與福利機構不能列入不想再遇到，管理頁只顯示人數', async () => {
  const env = setup();
  const password = 'hide-password';
  const member = env.services.registerWithPassword('0912666501', '一般會員', password, password);
  env.services.ensureFounderFromEnv({
    FOUNDER_PHONE: '0912666509',
    FOUNDER_PASSWORD: 'founder-password',
  });
  const founder = env.services.findByMobile('0912666509');
  const org = env.services.createOrg(founder.id, '0912666508', '社區廚房').user;
  const orgPost = env.services.createPost(org.id, {
    kind: 'need',
    category: 'food',
    description: '機構需要便當',
    title: '機構的便當',
    amount: 30,
    city: '臺北市',
  });
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    assert.throws(() => env.services.hideUser(member.id, founder.id), /創辦人與福利機構不能列入不想再遇到/);
    assert.throws(() => env.services.hideUser(member.id, org.id), /創辦人與福利機構不能列入不想再遇到/);
    assert.throws(() => env.services.hideUser(founder.id, member.id), /只有一般使用者可以設定不想再遇到/);
    assert.throws(() => env.services.hideUser(org.id, member.id), /只有一般使用者可以設定不想再遇到/);
    assert.equal(hideCount(env.db), 0);
    env.services.acceptPost(orgPost.id, member.id);
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(orgPost.id).status, 'matched');

    await signIn(app.base, jar, '0912666501', password);
    const founderPage = await request(app.base, jar, `/users/${founder.id}`);
    const orgPage = await request(app.base, jar, `/users/${org.id}`);
    const orgPostPage = await request(app.base, jar, `/posts/${orgPost.id}`);
    assert.equal(founderPage.text.includes('不想再遇到這個人'), false);
    assert.equal(orgPage.text.includes('不想再遇到這個人'), false);
    assert.equal(orgPostPage.text.includes('不想再遇到這個人'), false);
    const denied = await request(app.base, jar, `/users/${founder.id}/hide`, {
      _csrf: csrfOf(founderPage.text),
      confirm: '1',
    });
    assert.equal(denied.status, 302);
    const deniedPage = await request(app.base, jar, denied.location);
    assert.match(deniedPage.text, /創辦人與福利機構不能列入不想再遇到/);
    assert.equal(hideCount(env.db), 0);

    const founderJar = cookieJar();
    await signIn(app.base, founderJar, '0912666509', 'founder-password');
    const admin = await request(app.base, founderJar, '/admin?mobile=0912666509');
    assert.match(admin.text, /不想再遇到：0 位會員把這個人列入自己的清單/);
    assert.equal(founder.blocked, 0);
    env.services.blockUser(founder.id, member.mobile, '收取現金');
    assert.equal(env.services.findByMobile(member.mobile).blocked, 1);
    assert.equal(hideCount(env.db), 0);
  } finally {
    await close(app.server);
    env.close();
  }
});

test('不想再遇到的表單沒有正確的驗證就不會寫入', async () => {
  const env = setup();
  const password = 'hide-password';
  const a = env.services.registerWithPassword('0912666601', '甲', password, password);
  const b = env.services.registerWithPassword('0912666602', '乙', password, password);
  env.services.hideUser(a.id, b.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912666601', password);
    const page = await request(app.base, jar, '/me');
    const forged = await request(app.base, jar, `/users/${b.id}/unhide`, { _csrf: 'not-the-token' });
    assert.equal(forged.status, 303);
    assert.equal(hideCount(env.db), 1);
    const follow = await request(app.base, jar, forged.location);
    assert.match(follow.text, /表單已更新，請再送出一次/);

    const fresh = env.services.registerWithPassword('0912666603', '丙', password, password);
    const profile = await request(app.base, jar, `/users/${fresh.id}`);
    const rejected = await request(app.base, jar, `/users/${fresh.id}/hide`, {
      _csrf: 'still-wrong',
      confirm: '1',
    });
    assert.equal(rejected.status, 303);
    assert.equal(hideCount(env.db), 1);
    assert.equal(env.services.pairHidden(a.id, fresh.id), false);
    assert.match(profile.text, /不想再遇到這個人/);
  } finally {
    await close(app.server);
    env.close();
  }
});
