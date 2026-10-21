const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { backupDatabase } = require('../src/backup');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-ledger-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, { now: () => new Date('2026-10-03T02:00:00.000Z') });
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

test('帳本只追加，結算金額與既有規則相同', async () => {
  const env = setup();
  try {
    const payer = env.services.register('0912900001', '支出');
    const host = env.services.register('0912900002', '收入');
    const signup = env.db.prepare(`SELECT reason, delta_merit, delta_quota FROM ledger WHERE user_id = ?`).all(payer.id);
    assert.deepEqual(signup, [{ reason: 'signup', delta_merit: 100, delta_quota: 100 }]);

    const post = env.services.createPost(payer.id, {
      kind: 'need', category: 'food', city: '臺北市', amount: 40, description: '便當',
    });
    env.services.acceptPost(post.id, host.id);
    env.services.submitValue(post.id, host.id, 30);
    const settled = env.services.submitValue(post.id, payer.id, 20);
    assert.equal(settled.amount, 20);
    assert.equal(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(payer.id).merit, 80);
    assert.equal(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(payer.id).quota, 120);
    assert.equal(env.db.prepare('SELECT merit FROM users WHERE id = ?').get(host.id).merit, 120);

    const rows = env.db.prepare(`
      SELECT user_id, delta_merit, delta_quota, merit_after, quota_after, reason
      FROM ledger WHERE post_id = ? ORDER BY id
    `).all(post.id);
    assert.deepEqual(rows, [
      { user_id: payer.id, delta_merit: -20, delta_quota: 20, merit_after: 80, quota_after: 120, reason: 'settle_spend' },
      { user_id: host.id, delta_merit: 20, delta_quota: 20, merit_after: 120, quota_after: 120, reason: 'settle_receive' },
    ]);

    const ledgerId = env.db.prepare('SELECT id FROM ledger LIMIT 1').get().id;
    assert.throws(() => env.db.prepare('UPDATE ledger SET delta_merit = 1 WHERE id = ?').run(ledgerId));
    assert.throws(() => env.db.prepare('DELETE FROM ledger WHERE id = ?').run(ledgerId));
    assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM ledger').get().count, 4);

    const dest = await backupDatabase(env.db, path.join(env.dir, 'backups'));
    assert.equal(fs.existsSync(dest), true);
    assert.match(path.basename(dest), /^zeus-.*\.db$/);
  } finally {
    env.close();
  }
});
