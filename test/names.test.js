const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-name-'));
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

function balances(db, userId) {
  return db.prepare('SELECT merit, quota, role, display_name FROM users WHERE id = ?').get(userId);
}

function messageOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  assert.fail('應該要拒絕');
}

test('註冊、建立機構和改名都會擋下重複名稱，大小寫和空白算同一個', () => {
  const env = setup();
  try {
    const schema = env.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get().sql;
    assert.equal(/display_name TEXT NOT NULL UNIQUE/.test(schema), false);

    const first = env.services.register('0912888801', '  Apple  ');
    assert.equal(first.display_name, 'Apple');
    assert.equal(messageOf(() => env.services.register('0912888802', 'apple')), '這個名稱已經有人使用，請換一個');
    assert.equal(
      messageOf(() => env.services.registerWithPassword('0912888803', ' APPLE ', 'password-ok', 'password-ok')),
      '這個名稱已經有人使用，請換一個',
    );
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE lower(trim(display_name)) = 'apple'`).get().n, 1);

    const flower = env.services.registerWithPassword('0912888804', '  阿花  ', 'password-ok', 'password-ok');
    assert.equal(flower.display_name, '阿花');
    assert.equal(messageOf(() => env.services.register('0912888805', '阿花')), '這個名稱已經有人使用，請換一個');
    assert.equal(messageOf(() => env.services.register('0912888806', '阿'.repeat(21))), '名稱請填 1 到 20 個字。');
    const twenty = env.services.register('0912888807', '人'.repeat(20));
    assert.equal([...twenty.display_name].length, 20);

    const founder = env.services.ensureFounderAccount('0912888808', 'password-ok').user;
    assert.equal(
      messageOf(() => env.services.createOrg(founder.id, '0912888809', ' apple ')),
      '這個名稱已經有人使用，請換一個',
    );
    assert.equal(env.services.findByMobile('0912888809'), null);

    const member = env.services.register('0912888810', '老志工');
    const before = balances(env.db, member.id);
    assert.equal(messageOf(() => env.services.createOrg(founder.id, member.mobile, '阿花')), '這個名稱已經有人使用，請換一個');
    assert.deepEqual(balances(env.db, member.id), before);

    assert.equal(messageOf(() => env.services.applyOrg(member.id, 'APPLE')), '這個名稱已經有人使用，請換一個');
    env.db.prepare(`
      INSERT INTO org_applications (user_id, org_name, status, created_at)
      VALUES (?, '阿花', 'pending', '2026-10-21T00:00:00.000Z')
    `).run(member.id);
    assert.equal(messageOf(() => env.services.approveApplication(founder.id, 1)), '這個名稱已經有人使用，請換一個');
    assert.deepEqual(balances(env.db, member.id), before);

    assert.equal(messageOf(() => env.services.renameUser(founder.id, first.mobile, '  阿花 ')), '這個名稱已經有人使用，請換一個');
    assert.equal(env.services.findByMobile(first.mobile).display_name, 'Apple');
    const renamed = env.services.renameUser(founder.id, first.mobile, '  apple pie  ');
    assert.equal(renamed.display_name, 'apple pie');
    assert.equal(renamed.id, first.id);
    assert.deepEqual(balances(env.db, first.id), { merit: 100, quota: 100, role: 'user', display_name: 'apple pie' });
  } finally {
    env.close();
  }
});

test('只有創辦人能改名，改完星等功德和貼文仍屬同一個帳號', () => {
  const env = setup();
  try {
    const founder = env.services.ensureFounderAccount('0912888821', 'password-ok').user;
    const author = env.services.registerWithPassword('0912888822', '作者', 'password-ok', 'password-ok');
    const org = env.services.createOrg(founder.id, '0912888823', '社區食物站').user;
    const other = env.services.register('0912888824', '路人');
    const post = env.services.createPost(author.id, {
      kind: 'offer',
      category: 'food',
      title: '熱湯',
      description: '可以分一碗。',
      amount: 10,
      city: '臺北市',
      expires_hours: 48,
    });
    env.services.acceptPost(post.id, other.id);
    env.services.submitValue(post.id, author.id, 10);
    env.services.submitValue(post.id, other.id, 10);
    env.services.rate(post.id, other.id, 5, '很好');
    const merit = balances(env.db, author.id);
    const rating = env.db.prepare('SELECT ratee_id, stars FROM ratings WHERE post_id = ?').get(post.id);

    assert.equal(messageOf(() => env.services.renameUser(author.id, author.mobile, '新作者')), '只有創辦人可以做這件事。');
    assert.equal(messageOf(() => env.services.renameUser(org.id, author.mobile, '新作者')), '只有創辦人可以做這件事。');
    assert.equal(env.services.findByMobile(author.mobile).display_name, '作者');

    const self = env.services.renameUser(founder.id, founder.mobile, '宙斯');
    assert.equal(self.display_name, '宙斯');
    assert.equal(self.merit, founder.merit);
    assert.equal(self.role, 'founder');

    const updated = env.services.renameUser(founder.id, author.mobile, '新作者');
    assert.equal(updated.id, author.id);
    assert.equal(updated.display_name, '新作者');
    assert.deepEqual(balances(env.db, author.id), { ...merit, display_name: '新作者' });
    assert.equal(env.db.prepare('SELECT author_id FROM posts WHERE id = ?').get(post.id).author_id, author.id);
    assert.deepEqual(env.db.prepare('SELECT ratee_id, stars FROM ratings WHERE post_id = ?').get(post.id), rating);
    assert.equal(env.services.getProfile(author.id).user.display_name, '新作者');
    assert.equal(env.services.postPage(post.id, other.id).author.name, '新作者');

    assert.equal(messageOf(() => env.services.renameUser(founder.id, author.mobile, '名'.repeat(21))), '名稱請填 1 到 20 個字。');
    const longOrg = env.services.renameUser(founder.id, org.mobile, '機'.repeat(30));
    assert.equal([...longOrg.display_name].length, 30);
    assert.equal(longOrg.merit, 1_000_000);
    assert.equal(messageOf(() => env.services.renameUser(founder.id, org.mobile, '機'.repeat(31))), '名稱請填 1 到 30 個字。');
    assert.equal(env.services.findByMobile(org.mobile).display_name, '機'.repeat(30));
  } finally {
    env.close();
  }
});

test('舊的重名帳號仍可登入使用，不會被強制改名', () => {
  const env = setup();
  try {
    const founder = env.services.ensureFounderAccount('0912888831', 'password-ok').user;
    const left = env.services.registerWithPassword('0912888832', '甲', 'password-ok', 'password-ok');
    const right = env.services.registerWithPassword('0912888833', '乙', 'password-ok', 'password-ok');
    env.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Old Name', left.id);
    env.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('old name', right.id);
    assert.equal(env.services.loginWithPassword(left.mobile, 'password-ok').id, left.id);
    assert.equal(env.services.loginWithPassword(right.mobile, 'password-ok').id, right.id);
    const post = env.services.createPost(left.id, {
      kind: 'offer',
      category: 'food',
      title: '舊名便當',
      description: '還是可以發。',
      amount: 10,
      city: '臺北市',
      expires_hours: 48,
    });
    assert.equal(env.db.prepare('SELECT author_id FROM posts WHERE id = ?').get(post.id).author_id, left.id);
    env.services.acceptPost(post.id, right.id);
    assert.equal(env.services.findByMobile(left.mobile).display_name, 'Old Name');
    assert.equal(env.services.findByMobile(right.mobile).display_name, 'old name');

    assert.equal(messageOf(() => env.services.register('0912888834', ' old name ')), '這個名稱已經有人使用，請換一個');
    assert.equal(messageOf(() => env.services.renameUser(founder.id, founder.mobile, 'OLD NAME')), '這個名稱已經有人使用，請換一個');
    const moved = env.services.renameUser(founder.id, left.mobile, '改過的人');
    assert.equal(moved.id, left.id);
    assert.equal(env.services.findByMobile(right.mobile).display_name, 'old name');
    assert.equal(env.services.loginWithPassword(right.mobile, 'password-ok').display_name, 'old name');
    assert.equal(env.services.loginWithPassword(left.mobile, 'password-ok').display_name, '改過的人');
    assert.equal(env.db.prepare('SELECT author_id FROM posts WHERE id = ?').get(post.id).author_id, left.id);
    assert.deepEqual(balances(env.db, left.id), { merit: 100, quota: 100, role: 'user', display_name: '改過的人' });
    assert.deepEqual(balances(env.db, right.id), { merit: 100, quota: 100, role: 'user', display_name: 'old name' });
  } finally {
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

test('帳號頁沒有改名入口，後台改名要驗證創辦人', async () => {
  const env = setup();
  const founder = env.services.ensureFounderAccount('0912888841', 'password-ok').user;
  const member = env.services.registerWithPassword('0912888842', '會員', 'password-ok', 'password-ok');
  const org = env.services.createOrg(founder.id, '0912888843', '福利站').user;
  env.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    env.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(member.id).password_hash,
    org.id,
  );
  const app = createApp({ db: env.db, sessionSecret: 'name-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const memberJar = cookieJar();
    await signIn(base, memberJar, member.mobile);
    const account = await request(base, memberJar, '/account');
    assert.equal(account.text.includes('改名稱'), false);
    assert.equal(account.text.includes('/admin/name'), false);
    const posted = await request(base, memberJar, '/account', {
      _csrf: csrfOf(account.text),
      display_name: '自己改的',
      city: '',
      availability: '',
    });
    assert.equal(posted.status, 302);
    assert.equal(env.services.findByMobile(member.mobile).display_name, '會員');
    const denied = await request(base, memberJar, '/admin/name', {
      _csrf: csrfOf(account.text),
      mobile: member.mobile,
      display_name: '自己改的',
    });
    assert.equal(denied.status, 403);
    assert.equal(env.services.findByMobile(member.mobile).display_name, '會員');

    const orgJar = cookieJar();
    await signIn(base, orgJar, org.mobile);
    const orgAccount = await request(base, orgJar, '/account');
    assert.equal(orgAccount.text.includes('改名稱'), false);
    const orgDenied = await request(base, orgJar, '/admin/name', {
      _csrf: csrfOf(orgAccount.text),
      mobile: org.mobile,
      display_name: '機構自己改',
    });
    assert.equal(orgDenied.status, 403);
    assert.equal(env.services.findByMobile(org.mobile).display_name, '福利站');

    const founderJar = cookieJar();
    await signIn(base, founderJar, founder.mobile);
    const admin = await request(base, founderJar, '/admin');
    assert.match(admin.text, /改名稱/);
    assert.match(admin.text, /action="\/admin\/name"/);
    const stale = await request(base, founderJar, '/admin/name', {
      mobile: member.mobile,
      display_name: '沒有驗證',
    });
    assert.equal(stale.status, 303);
    assert.equal(env.services.findByMobile(member.mobile).display_name, '會員');
    const renamed = await request(base, founderJar, '/admin/name', {
      _csrf: csrfOf(admin.text),
      mobile: member.mobile,
      display_name: '  新會員  ',
    });
    assert.equal(renamed.status, 302);
    const shown = await request(base, founderJar, '/admin');
    assert.match(shown.text, /已把名稱改成「新會員」。/);
    assert.equal(env.services.findByMobile(member.mobile).display_name, '新會員');
    assert.deepEqual(balances(env.db, member.id), { merit: 100, quota: 100, role: 'user', display_name: '新會員' });
    const duplicate = await request(base, founderJar, '/admin/name', {
      _csrf: csrfOf(shown.text),
      mobile: org.mobile,
      display_name: '新會員',
    });
    assert.equal(duplicate.status, 302);
    const duplicatePage = await request(base, founderJar, '/admin');
    assert.match(duplicatePage.text, /這個名稱已經有人使用，請換一個/);
    assert.equal(env.services.findByMobile(org.mobile).display_name, '福利站');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});
