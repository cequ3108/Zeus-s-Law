const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { weekRange } = require('../src/time');

test('台北週從週一算到週日', () => {
  const range = weekRange(new Date('2026-10-03T02:00:00.000Z'));
  assert.equal(range.start, '2026-09-28');
  assert.equal(range.end, '2026-10-04');
});

test('本週功德進出只加總這一週，而且不改餘額', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-week-'));
  const db = openDatabase(path.join(dir, 't.db'));
  let current = new Date('2026-10-03T02:00:00.000Z');
  const services = createServices(db, { now: () => new Date(current) });
  try {
    const payer = services.register('0912800001', '支出的人');
    const host = services.register('0912800002', '收入的人');
    const post = services.createPost(payer.id, {
      kind: 'need', category: 'food', city: '臺北市', amount: 30, description: '便當',
    });
    services.acceptPost(post.id, host.id);
    services.submitValue(post.id, host.id, 30);
    services.submitValue(post.id, payer.id, 20);
    const payerWeek = services.weeklySummary(payer.id);
    const hostWeek = services.weeklySummary(host.id);
    assert.equal(payerWeek.spent, 20);
    assert.equal(payerWeek.received, 0);
    assert.equal(payerWeek.quotaGained, 20);
    assert.equal(hostWeek.received, 20);
    assert.equal(hostWeek.quotaGained, 20);
    assert.equal(db.prepare('SELECT merit FROM users WHERE id = ?').get(payer.id).merit, 80);

    current = new Date('2026-10-05T02:00:00.000Z');
    assert.equal(services.weeklySummary(payer.id).spent, 0);
    assert.equal(services.weeklySummary(host.id).received, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
