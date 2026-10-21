const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-qa-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, options);
  return {
    db,
    services,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const fields = {
  kind: 'offer',
  category: 'food',
  title: '熱湯',
  description: '今晚可以分一碗熱湯。',
  amount: 10,
  city: '臺北市',
  expires_hours: 72,
};

function balances(db, userId) {
  return db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(userId);
}

function questionRows(db, postId) {
  return db.prepare('SELECT question, answer, hidden_at FROM post_questions WHERE post_id = ? ORDER BY id').all(postId);
}

function messageOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  assert.fail('應該要拒絕');
}

test('提問最多 150 字，24 小時 3 次，並擋現金字眼', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-qa-old-'));
  const file = path.join(dir, 'old.db');
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      mobile TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      merit INTEGER NOT NULL,
      quota INTEGER NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL,
      accepter_id INTEGER,
      host_id INTEGER,
      seeker_id INTEGER,
      kind TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      city TEXT
    );
    INSERT INTO users (mobile, display_name, role, merit, quota, blocked, created_at)
    VALUES ('0912888401', '舊帳號', 'user', 70, 130, 0, '2026-10-01T00:00:00.000Z');
    INSERT INTO posts (author_id, kind, category, description, amount, status, created_at, city)
    VALUES (1, 'offer', 'food', '舊便當', 10, 'open', '2026-10-01T00:00:00.000Z', '臺北市');
  `);
  legacy.close();
  const migrated = openDatabase(file);
  try {
    const columns = migrated.prepare('PRAGMA table_info(post_questions)').all();
    assert.deepEqual(columns.map((column) => column.name), [
      'id', 'post_id', 'asker_id', 'question', 'answer', 'answered_at', 'hidden_at', 'created_at',
    ]);
    for (const name of ['answer', 'answered_at', 'hidden_at']) {
      assert.equal(columns.find((column) => column.name === name).notnull, 0);
    }
    assert.ok(migrated.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_post_questions_post'`
    ).get());
    const user = migrated.prepare('SELECT merit, quota FROM users WHERE id = 1').get();
    assert.deepEqual(user, { merit: 70, quota: 130 });
    assert.equal(migrated.prepare('SELECT description FROM posts WHERE id = 1').get().description, '舊便當');
    const old = createServices(migrated);
    assert.equal(old.listOpenPosts({})[0].question_count, 0);
    const asker = old.register('0912888402', '舊提問');
    old.askQuestion(1, asker.id, '舊貼文也能問嗎');
    assert.equal(old.listOpenPosts({})[0].question_count, 1);
    assert.deepEqual(migrated.prepare('SELECT merit, quota FROM users WHERE id = 1').get(), user);
  } finally {
    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  let now = new Date('2026-10-21T04:00:00.000Z');
  const env = setup({ now: () => now });
  try {
    const author = env.services.register('0912888411', '作者');
    const asker = env.services.register('0912888412', '提問者');
    const other = env.services.register('0912888413', '另一人');
    const post = env.services.createPost(author.id, fields);
    const second = env.services.createPost(author.id, { ...fields, title: '另一則' });
    const before = env.db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    const ledger = env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;

    assert.equal(messageOf(() => env.services.askQuestion(post.id, asker.id, '   ')), '提問必須填寫。');
    assert.equal(messageOf(() => env.services.askQuestion(post.id, asker.id, '問'.repeat(151))), '提問請不要超過 150 個字。');
    const saved = env.services.askQuestion(post.id, asker.id, `  ${'問'.repeat(150)}  `);
    assert.equal(env.db.prepare('SELECT question FROM post_questions WHERE id = ?').get(saved.id).question, '問'.repeat(150));
    assert.equal(questionRows(env.db, post.id).length, 1);

    for (const phrase of ['請付現金', '請用轉帳', '匯款帳號', '街口支付', '用 LINE Pay', 'line pay']) {
      assert.equal(
        messageOf(() => env.services.askQuestion(post.id, asker.id, phrase)),
        '宙斯法則禁止現金交易',
      );
    }
    assert.equal(questionRows(env.db, post.id).length, 1);

    env.services.askQuestion(post.id, asker.id, '第二個問題');
    env.services.askQuestion(post.id, asker.id, '第三個問題');
    env.services.hideQuestion(post.id, saved.id, author.id);
    assert.equal(messageOf(() => env.services.askQuestion(post.id, asker.id, '第四個問題')), '同一則貼文 24 小時內最多問 3 次。');
    const elsewhere = env.services.askQuestion(second.id, asker.id, '換一則還可以問');
    assert.equal(elsewhere.id > 0, true);
    const byOther = env.services.askQuestion(post.id, other.id, '別人還可以問');
    assert.equal(byOther.id > 0, true);

    now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const again = env.services.askQuestion(post.id, asker.id, '剛好過了 24 小時');
    assert.equal(env.db.prepare('SELECT question FROM post_questions WHERE id = ?').get(again.id).question, '剛好過了 24 小時');

    assert.equal(messageOf(() => env.services.askQuestion(post.id, author.id, '自己問自己')), '不能問自己的貼文。');
    assert.deepEqual(env.db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id), before);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, ledger);
    assert.deepEqual(balances(env.db, author.id), { merit: 100, quota: 100 });
    assert.deepEqual(balances(env.db, asker.id), { merit: 100, quota: 100 });
  } finally {
    env.close();
  }
});

test('只有發文者能回覆或隱藏，創辦人能刪除，被封鎖的人看不到', () => {
  const env = setup();
  try {
    const author = env.services.register('0912888421', '作者');
    const asker = env.services.register('0912888422', '提問者');
    const stranger = env.services.register('0912888423', '路人');
    const founder = env.services.ensureFounderAccount('0912888424', 'password-ok').user;
    const post = env.services.createPost(author.id, fields);
    const asked = env.services.askQuestion(post.id, asker.id, '今晚還有熱湯嗎');

    assert.equal(messageOf(() => env.services.answerQuestion(post.id, asked.id, stranger.id, '沒有')), '只有發文者可以回覆。');
    assert.equal(messageOf(() => env.services.hideQuestion(post.id, asked.id, stranger.id)), '只有發文者可以隱藏提問。');
    assert.equal(messageOf(() => env.services.deleteQuestion(post.id, asked.id, author.id)), '只有創辦人可以做這件事。');
    assert.equal(env.db.prepare('SELECT answer, hidden_at FROM post_questions WHERE id = ?').get(asked.id).answer, null);

    assert.equal(messageOf(() => env.services.answerQuestion(post.id, asked.id, author.id, '回'.repeat(151))), '回覆請不要超過 150 個字。');
    assert.equal(messageOf(() => env.services.answerQuestion(post.id, asked.id, author.id, '  ')), '回覆必須填寫。');
    assert.equal(messageOf(() => env.services.answerQuestion(post.id, asked.id, author.id, '請付現金')), '宙斯法則禁止現金交易');
    assert.equal(env.db.prepare('SELECT answer FROM post_questions WHERE id = ?').get(asked.id).answer, null);

    env.services.answerQuestion(post.id, asked.id, author.id, '還有，七點前可以拿');
    assert.equal(messageOf(() => env.services.answerQuestion(post.id, asked.id, author.id, '再補一次')), '已經回覆過了。');
    const page = env.services.postPage(post.id, stranger.id);
    assert.equal(page.questions.items[0].answer, '還有，七點前可以拿');
    assert.equal(page.questions.publicCount, 1);
    assert.equal(page.questions.canAsk, true);
    assert.equal(env.services.postPage(post.id, author.id).questions.canAsk, false);
    assert.equal(env.services.listOpenPosts({})[0].question_count, 1);
    assert.equal(env.services.dashboard(author.id).posts[0].unanswered, 0);

    const pending = env.services.askQuestion(post.id, asker.id, '可以改成素食嗎');
    assert.equal(env.services.dashboard(author.id).posts[0].unanswered, 1);
    assert.equal(env.services.dashboard(asker.id).posts.length, 0);
    env.services.hideQuestion(post.id, pending.id, author.id);
    assert.equal(env.services.dashboard(author.id).posts[0].unanswered, 0);
    assert.equal(env.services.listOpenPosts({})[0].question_count, 1);
    assert.equal(env.services.postPage(post.id, stranger.id).questions.items.some((item) => item.question === '可以改成素食嗎'), false);
    const hiddenForAsker = env.services.postPage(post.id, asker.id).questions.items.find((item) => item.id === pending.id);
    assert.equal(hiddenForAsker.hidden, true);
    assert.equal(hiddenForAsker.question, '可以改成素食嗎');
    assert.equal(env.services.postPage(post.id, founder.id).questions.items.some((item) => item.canDelete), true);
    assert.equal(messageOf(() => env.services.answerQuestion(post.id, pending.id, author.id, '可以')), '這則提問已經隱藏。');

    env.services.deleteQuestion(post.id, pending.id, founder.id);
    assert.equal(env.db.prepare('SELECT id FROM post_questions WHERE id = ?').get(pending.id), undefined);

    env.services.hideUser(author.id, asker.id);
    const concealed = env.services.postPage(post.id, asker.id).questions;
    assert.equal(concealed.concealed, true);
    assert.deepEqual(concealed.items, []);
    assert.equal(messageOf(() => env.services.askQuestion(post.id, asker.id, '封鎖後還想問')), '你們已設定不想再遇到，不能提問。');
    assert.equal(env.services.postPage(post.id, stranger.id).questions.items[0].question, '今晚還有熱湯嗎');
    assert.deepEqual(balances(env.db, author.id), { merit: 100, quota: 100 });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings').get().n, 0);
  } finally {
    env.close();
  }
});

test('過期、完成或下架後只能看，功德結算不變', () => {
  const env = setup();
  try {
    const author = env.services.register('0912888431', '作者');
    const asker = env.services.register('0912888432', '提問者');
    const founder = env.services.ensureFounderAccount('0912888433', 'password-ok').user;

    const expired = env.services.createPost(author.id, { ...fields, title: '會過期' });
    const expiredQuestion = env.services.askQuestion(expired.id, asker.id, '過期前先問');
    env.db.prepare(`UPDATE posts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(expired.id);
    const expiredPage = env.services.postPage(expired.id, asker.id).questions;
    assert.equal(expiredPage.open, false);
    assert.equal(expiredPage.canAsk, false);
    assert.equal(expiredPage.items[0].question, '過期前先問');
    assert.equal(expiredPage.items[0].canAnswer, false);
    assert.equal(messageOf(() => env.services.askQuestion(expired.id, asker.id, '過期後再問')), '這則已經不能再問。');
    assert.equal(messageOf(() => env.services.answerQuestion(expired.id, expiredQuestion.id, author.id, '太晚了')), '這則已經不能再回覆。');

    const dropped = env.services.createPost(author.id, { ...fields, title: '會下架' });
    env.services.askQuestion(dropped.id, asker.id, '下架前的問題');
    env.services.cancelPost(dropped.id, author.id);
    assert.equal(env.services.postPage(dropped.id, null).questions.open, false);
    assert.equal(env.services.postPage(dropped.id, asker.id).questions.items[0].question, '下架前的問題');
    assert.equal(messageOf(() => env.services.askQuestion(dropped.id, asker.id, '下架後再問')), '這則已經不能再問。');
    env.services.hideQuestion(dropped.id, env.db.prepare('SELECT id FROM post_questions WHERE post_id = ?').get(dropped.id).id, author.id);
    assert.equal(env.db.prepare('SELECT hidden_at IS NOT NULL AS hidden FROM post_questions WHERE post_id = ?').get(dropped.id).hidden, 1);

    const done = env.services.createPost(author.id, fields);
    const doneQuestion = env.services.askQuestion(done.id, asker.id, '結算前的問題');
    env.services.acceptPost(done.id, asker.id);
    assert.equal(messageOf(() => env.services.askQuestion(done.id, env.services.register('0912888434', '路人').id, '進行中還能問嗎')), '這則已經不能再問。');
    const ledgerBefore = env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
    env.services.submitValue(done.id, author.id, 10);
    const settled = env.services.submitValue(done.id, asker.id, 10);
    assert.equal(settled.status, 'settled');
    const host = balances(env.db, author.id);
    const seeker = balances(env.db, asker.id);
    assert.deepEqual(host, { merit: 110, quota: 110 });
    assert.deepEqual(seeker, { merit: 90, quota: 110 });
    const settledPage = env.services.postPage(done.id, author.id).questions;
    assert.equal(settledPage.open, false);
    assert.equal(settledPage.items[0].question, '結算前的問題');
    assert.equal(settledPage.items[0].canAnswer, false);
    assert.equal(messageOf(() => env.services.answerQuestion(done.id, doneQuestion.id, author.id, '結算後才回')), '這則已經不能再回覆。');
    assert.equal(messageOf(() => env.services.askQuestion(done.id, env.services.register('0912888435', '另一人').id, '完成後再問')), '這則已經不能再問。');
    env.services.deleteQuestion(done.id, doneQuestion.id, founder.id);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM post_questions WHERE post_id = ?').get(done.id).n, 0);
    assert.deepEqual(balances(env.db, author.id), host);
    assert.deepEqual(balances(env.db, asker.id), seeker);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings').get().n, 0);
    assert.ok(env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n > ledgerBefore);
    const ledgerAfter = env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
    assert.equal(messageOf(() => env.services.askQuestion(done.id, asker.id, '再問一次')), '這則已經不能再問。');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, ledgerAfter);
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

test('問答標籤、未回覆數和登入後才能提問', async () => {
  const env = setup();
  const password = 'password-ok';
  const author = env.services.registerWithPassword('0912888441', '作者', password, password);
  const asker = env.services.registerWithPassword('0912888442', '提問者', password, password);
  const stranger = env.services.registerWithPassword('0912888443', '路人', password, password);
  const founder = env.services.ensureFounderAccount('0912888444', password).user;
  const post = env.services.createPost(author.id, fields);
  env.services.askQuestion(post.id, asker.id, '今晚還有熱湯嗎');
  const app = createApp({ db: env.db, sessionSecret: 'qa-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const guest = cookieJar();
    const home = await request(base, guest, '/');
    assert.match(home.text, /問答 1/);
    const login = await request(base, guest, '/login');
    const page = await request(base, guest, `/posts/${post.id}`);
    assert.match(page.text, /今晚還有熱湯嗎/);
    assert.match(page.text, new RegExp(`/login\\?next=/posts/${post.id}%23qa`));
    assert.equal(page.text.includes('name="question"'), false);
    const blocked = await request(base, guest, `/posts/${post.id}/questions`, {
      _csrf: csrfOf(login.text),
      question: '沒登入也想問',
    });
    assert.equal(blocked.status, 302);
    assert.equal(blocked.location, '/login');
    assert.equal(questionRows(env.db, post.id).length, 1);

    const authorJar = cookieJar();
    await signIn(base, authorJar, author.mobile);
    const mine = await request(base, authorJar, '/me');
    assert.match(mine.text, /未回覆 1/);
    const stale = await request(base, authorJar, `/posts/${post.id}/questions/${env.db.prepare('SELECT id FROM post_questions').get().id}/answer`, {
      answer: '沒有驗證',
    });
    assert.equal(stale.status, 303);
    assert.equal(env.db.prepare('SELECT answer FROM post_questions').get().answer, null);

    const askerJar = cookieJar();
    await signIn(base, askerJar, asker.mobile);
    const askerPage = await request(base, askerJar, `/posts/${post.id}`);
    const rejected = await request(base, askerJar, `/posts/${post.id}/questions/${env.db.prepare('SELECT id FROM post_questions').get().id}/answer`, {
      _csrf: csrfOf(askerPage.text),
      answer: '我不是作者',
    });
    assert.equal(rejected.status, 302);
    const rejectedPage = await request(base, askerJar, `/posts/${post.id}`);
    assert.match(rejectedPage.text, /只有發文者可以回覆。/);

    const authorPage = await request(base, authorJar, `/posts/${post.id}`);
    const questionId = env.db.prepare('SELECT id FROM post_questions').get().id;
    const answered = await request(base, authorJar, `/posts/${post.id}/questions/${questionId}/answer`, {
      _csrf: csrfOf(authorPage.text),
      answer: '還有，晚上七點前',
    });
    assert.equal(answered.status, 302);
    const after = await request(base, authorJar, '/me');
    assert.equal(after.text.includes('未回覆'), false);
    const shown = await request(base, guest, `/posts/${post.id}`);
    assert.match(shown.text, /還有，晚上七點前/);

    const cashPage = await request(base, askerJar, `/posts/${post.id}`);
    const cash = await request(base, askerJar, `/posts/${post.id}/questions`, {
      _csrf: csrfOf(cashPage.text),
      question: '可以 LINE Pay 嗎',
    });
    assert.equal(cash.status, 302);
    const cashShown = await request(base, askerJar, `/posts/${post.id}`);
    assert.match(cashShown.text, /宙斯法則禁止現金交易/);
    assert.equal(questionRows(env.db, post.id).length, 1);

    const asked = await request(base, askerJar, `/posts/${post.id}/questions`, {
      _csrf: csrfOf(cashShown.text),
      question: '可以改成素食嗎',
    });
    assert.equal(asked.status, 302);
    const waiting = await request(base, authorJar, '/me');
    assert.match(waiting.text, /未回覆 1/);
    const hidePage = await request(base, authorJar, `/posts/${post.id}`);
    const pendingId = env.db.prepare(`SELECT id FROM post_questions WHERE question = '可以改成素食嗎'`).get().id;
    const hidden = await request(base, authorJar, `/posts/${post.id}/questions/${pendingId}/hide`, {
      _csrf: csrfOf(hidePage.text),
    });
    assert.equal(hidden.status, 302);
    const strangerJar = cookieJar();
    await signIn(base, strangerJar, stranger.mobile);
    const publicPage = await request(base, strangerJar, `/posts/${post.id}`);
    assert.equal(publicPage.text.includes('可以改成素食嗎'), false);
    assert.match(publicPage.text, /今晚還有熱湯嗎/);
    const askerStill = await request(base, askerJar, `/posts/${post.id}`);
    assert.match(askerStill.text, /可以改成素食嗎/);
    assert.match(askerStill.text, /已隱藏/);
    const listed = await request(base, guest, '/');
    assert.match(listed.text, /問答 1/);

    env.services.hideUser(author.id, asker.id);
    const concealed = await request(base, askerJar, `/posts/${post.id}`);
    assert.equal(concealed.text.includes('id="qa"'), false);
    assert.equal(concealed.text.includes('今晚還有熱湯嗎'), false);

    const founderJar = cookieJar();
    await signIn(base, founderJar, founder.mobile);
    const founderPage = await request(base, founderJar, `/posts/${post.id}`);
    const removed = await request(base, founderJar, `/posts/${post.id}/questions/${questionId}/delete`, {
      _csrf: csrfOf(founderPage.text),
    });
    assert.equal(removed.status, 302);
    assert.equal(env.db.prepare('SELECT id FROM post_questions WHERE id = ?').get(questionId), undefined);
    const gone = await request(base, guest, `/posts/${post.id}`);
    assert.equal(gone.text.includes('今晚還有熱湯嗎'), false);
    assert.deepEqual(balances(env.db, author.id), { merit: 100, quota: 100 });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ratings').get().n, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});
