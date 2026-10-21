const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

const START = '2026-10-19T04:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-thanks-'));
  const db = openDatabase(path.join(dir, 't.db'));
  let current = new Date(START);
  const services = createServices(db, { now: () => new Date(current) });
  return {
    dir,
    db,
    services,
    setNow(value) { current = new Date(value); },
    now() { return new Date(current); },
    balances(id) {
      return db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(id);
    },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function settle(env, seeker, host, category = 'food') {
  const item = env.services.createPost(seeker.id, {
    kind: 'need',
    category,
    description: '需要一份便當',
    amount: 10,
    city: '臺北市',
  });
  env.services.acceptPost(item.id, host.id);
  env.services.submitValue(item.id, seeker.id, 10);
  const done = env.services.submitValue(item.id, host.id, 10);
  assert.equal(done.status, 'settled');
  assert.equal(done.amount, 10);
  return item.id;
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

async function listen(env) {
  const app = createApp({
    db: env.db,
    now: () => env.now(),
    sessionSecret: 'thanks-secret',
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
  });
  assert.equal(logged.status, 302);
}

test('只有完成互助的雙方能各留一句，100 字與七日、24 小時都算', () => {
  const env = setup();
  try {
    const seeker = env.services.register('0912777001', '求助');
    const host = env.services.register('0912777002', '幫手');
    const stranger = env.services.register('0912777003', '路人');
    const open = env.services.createPost(seeker.id, {
      kind: 'need', category: 'food', description: '還没收下', amount: 10, city: '臺北市',
    });
    assert.throws(() => env.services.saveThanks(open.id, seeker.id, '太早了'), /結算完成後/);

    const postId = settle(env, seeker, host, 'transport');
    assert.throws(() => env.services.saveThanks(postId, stranger.id, '我不在場'), /只有這次互助的雙方/);
    assert.throws(() => env.services.saveThanks(postId, seeker.id, '謝'.repeat(101)), /100 個字/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks').get().n, 0);

    const saved = env.services.saveThanks(postId, seeker.id, '謝'.repeat(100));
    env.services.saveThanks(postId, host.id, '也謝謝你');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks WHERE post_id = ?').get(postId).n, 2);
    env.services.saveThanks(postId, seeker.id, '改成更短的感謝');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks WHERE post_id = ?').get(postId).n, 2);
    assert.equal(
      env.db.prepare('SELECT body FROM thanks WHERE id = ?').get(saved.id).body,
      '改成更短的感謝',
    );

    env.setNow(new Date(new Date(START).getTime() + DAY).toISOString());
    env.services.saveThanks(postId, seeker.id, '剛好 24 小時還能改');
    env.setNow(new Date(new Date(START).getTime() + DAY + 1).toISOString());
    assert.throws(() => env.services.saveThanks(postId, seeker.id, '太晚了'), /24 小時/);
    assert.throws(() => env.services.removeOwnThanks(postId, seeker.id), /24 小時/);
    assert.equal(
      env.db.prepare('SELECT body FROM thanks WHERE id = ?').get(saved.id).body,
      '剛好 24 小時還能改',
    );

    const later = env.services.register('0912777004', '另一位');
    const latePost = settle(env, later, host);
    const edge = new Date(env.now().getTime() + WEEK).toISOString();
    env.setNow(edge);
    env.services.saveThanks(latePost, later.id, '剛好七天還可以');
    env.setNow(new Date(new Date(edge).getTime() + 1).toISOString());
    assert.throws(() => env.services.saveThanks(latePost, host.id, '再晚一秒'), /7 天/);
  } finally {
    env.close();
  }
});

test('感謝留言擋下現金、轉帳、匯款和 LINE Pay', () => {
  const env = setup();
  try {
    const seeker = env.services.register('0912777101', '求助');
    const host = env.services.register('0912777102', '幫手');
    const postId = settle(env, seeker, host);
    for (const body of ['謝謝，下次給現金', '請轉帳給我', '我匯款了', '用 LINE Pay 付']) {
      assert.throws(() => env.services.saveThanks(postId, seeker.id, body), /站內規則禁止現金交易/);
    }
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks').get().n, 0);
    env.services.saveThanks(postId, seeker.id, '謝謝你準時來');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks').get().n, 1);
  } finally {
    env.close();
  }
});

test('隱藏的感謝不公開，創辦人可以刪掉', async () => {
  const env = setup();
  const password = 'thanks-password';
  try {
    env.services.ensureFounderFromEnv({ FOUNDER_PHONE: '0912777201', FOUNDER_PASSWORD: password });
    const founder = env.services.findByMobile('0912777201');
    const seeker = env.services.registerWithPassword('0912777202', '求助', password, password);
    const host = env.services.register('0912777203', '幫手');
    const postId = settle(env, seeker, host, 'food');
    const note = env.services.saveThanks(postId, seeker.id, '今天的便當很暖');
    assert.throws(() => env.services.hideThanks(seeker.id, note.id), /只有收到的人/);
    env.services.hideThanks(host.id, note.id);
    assert.equal(env.db.prepare('SELECT hidden_at FROM thanks WHERE id = ?').get(note.id).hidden_at == null, false);
    const publicProfile = env.services.getProfile(host.id, seeker.id);
    assert.equal(publicProfile.notes.length, 0);
    assert.equal(JSON.stringify(publicProfile).includes('今天的便當很暖'), false);
    const own = env.services.getProfile(host.id, host.id);
    assert.equal(own.notes.length, 1);
    assert.equal(own.notes[0].hidden, true);

    assert.throws(() => env.services.deleteThanks(seeker.id, note.id), /只有創辦人/);
    env.services.deleteThanks(founder.id, note.id);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks').get().n, 0);

    const again = env.services.saveThanks(postId, seeker.id, '再留一次公開的');
    const app = await listen(env);
    const member = cookieJar();
    const founderJar = cookieJar();
    try {
      await signIn(app.base, member, '0912777202', password);
      const forged = await request(app.base, member, `/posts/${postId}/thanks`, {
        _csrf: 'not-the-token',
        body: '不該寫進去',
      });
      assert.equal(forged.status, 303);
      assert.equal(env.db.prepare('SELECT body FROM thanks WHERE id = ?').get(again.id).body, '再留一次公開的');

      const denied = await request(app.base, member, `/admin/thanks/${again.id}/delete`, {
        _csrf: csrfOf((await request(app.base, member, '/')).text),
      });
      assert.equal(denied.status, 403);
      await signIn(app.base, founderJar, '0912777201', password);
      const admin = await request(app.base, founderJar, '/admin');
      assert.match(admin.text, /再留一次公開的/);
      const removed = await request(app.base, founderJar, `/admin/thanks/${again.id}/delete`, {
        _csrf: csrfOf(admin.text),
      });
      assert.equal(removed.status, 302);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks').get().n, 0);
    } finally {
      await close(app.server);
    }
  } finally {
    env.close();
  }
});

test('沒有感謝不影響結算，不合規的感謝也不擋星等', async () => {
  const env = setup();
  const password = 'thanks-password';
  try {
    const seeker = env.services.registerWithPassword('0912777301', '求助', password, password);
    const host = env.services.register('0912777302', '幫手');
    const beforeSeeker = env.balances(seeker.id);
    const beforeHost = env.balances(host.id);
    const postId = settle(env, seeker, host);
    assert.equal(env.balances(seeker.id).merit, beforeSeeker.merit - 10);
    assert.equal(env.balances(host.id).merit, beforeHost.merit + 10);
    assert.equal(env.balances(seeker.id).quota, beforeSeeker.quota + 10);
    assert.equal(env.balances(host.id).quota, beforeHost.quota + 10);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks').get().n, 0);

    env.services.rate(postId, host.id, 5, '備註不公開');
    assert.equal(env.db.prepare('SELECT stars FROM ratings WHERE rater_id = ?').get(host.id).stars, 5);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks').get().n, 0);
    assert.equal(env.balances(seeker.id).merit, beforeSeeker.merit - 10);

    const app = await listen(env);
    const jar = cookieJar();
    try {
      await signIn(app.base, jar, '0912777301', password);
      const page = await request(app.base, jar, `/posts/${postId}`);
      const posted = await request(app.base, jar, `/posts/${postId}/rating`, {
        _csrf: csrfOf(page.text),
        stars: '4',
        thanks: '請轉帳',
      });
      assert.equal(posted.status, 302);
      const after = await request(app.base, jar, `/posts/${postId}`);
      assert.match(after.text, /已送出星等/);
      assert.match(after.text, /站內規則禁止現金交易/);
      assert.equal(env.db.prepare('SELECT stars FROM ratings WHERE rater_id = ?').get(seeker.id).stars, 4);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM thanks').get().n, 0);
      assert.equal(env.balances(seeker.id).merit, beforeSeeker.merit - 10);
      assert.equal(env.balances(host.id).merit, beforeHost.merit + 10);
    } finally {
      await close(app.server);
    }
  } finally {
    env.close();
  }
});

test('個人頁最新的感謝在前，預設五則，可以展開', () => {
  const env = setup();
  try {
    const host = env.services.register('0912777401', '幫手');
    const bodies = ['感謝一', '感謝二', '感謝三', '感謝四', '感謝五', '感謝六'];
    bodies.forEach((body, index) => {
      const seeker = env.services.register(`09127774${String(index + 10)}`, `人${index}`);
      const postId = settle(env, seeker, host, index === 5 ? 'transport' : 'food');
      env.setNow(new Date(new Date(START).getTime() + (index + 1) * 1000).toISOString());
      env.services.saveThanks(postId, seeker.id, body);
    });
    const preview = env.services.getProfile(host.id);
    assert.deepEqual(preview.notes.map((note) => note.body), ['感謝六', '感謝五', '感謝四', '感謝三', '感謝二']);
    assert.equal(preview.noteTotal, 6);
    assert.equal(preview.notes[0].authorName, '人5');
    assert.equal(preview.notes[0].category, 'transport');
    assert.equal(preview.thanksAll, false);
    const all = env.services.getProfile(host.id, null, { all: true });
    assert.equal(all.notes.at(-1).body, '感謝一');
    assert.equal(all.notes.at(-1).category, 'food');
  } finally {
    env.close();
  }
});
