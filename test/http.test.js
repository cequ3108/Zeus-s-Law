const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

function cookieJar() {
  const cookies = new Map();
  return {
    absorb(response) {
      const list = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
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

async function request(base, jar, urlPath, options = {}) {
  const headers = {};
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  let body;
  if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form);
  }
  const target = urlPath.startsWith('http') ? urlPath : base + urlPath;
  const response = await fetch(target, {
    method: options.method || 'GET',
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
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, '頁面應有 CSRF');
  return match[1];
}

function devCodeOf(html) {
  const match = html.match(/id="dev-code">(\d{6})</);
  assert.ok(match, '開發模式應顯示驗證碼');
  return match[1];
}

async function login(base, jar, mobile, name) {
  let page = await request(base, jar, '/login');
  let response = await request(base, jar, '/login', {
    method: 'POST',
    form: { _csrf: csrfOf(page.text), mobile },
  });
  assert.equal(response.status, 302);
  page = await request(base, jar, response.location);
  const code = devCodeOf(page.text);
  response = await request(base, jar, '/verify', {
    method: 'POST',
    form: { _csrf: csrfOf(page.text), code },
  });
  assert.equal(response.status, 302);
  if (response.location.endsWith('/register')) {
    page = await request(base, jar, '/register');
    assert.equal(page.text.includes('value="founder"'), false);
    assert.equal(page.text.includes('value="org"'), false);
    assert.match(page.text, /不會出現在註冊選項/);
    response = await request(base, jar, '/register', {
      method: 'POST',
      form: { _csrf: csrfOf(page.text), display_name: name, role: 'founder' },
    });
    assert.equal(response.status, 302);
  }
  return request(base, jar, response.location);
}

test('從註冊到結算、每日一次，以及星等不顯示備註', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-http-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const app = createApp({ db, sessionSecret: 'test-secret', cookieSecure: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const marker = '秘密評語MARKER7788';
  const otherMarker = '另一則備註MARKER8899';

  try {
    const home = await request(base, cookieJar(), '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /禁止現金/);
    assert.match(home.text, /開發模式/);

    const jarA = cookieJar();
    const meA = await login(base, jarA, '0918111001', '阿明');
    assert.match(meA.text, /一般使用者/);
    assert.match(meA.text, /data-merit="100"/);
    assert.match(meA.text, /data-quota="100"/);
    assert.equal(meA.text.includes('100000000'), false);

    const newPage = await request(base, jarA, '/posts/new');
    const created = await request(base, jarA, '/posts', {
      method: 'POST',
      form: {
        _csrf: csrfOf(newPage.text),
        kind: 'need',
        category: 'food',
        amount: '40',
        description: '需要一份午餐便當，在公館。',
      },
    });
    assert.equal(created.status, 302);
    const postUrl = created.location;

    const jarB = cookieJar();
    await login(base, jarB, '0918111002', '阿花');
    const openPost = await request(base, jarB, postUrl);
    const accepted = await request(base, jarB, `${postUrl}/accept`, {
      method: 'POST',
      form: { _csrf: csrfOf(openPost.text) },
    });
    assert.equal(accepted.status, 302);

    const forA = await request(base, jarA, postUrl);
    const valueA = await request(base, jarA, `${postUrl}/value`, {
      method: 'POST',
      form: { _csrf: csrfOf(forA.text), value: '30', confirm_done: '1' },
    });
    assert.equal(valueA.status, 302);
    const waiting = await request(base, jarA, valueA.location);
    assert.match(waiting.text, /等對方/);
    assert.equal(waiting.text.includes('data-settled='), false);

    const forB = await request(base, jarB, postUrl);
    assert.equal(forB.text.includes('>30<') && forB.text.includes('data-my-value'), false);
    const valueB = await request(base, jarB, `${postUrl}/value`, {
      method: 'POST',
      form: { _csrf: csrfOf(forB.text), value: '50', confirm_done: '1' },
    });
    const settled = await request(base, jarB, valueB.location);
    assert.match(settled.text, /data-settled="30"/);
    assert.match(settled.text, /取較低者/);

    const afterA = await request(base, jarA, '/me');
    const afterB = await request(base, jarB, '/me');
    assert.match(afterA.text, /data-merit="70"/);
    assert.match(afterA.text, /data-quota="130"/);
    assert.match(afterB.text, /data-merit="130"/);
    assert.match(afterB.text, /data-quota="130"/);

    const secondPage = await request(base, jarA, '/posts/new');
    const second = await request(base, jarA, '/posts', {
      method: 'POST',
      form: {
        _csrf: csrfOf(secondPage.text),
        kind: 'need',
        category: 'transport',
        amount: '10',
        description: '同一天再請求一次接送。',
      },
    });
    const secondUrl = second.location;
    const secondOpen = await request(base, jarB, secondUrl);
    await request(base, jarB, `${secondUrl}/accept`, {
      method: 'POST',
      form: { _csrf: csrfOf(secondOpen.text) },
    });
    const secondA = await request(base, jarA, secondUrl);
    await request(base, jarA, `${secondUrl}/value`, {
      method: 'POST',
      form: { _csrf: csrfOf(secondA.text), value: '10', confirm_done: '1' },
    });
    const secondB = await request(base, jarB, secondUrl);
    const dailyPost = await request(base, jarB, `${secondUrl}/value`, {
      method: 'POST',
      form: { _csrf: csrfOf(secondB.text), value: '10', confirm_done: '1' },
    });
    const dailyPage = await request(base, jarB, dailyPost.location);
    assert.match(dailyPage.text, /已經結算過一次/);
    const unchanged = await request(base, jarA, '/me');
    assert.match(unchanged.text, /data-merit="70"/);
    assert.match(unchanged.text, /data-quota="130"/);

    const ratePage = await request(base, jarA, postUrl);
    const rated = await request(base, jarA, `${postUrl}/rating`, {
      method: 'POST',
      form: { _csrf: csrfOf(ratePage.text), stars: '5', comment: marker },
    });
    const ratedPage = await request(base, jarA, rated.location);
    assert.match(ratedPage.text, /5 星/);
    assert.equal(ratedPage.text.includes(marker), false);

    const ratePageB = await request(base, jarB, postUrl);
    await request(base, jarB, `${postUrl}/rating`, {
      method: 'POST',
      form: { _csrf: csrfOf(ratePageB.text), stars: '4', comment: otherMarker },
    });

    const userA = db.prepare('SELECT id FROM users WHERE mobile = ?').get('0918111001');
    const userB = db.prepare('SELECT id FROM users WHERE mobile = ?').get('0918111002');
    const stranger = cookieJar();
    const profileA = await request(base, stranger, `/users/${userA.id}`);
    const profileB = await request(base, stranger, `/users/${userB.id}`);
    assert.match(profileA.text, /data-rating-count="1"/);
    assert.match(profileA.text, /4 星/);
    assert.match(profileB.text, /5 星/);
    assert.equal(profileA.text.includes(marker), false);
    assert.equal(profileA.text.includes(otherMarker), false);
    assert.equal(profileB.text.includes(marker), false);
    assert.equal(profileB.text.includes(otherMarker), false);
    const comments = db.prepare('SELECT comment FROM ratings ORDER BY id').all().map((row) => row.comment);
    assert.deepEqual(comments, [marker, otherMarker]);

    const scriptPost = await request(base, jarA, '/posts/new');
    const hostile = await request(base, jarA, '/posts', {
      method: 'POST',
      form: {
        _csrf: csrfOf(scriptPost.text),
        kind: 'offer',
        category: 'other',
        amount: '10',
        description: '<img src=x onerror=alert(1)>',
      },
    });
    const shown = await request(base, stranger, hostile.location);
    assert.equal(shown.text.includes('<img'), false);
    assert.match(shown.text, /&lt;img/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
