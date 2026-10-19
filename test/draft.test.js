const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const draft = require('../public/draft');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { asset } = require('../src/assets');

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

function radioGroup(selected, choices) {
  const nodes = choices.map((choice) => ({
    type: 'radio',
    value: choice,
    checked: choice === selected,
  }));
  const group = { length: nodes.length };
  nodes.forEach((node, index) => { group[index] = node; });
  Object.defineProperty(group, 'value', {
    get() {
      const picked = nodes.find((node) => node.checked);
      return picked ? picked.value : '';
    },
  });
  return group;
}

function fakeForm(userId, values = {}) {
  const fields = {};
  for (const name of draft.FIELDS) {
    if (name === 'kind') fields.kind = radioGroup(values.kind || '', ['offer', 'need']);
    else fields[name] = { type: 'text', value: values[name] || '' };
  }
  const listeners = {};
  return {
    fields,
    getAttribute(name) { return name === 'data-draft-user' ? String(userId) : null; },
    elements: { namedItem(name) { return fields[name] || null; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) { (listeners[type] || []).forEach((fn) => fn({ preventDefault() {} })); },
  };
}

function fakeDocument(form, clearFlag = '') {
  const notice = { hidden: true };
  const clearButton = {
    listeners: [],
    addEventListener(type, fn) { if (type === 'click') this.listeners.push(fn); },
    click() { this.listeners.forEach((fn) => fn({ preventDefault() {} })); },
  };
  const view = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn()); },
  };
  return {
    form,
    notice,
    clearButton,
    view,
    body: { getAttribute() { return clearFlag || null; } },
    defaultView: view,
    querySelector(selector) {
      if (selector === 'form[data-draft-user]') return form;
      if (selector === '[data-draft-notice]') return notice;
      if (selector === '[data-draft-clear]') return clearButton;
      return null;
    },
  };
}

function manualClock() {
  const pending = [];
  return {
    pending,
    setTimer(fn, ms) {
      const id = pending.length + 1;
      pending.push({ id, fn, ms, cleared: false });
      return id;
    },
    clearTimer(id) {
      const item = pending.find((entry) => entry.id === id);
      if (item) item.cleared = true;
    },
  };
}

test('停打大約一秒才存進這個帳號的草稿', () => {
  const storage = memoryStorage({ 'other-key': 'keep' });
  const form = fakeForm(4, { city: '臺北市', expires_hours: '48' });
  const doc = fakeDocument(form);
  const clock = manualClock();
  draft.mount(doc, { storage, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  form.fields.title.value = '熱便當';
  form.fields.description.value = '公館可拿';
  form.dispatch('input');
  assert.equal(storage.getItem(draft.keyFor(4)), null);
  assert.equal(clock.pending[0].ms, draft.DELAY);

  form.fields.title.value = '熱便當一份';
  form.dispatch('input');
  assert.equal(clock.pending[0].cleared, true);
  assert.equal(storage.getItem(draft.keyFor(4)), null);
  clock.pending[1].fn();

  const saved = draft.load(storage, 4);
  assert.equal(saved.title, '熱便當一份');
  assert.equal(saved.description, '公館可拿');
  assert.equal(saved.city, '臺北市');
  assert.equal(draft.load(storage, 5), null);
  assert.equal(storage.getItem('other-key'), 'keep');

  form.fields.amount.value = '40';
  form.dispatch('change');
  doc.view.dispatch('pagehide');
  assert.equal(draft.load(storage, 4).amount, '40');
  assert.equal(clock.pending[2].cleared, true);
});

test('打開發文頁會帶回草稿，清除後回到原本的表單', () => {
  const storage = memoryStorage();
  draft.save(storage, 4, {
    kind: 'need',
    category: 'food',
    title: '上次的便當',
    city: '臺北市',
    district: '大安區',
    amount: '40',
    meeting_place: '公館',
    meeting_time: '中午',
    expires_hours: '24',
    description: '還沒送出',
  });
  const form = fakeForm(4, { kind: 'offer', city: '新北市', expires_hours: '48', title: '模板標題' });
  const doc = fakeDocument(form);
  draft.mount(doc, { storage, setTimer() { return 1; }, clearTimer() {} });

  assert.equal(form.fields.title.value, '上次的便當');
  assert.equal(form.fields.description.value, '還沒送出');
  assert.equal(form.fields.kind.value, 'need');
  assert.equal(form.fields.expires_hours.value, '24');
  assert.equal(doc.notice.hidden, false);
  assert.equal(draft.load(storage, 9), null);

  doc.clearButton.click();
  assert.equal(storage.getItem(draft.keyFor(4)), null);
  assert.equal(form.fields.title.value, '模板標題');
  assert.equal(form.fields.kind.value, 'offer');
  assert.equal(form.fields.city.value, '新北市');
  assert.equal(form.fields.description.value, '');
  assert.equal(doc.notice.hidden, true);
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-draft-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
  return {
    dir, db, services,
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
  const app = createApp({ db, sessionSecret: 'draft-secret', cookieSecure: false });
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

test('發文頁帶草稿鉤子，送出成功才清，失敗則留著', async () => {
  const env = setup();
  const password = 'draft-password';
  const user = env.services.registerWithPassword('0912999601', '草稿的人', password, password);
  const before = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(user.id);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912999601', password);
    const page = await request(app.base, jar, '/posts/new');
    assert.match(page.text, new RegExp(`data-draft-user="${user.id}"`));
    assert.match(page.text, /data-draft-notice hidden/);
    assert.match(page.text, /已帶回上次未送出的草稿/);
    assert.match(page.text, /清除草稿/);
    assert.match(page.text, new RegExp(`src="${asset('/draft.js').replace('?', '\\?')}"`));
    assert.equal(page.text.includes('data-clear-draft'), false);

    const rejected = await request(app.base, jar, '/posts', {
      _csrf: csrfOf(page.text),
      kind: 'offer',
      category: 'food',
      city: '臺北市',
      amount: '10',
      description: '',
    });
    assert.equal(rejected.status, 302);
    assert.equal(rejected.location, '/posts/new');
    const again = await request(app.base, jar, rejected.location);
    assert.equal(again.text.includes('data-clear-draft'), false);
    assert.match(again.text, /data-draft-user=/);

    const created = await request(app.base, jar, '/posts', {
      _csrf: csrfOf(again.text),
      kind: 'offer',
      category: 'food',
      title: '公館便當',
      city: '臺北市',
      amount: '10',
      description: '一份熱便當。',
    });
    assert.equal(created.status, 302);
    assert.equal(created.location, '/posts/1');
    const shown = await request(app.base, jar, created.location);
    assert.match(shown.text, /已發布/);
    assert.match(shown.text, /一份熱便當/);
    assert.match(shown.text, new RegExp(`data-clear-draft="${user.id}"`));
    assert.match(shown.text, new RegExp(`src="${asset('/draft.js').replace('?', '\\?')}"`));
    const later = await request(app.base, jar, created.location);
    assert.equal(later.text.includes('data-clear-draft'), false);
    assert.deepEqual(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(user.id), before);

    const storage = memoryStorage();
    draft.save(storage, user.id, { title: '要清掉' });
    draft.save(storage, 99, { title: '別人的' });
    draft.mount(fakeDocument(null, String(user.id)), { storage });
    assert.equal(draft.load(storage, user.id), null);
    assert.equal(draft.load(storage, 99).title, '別人的');
  } finally {
    await close(app.server);
    env.close();
  }
});

test('登出的下一頁會清掉所有帳號的草稿', async () => {
  const env = setup();
  const password = 'draft-password';
  env.services.registerWithPassword('0912999602', '要走的人', password, password);
  const app = await listen(env.db);
  const jar = cookieJar();
  try {
    await signIn(app.base, jar, '0912999602', password);
    const account = await request(app.base, jar, '/account');
    const loggedOut = await request(app.base, jar, '/logout', { _csrf: csrfOf(account.text) });
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.location, '/?clear-draft=1');
    const home = await request(app.base, jar, loggedOut.location);
    assert.match(home.text, /data-clear-draft="all"/);
    assert.match(home.text, new RegExp(`src="${asset('/draft.js').replace('?', '\\?')}"`));
    assert.equal(home.text.includes('登出'), false);

    const storage = memoryStorage({ 'unrelated': 'stay' });
    draft.save(storage, 3, { title: '甲' });
    draft.save(storage, 8, { description: '乙' });
    draft.mount(fakeDocument(null, 'all'), { storage });
    assert.equal(draft.load(storage, 3), null);
    assert.equal(draft.load(storage, 8), null);
    assert.equal(storage.getItem('unrelated'), 'stay');
  } finally {
    await close(app.server);
    env.close();
  }
});
