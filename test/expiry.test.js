const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');

function setup(iso = '2026-10-03T02:00:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-exp-'));
  const db = openDatabase(path.join(dir, 't.db'));
  let current = new Date(iso);
  const services = createServices(db, { now: () => new Date(current) });
  return {
    db,
    services,
    setNow(value) { current = new Date(value); },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('新貼文預設 48 小時，過期後廣場隱藏且不能接下，重發會開一則新的', () => {
  const env = setup();
  try {
    const author = env.services.register('0912400001', '作者');
    const helper = env.services.register('0912400002', '幫手');
    const post = env.services.createPost(author.id, {
      kind: 'need', category: 'food', city: '臺北市', amount: 20, description: '便當',
    });
    const row = env.db.prepare('SELECT expires_at, created_at FROM posts WHERE id = ?').get(post.id);
    const span = new Date(row.expires_at) - new Date(row.created_at);
    assert.equal(span, 48 * 60 * 60 * 1000);
    assert.equal(env.services.listOpenPosts().length, 1);

    env.setNow('2026-10-06T02:00:00.000Z');
    assert.equal(env.services.listOpenPosts().length, 0);
    assert.throws(() => env.services.acceptPost(post.id, helper.id), /不能接下/);

    const again = env.services.repostPost(post.id, author.id);
    assert.notEqual(again.id, post.id);
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(post.id).status, 'cancelled');
    assert.equal(env.services.listOpenPosts()[0].id, again.id);
    env.services.acceptPost(again.id, helper.id);

    env.db.prepare(`
      INSERT INTO posts (author_id, kind, category, description, amount, status, created_at)
      VALUES (?, 'need', 'other', '舊貼文沒有期限', 10, 'open', '2020-01-01T00:00:00.000Z')
    `).run(author.id);
    assert.equal(env.services.listOpenPosts().some((item) => item.description === '舊貼文沒有期限'), true);
  } finally {
    env.close();
  }
});
