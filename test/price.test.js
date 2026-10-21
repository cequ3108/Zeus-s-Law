const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-price-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, { now: () => new Date('2026-10-03T02:00:00.000Z') });
  return {
    db,
    services,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('現金用語不能發文，結算數字不因此改變', () => {
  const env = setup();
  try {
    const author = env.services.register('0912300001', '作者');
    assert.throws(() => env.services.createPost(author.id, {
      kind: 'need', category: 'food', city: '臺北市', amount: 40,
      description: '請匯款給我',
    }), /匯款/);
    assert.throws(() => env.services.createPost(author.id, {
      kind: 'need', category: 'food', city: '臺北市', amount: 40,
      title: '轉帳給我', description: '便當',
    }), /轉帳給我/);
    const post = env.services.createPost(author.id, {
      kind: 'need', category: 'food', city: '臺北市', amount: 40, description: '正常的便當',
    });
    const helper = env.services.register('0912300002', '幫手');
    env.services.acceptPost(post.id, helper.id);
    env.services.submitValue(post.id, author.id, 30);
    const result = env.services.submitValue(post.id, helper.id, 50);
    assert.equal(result.amount, 30);
    assert.equal(env.db.prepare('SELECT merit FROM users WHERE id = ?').get(author.id).merit, 70);
  } finally {
    env.close();
  }
});

test('沒有紀錄時用模板區間，有結算後改看這個縣市', () => {
  const env = setup();
  try {
    const empty = env.services.priceHint('food', '臺北市');
    assert.equal(empty.source, 'template');
    assert.equal(empty.low, 60);
    assert.equal(empty.high, 120);

    const payer = env.services.register('0912300003', '付的人');
    const host = env.services.register('0912300004', '幫的人');
    const post = env.services.createPost(payer.id, {
      kind: 'need', category: 'food', city: '臺北市', amount: 40, description: '便當一份',
    });
    env.services.acceptPost(post.id, host.id);
    env.services.submitValue(post.id, host.id, 80);
    env.services.submitValue(post.id, payer.id, 45);
    const hinted = env.services.priceHint('food', '臺北市');
    assert.equal(hinted.source, 'history');
    assert.equal(hinted.typical, 45);
    assert.equal(env.services.priceHint('food', '高雄市').source, 'template');
  } finally {
    env.close();
  }
});
