const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-search-'));
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

function post(env, authorId, extra = {}) {
  return env.services.createPost(authorId, {
    kind: 'need',
    category: 'food',
    description: '一份說明',
    amount: 20,
    city: '臺北市',
    ...extra,
  });
}

function titles(env, filter) {
  return env.services.listOpenPosts(filter).map((item) => item.title);
}

test('關鍵字比對標題和描述，大小寫不分，萬用字元只當文字', () => {
  const env = setup();
  try {
    const author = env.services.register('0912555001', '作者');
    post(env, author.id, { title: '熱便當', description: '公館可拿' });
    post(env, author.id, { title: '其他', description: '晚上可以共乘' });
    post(env, author.id, { title: 'Bento Night', description: '英文標題' });
    post(env, author.id, { title: '100% 實在', description: '有百分號' });
    post(env, author.id, { title: 'a_b 底線', description: '有底線' });
    post(env, author.id, { title: 'ab 沒有底線', description: '普通' });

    assert.deepEqual(titles(env, { query: '便當' }), ['熱便當']);
    assert.deepEqual(titles(env, { query: '共乘' }), ['其他']);
    assert.deepEqual(titles(env, { query: 'bento' }), ['Bento Night']);
    assert.deepEqual(titles(env, { query: 'BENTO' }), ['Bento Night']);
    assert.deepEqual(titles(env, { query: '%' }), ['100% 實在']);
    assert.deepEqual(titles(env, { query: '_' }), ['a_b 底線']);
    assert.equal(titles(env, { query: '   ' }).length, 6);
  } finally {
    env.close();
  }
});

test('排序預設最新，也可以依功德或到期', () => {
  const env = setup();
  try {
    const author = env.services.register('0912555002', '作者');
    const low = post(env, author.id, { title: '低', amount: 10 });
    const high = post(env, author.id, { title: '高', amount: 40 });
    const mid = post(env, author.id, { title: '中', amount: 20 });
    env.db.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').run('2099-06-01T00:00:00.000Z', low.id);
    env.db.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', high.id);
    env.db.prepare('UPDATE posts SET expires_at = NULL WHERE id = ?').run(mid.id);

    assert.deepEqual(titles(env, {}), ['中', '高', '低']);
    assert.deepEqual(titles(env, { sort: 'new' }), ['中', '高', '低']);
    assert.deepEqual(titles(env, { sort: 'amount_desc' }), ['高', '中', '低']);
    assert.deepEqual(titles(env, { sort: 'amount_asc' }), ['低', '中', '高']);
    assert.deepEqual(titles(env, { sort: 'expiry' }), ['高', '低', '中']);
    assert.deepEqual(titles(env, { sort: 'drop table' }), ['中', '高', '低']);
  } finally {
    env.close();
  }
});

test('搜尋和排序會跟縣市、種類、公共場所一起算', () => {
  const env = setup();
  try {
    const author = env.services.register('0912555003', '作者');
    post(env, author.id, {
      title: '臺北便當', description: '超商拿', amount: 30, city: '臺北市', category: 'food', meeting_mode: '超商',
    });
    post(env, author.id, {
      title: '高雄便當', description: '超商拿', amount: 10, city: '高雄市', category: 'food', meeting_mode: '超商',
    });
    post(env, author.id, {
      title: '臺北共乘', description: '便當不相關', amount: 50, city: '臺北市', category: 'transport', meeting_mode: '超商',
    });
    post(env, author.id, {
      title: '到府便當', description: '送到家', amount: 5, city: '臺北市', category: 'food', meeting_mode: '到府或上門',
    });

    assert.deepEqual(titles(env, {
      query: '便當',
      city: '臺北市',
      category: 'food',
      publicMeeting: true,
      sort: 'amount_asc',
    }), ['臺北便當']);
  } finally {
    env.close();
  }
});

test('封鎖、不想再遇到、撤下和過期的貼文不會出現在搜尋結果', () => {
  const env = setup();
  try {
    const viewer = env.services.register('0912555004', '看的人');
    const author = env.services.register('0912555005', '作者');
    const hidden = env.services.register('0912555006', '被藏');
    const banned = env.services.register('0912555007', '被封');
    const open = post(env, author.id, { title: '開放便當' });
    post(env, hidden.id, { title: '藏起來的便當' });
    post(env, banned.id, { title: '封鎖便當' });
    const cancelled = post(env, author.id, { title: '取消便當' });
    const settled = post(env, author.id, { title: '結算便當' });
    const expired = post(env, author.id, { title: '過期便當' });
    env.services.hideUser(viewer.id, hidden.id);
    env.db.prepare('UPDATE users SET blocked = 1 WHERE id = ?').run(banned.id);
    env.services.cancelPost(cancelled.id, author.id);
    env.db.prepare(`UPDATE posts SET status = 'settled' WHERE id = ?`).run(settled.id);
    env.db.prepare(`UPDATE posts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(expired.id);

    assert.deepEqual(titles(env, { query: '便當', viewerId: viewer.id }), ['開放便當']);
    assert.equal(open.id > 0, true);
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

async function request(base, jar, urlPath) {
  const headers = {};
  if (jar && jar.header()) headers.cookie = jar.header();
  const response = await fetch(base + urlPath, { headers, redirect: 'manual' });
  if (jar) jar.absorb(response);
  return { status: response.status, text: await response.text() };
}

test('沒有相符貼文時顯示換關鍵字，條件留在網址上', async () => {
  const env = setup();
  const app = createApp({ db: env.db, sessionSecret: 'search-secret', cookieSecure: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const author = env.services.register('0912555008', '作者');
    post(env, author.id, { title: '熱便當', description: '公館', amount: 40, meeting_mode: '超商' });
    post(env, author.id, { title: '冷便當', description: '公館', amount: 15, meeting_mode: '超商' });

    const missed = await request(base, null, '/?city=all&q=' + encodeURIComponent('沒有這個詞'));
    assert.equal(missed.status, 200);
    assert.equal(missed.text.includes('找不到相符的貼文，換個關鍵字試試'), true);
    assert.equal(missed.text.includes('placeholder="搜尋便當、共乘、陪看病…"'), true);
    assert.equal(missed.text.includes('value="沒有這個詞"'), true);
    assert.equal(missed.text.includes('廣場還沒有招募中的貼文。'), false);

    const found = await request(base, null, '/?city=all&category=food&public=1&sort=amount_asc&q=' + encodeURIComponent('便當'));
    assert.equal(found.text.includes('找不到相符的貼文，換個關鍵字試試'), false);
    assert.equal(found.text.indexOf('冷便當') < found.text.indexOf('熱便當'), true);
    assert.equal(found.text.includes('value="便當"'), true);
    assert.equal(found.text.includes('option value="amount_asc" selected'), true);
    assert.equal(found.text.includes('href="/?city=all&amp;category=food&amp;public=1&amp;sort=amount_asc"'), true);

    const plain = await request(base, null, '/?city=all');
    assert.equal(plain.text.includes('廣場還沒有招募中的貼文。'), false);
    assert.equal(plain.text.includes('熱便當'), true);
    const otherCity = await request(base, null, '/?city=' + encodeURIComponent('高雄市'));
    assert.equal(otherCity.text.includes('廣場還沒有招募中的貼文。'), true);
    assert.equal(otherCity.text.includes('找不到相符的貼文，換個關鍵字試試'), false);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});
