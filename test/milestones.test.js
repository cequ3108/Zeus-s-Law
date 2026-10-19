const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { milestoneBoard } = require('../src/milestones');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-milestone-'));
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

function earnedLabels(completed, fives) {
  return milestoneBoard(completed, fives).badges.filter((badge) => badge.earned).map((badge) => badge.label);
}

function remaining(completed, fives, label) {
  return milestoneBoard(completed, fives).badges.find((badge) => badge.label === label).remaining;
}

test('里程碑門檻剛好在 0、1、4、5、19、20，五星要滿 10', () => {
  assert.deepEqual(earnedLabels(0, 0), []);
  assert.equal(milestoneBoard(0, 0).highest, '');
  assert.equal(remaining(0, 0, '首次互助'), 1);
  assert.equal(remaining(0, 0, '好評達人'), 10);

  assert.deepEqual(earnedLabels(1, 0), ['首次互助']);
  assert.equal(remaining(1, 0, '熱心 5次'), 4);

  assert.deepEqual(earnedLabels(4, 0), ['首次互助']);
  assert.equal(remaining(4, 0, '熱心 5次'), 1);
  assert.equal(milestoneBoard(4, 0).highest, '首次互助');

  assert.deepEqual(earnedLabels(5, 0), ['首次互助', '熱心 5次']);
  assert.equal(milestoneBoard(5, 0).highest, '熱心 5次');
  assert.equal(remaining(5, 0, '熱心 20次'), 15);

  assert.equal(milestoneBoard(19, 0).highest, '熱心 5次');
  assert.equal(remaining(19, 0, '熱心 20次'), 1);
  assert.equal(earnedLabels(19, 0).includes('熱心 20次'), false);

  assert.equal(milestoneBoard(20, 0).highest, '熱心 20次');
  assert.equal(remaining(20, 0, '熱心 50次'), 30);
  assert.equal(remaining(49, 0, '熱心 50次'), 1);
  assert.equal(milestoneBoard(50, 0).highest, '熱心 50次');

  assert.equal(remaining(0, 9, '好評達人'), 1);
  assert.equal(earnedLabels(0, 9).includes('好評達人'), false);
  assert.equal(milestoneBoard(20, 10).highest, '好評達人');
  assert.equal(milestoneBoard(50, 10).highest, '好評達人');
});

function addPost(db, authorId, status, hostId, seekerId) {
  return Number(db.prepare(`
    INSERT INTO posts (
      author_id, kind, category, description, amount, status, created_at, city,
      host_id, seeker_id, settled_amount
    ) VALUES (?, 'offer', 'food', '互助', 10, ?, '2026-01-01T00:00:00.000Z', '臺北市', ?, ?, ?)
  `).run(authorId, status, hostId, seekerId, status === 'settled' ? 10 : null).lastInsertRowid);
}

test('只有已結算的互助才算，幫過和被幫過都算，4 星不算五星', () => {
  const env = setup();
  try {
    const member = env.services.register('0912999801', '里程的人');
    const other = env.services.register('0912999802', '對方');
    assert.equal(env.services.milestoneCounts(member.id).completed, 0);
    assert.equal(env.services.milestoneCounts(member.id).highest, '');

    addPost(env.db, member.id, 'open', null, null);
    addPost(env.db, member.id, 'matched', member.id, other.id);
    addPost(env.db, member.id, 'cancelled', member.id, other.id);
    assert.equal(env.services.milestoneCounts(member.id).completed, 0);

    addPost(env.db, other.id, 'settled', other.id, member.id);
    let board = env.services.milestoneCounts(member.id);
    assert.equal(board.completed, 1);
    assert.equal(board.highest, '首次互助');
    assert.equal(board.badges.find((badge) => badge.id === 'keen-5').remaining, 4);

    for (let i = 0; i < 3; i += 1) addPost(env.db, member.id, 'settled', member.id, other.id);
    board = env.services.milestoneCounts(member.id);
    assert.equal(board.completed, 4);
    assert.equal(board.highest, '首次互助');
    assert.equal(board.badges.find((badge) => badge.id === 'keen-5').remaining, 1);

    addPost(env.db, member.id, 'settled', member.id, other.id);
    board = env.services.milestoneCounts(member.id);
    assert.equal(board.completed, 5);
    assert.equal(board.highest, '熱心 5次');

    for (let i = 0; i < 14; i += 1) addPost(env.db, member.id, 'settled', member.id, other.id);
    board = env.services.milestoneCounts(member.id);
    assert.equal(board.completed, 19);
    assert.equal(board.highest, '熱心 5次');
    assert.equal(board.badges.find((badge) => badge.id === 'keen-20').remaining, 1);

    const posts = [];
    posts.push(addPost(env.db, member.id, 'settled', member.id, other.id));
    board = env.services.milestoneCounts(member.id);
    assert.equal(board.completed, 20);
    assert.equal(board.highest, '熱心 20次');
    assert.equal(board.badges.find((badge) => badge.id === 'keen-50').remaining, 30);

    const settledIds = env.db.prepare(`
      SELECT id FROM posts WHERE status = 'settled' AND (host_id = ? OR seeker_id = ?) ORDER BY id
    `).all(member.id, member.id).map((row) => row.id);
    for (let i = 0; i < 9; i += 1) {
      env.db.prepare(`
        INSERT INTO ratings (post_id, rater_id, ratee_id, stars, created_at)
        VALUES (?, ?, ?, 5, '2026-02-01T00:00:00.000Z')
      `).run(settledIds[i], other.id, member.id);
    }
    env.db.prepare(`
      INSERT INTO ratings (post_id, rater_id, ratee_id, stars, created_at)
      VALUES (?, ?, ?, 4, '2026-02-01T00:00:00.000Z')
    `).run(settledIds[9], other.id, member.id);
    board = env.services.milestoneCounts(member.id);
    assert.equal(board.fives, 9);
    assert.equal(board.badges.find((badge) => badge.id === 'praised').earned, false);
    assert.equal(board.badges.find((badge) => badge.id === 'praised').remaining, 1);
    assert.equal(board.highest, '熱心 20次');

    env.db.prepare(`
      INSERT INTO ratings (post_id, rater_id, ratee_id, stars, created_at)
      VALUES (?, ?, ?, 5, '2026-02-01T00:00:00.000Z')
    `).run(settledIds[10], other.id, member.id);
    board = env.services.milestoneCounts(member.id);
    assert.equal(board.fives, 10);
    assert.equal(board.highest, '好評達人');
    assert.equal(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(member.id).merit, 100);
    assert.equal(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(member.id).quota, 100);
  } finally {
    env.close();
  }
});

test('結算金額不因徽章改變，個人頁列出還差幾次', async () => {
  const env = setup();
  const app = createApp({ db: env.db, sessionSecret: 'milestone-secret', cookieSecure: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const host = env.services.register('0912999811', '幫忙的人');
    const seeker = env.services.register('0912999812', '被幫的人');
    const post = env.services.createPost(host.id, {
      kind: 'offer', category: 'food', city: '臺北市', amount: 20, description: '一份便當', title: '里程便當',
    });
    env.services.acceptPost(post.id, seeker.id);
    env.services.submitValue(post.id, host.id, 20);
    env.services.submitValue(post.id, seeker.id, 30);
    const hostBalance = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(host.id);
    const seekerBalance = env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(seeker.id);
    assert.deepEqual(hostBalance, { merit: 120, quota: 120 });
    assert.deepEqual(seekerBalance, { merit: 80, quota: 120 });
    const ledger = env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;

    const hostProfile = env.services.getProfile(host.id);
    const seekerProfile = env.services.getProfile(seeker.id);
    assert.deepEqual(hostProfile.reputation.badges, ['伸出援手']);
    assert.deepEqual(seekerProfile.reputation.badges, []);
    assert.equal(hostProfile.milestones.completed, 1);
    assert.equal(seekerProfile.milestones.completed, 1);
    assert.equal(hostProfile.milestones.highest, '首次互助');
    assert.equal(seekerProfile.milestones.highest, '首次互助');
    assert.deepEqual(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(host.id), hostBalance);
    assert.deepEqual(env.db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(seeker.id), seekerBalance);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, ledger);

    const open = env.services.createPost(host.id, {
      kind: 'offer', category: 'food', city: '臺北市', amount: 10, description: '下一份便當', title: '下一份',
    });
    const listed = env.services.listOpenPosts();
    assert.equal(listed[0].author_badge, '首次互助');

    const page = await fetch(`${base}/users/${host.id}`);
    const html = await page.text();
    assert.match(html, /data-milestone="first"[^>]*data-earned="1"/);
    assert.match(html, /data-milestone="keen-5"[^>]*data-earned="0"/);
    assert.match(html, /還差 4次/);
    assert.match(html, /class="milestone is-locked"/);
    assert.match(html, /class="milestone is-earned"/);
    const detail = await fetch(`${base}/posts/${open.id}`);
    const detailHtml = await detail.text();
    assert.match(detailHtml, /class="mini-badge">首次互助/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    env.close();
  }
});
