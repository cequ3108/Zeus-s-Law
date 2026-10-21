const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { taipeiDate } = require('../src/time');

function setup(iso = '2026-10-03T02:00:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-'));
  const db = openDatabase(path.join(dir, 't.db'));
  let current = new Date(iso);
  const services = createServices(db, { now: () => new Date(current) });
  return {
    db,
    services,
    setNow(value) { current = new Date(value); },
    balances(id) {
      return db.prepare('SELECT merit, quota, role, blocked FROM users WHERE id = ?').get(id);
    },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function post(services, authorId, overrides = {}) {
  return services.createPost(authorId, {
    kind: 'need',
    category: 'food',
    description: '需要一份便當',
    amount: 40,
    city: '臺北市',
    ...overrides,
  });
}

test('台北日期以 16:00 UTC 換日', () => {
  assert.equal(taipeiDate(new Date('2026-10-03T15:59:00Z')), '2026-10-03');
  assert.equal(taipeiDate(new Date('2026-10-03T16:00:00Z')), '2026-10-04');
});

test('新的一般使用者是 100 功德與 100 額度', () => {
  const env = setup();
  try {
    const user = env.services.register('0912000001', '阿明');
    assert.equal(user.role, 'user');
    assert.equal(user.merit, 100);
    assert.equal(user.quota, 100);
  } finally {
    env.close();
  }
});

test('100 功德不能接標示 200 或剛好 100 的貼文', () => {
  const env = setup();
  try {
    const payer = env.services.register('0912000101', '付的人');
    const host = env.services.register('0912000102', '幫的人');
    const expensive = post(env.services, host.id, { kind: 'offer', amount: 200, description: '可以載一段路' });
    assert.throws(() => env.services.acceptPost(expensive.id, payer.id), /大於 0/);

    const exact = post(env.services, host.id, { kind: 'offer', amount: 100, description: '可以載短一點' });
    assert.throws(() => env.services.acceptPost(exact.id, payer.id), /大於 0/);
    assert.deepEqual(env.balances(payer.id), { merit: 100, quota: 100, role: 'user', blocked: 0 });

    const affordable = post(env.services, host.id, { kind: 'offer', amount: 99, description: '短程接送' });
    env.services.acceptPost(affordable.id, payer.id);
    const matched = env.db.prepare('SELECT status, seeker_id, host_id FROM posts WHERE id = ?').get(affordable.id);
    assert.equal(matched.status, 'matched');
    assert.equal(matched.seeker_id, payer.id);
    assert.equal(matched.host_id, host.id);
  } finally {
    env.close();
  }
});

test('需要貼文由發布者付功德，功德不夠就不能被配對', () => {
  const env = setup();
  try {
    const seeker = env.services.register('0912000201', '需要的人');
    const helper = env.services.register('0912000202', '幫手');
    const tooMuch = post(env.services, seeker.id, { amount: 100, description: '需要搬運' });
    assert.throws(() => env.services.acceptPost(tooMuch.id, helper.id), /大於 0/);
    const ok = post(env.services, seeker.id, { amount: 40, description: '需要一個便當' });
    env.services.acceptPost(ok.id, helper.id);
    const row = env.db.prepare('SELECT seeker_id, host_id FROM posts WHERE id = ?').get(ok.id);
    assert.equal(row.seeker_id, seeker.id);
    assert.equal(row.host_id, helper.id);
  } finally {
    env.close();
  }
});

test('結算取較低者，雙方額度增加，功德由接受幫助的人轉給提供幫助的人', () => {
  const env = setup();
  try {
    const seeker = env.services.register('0912000301', '阿明');
    const host = env.services.register('0912000302', '阿花');
    const item = post(env.services, seeker.id, { amount: 40, description: '午餐便當' });
    env.services.acceptPost(item.id, host.id);
    assert.equal(env.services.submitValue(item.id, seeker.id, 80).status, 'waiting');
    const done = env.services.submitValue(item.id, host.id, 50);
    assert.equal(done.status, 'settled');
    assert.equal(done.amount, 50);
    assert.deepEqual(env.balances(seeker.id), { merit: 50, quota: 150, role: 'user', blocked: 0 });
    assert.deepEqual(env.balances(host.id), { merit: 150, quota: 150, role: 'user', blocked: 0 });
    const bad = env.db.prepare('SELECT COUNT(*) AS n FROM users WHERE merit < 0 OR merit > quota').get().n;
    assert.equal(bad, 0);
  } finally {
    env.close();
  }
});

test('任一方填 0，結算就是 0，而且用掉當天的額度', () => {
  const env = setup();
  try {
    const seeker = env.services.register('0912000401', '甲');
    const host = env.services.register('0912000402', '乙');
    const item = post(env.services, seeker.id, { kind: 'offer', amount: 20, description: '可以送一趟' });
    env.services.acceptPost(item.id, host.id);
    const done = env.services.submitValue(item.id, seeker.id, 0);
    assert.equal(env.services.submitValue(item.id, host.id, 80).status, 'settled');
    assert.equal(done.status, 'waiting');
    const settled = env.db.prepare('SELECT settled_amount FROM posts WHERE id = ?').get(item.id);
    assert.equal(settled.settled_amount, 0);
    assert.deepEqual(env.balances(seeker.id), { merit: 100, quota: 100, role: 'user', blocked: 0 });
    assert.deepEqual(env.balances(host.id), { merit: 100, quota: 100, role: 'user', blocked: 0 });

    const again = post(env.services, seeker.id, { kind: 'offer', amount: 10, description: '再送一趟' });
    env.services.acceptPost(again.id, host.id);
    env.services.submitValue(again.id, seeker.id, 10);
    const blocked = env.services.submitValue(again.id, host.id, 10);
    assert.equal(blocked.status, 'daily');
    assert.match(blocked.message, /已經結算過一次/);
    assert.equal(env.balances(seeker.id).quota, 100);
  } finally {
    env.close();
  }
});

test('同一對帳號隔日可以再結算，額度會再增加；同一天跟另一個人可以', () => {
  const env = setup('2026-10-03T02:00:00.000Z');
  try {
    const a = env.services.register('0912000501', '甲');
    const b = env.services.register('0912000502', '乙');
    const c = env.services.register('0912000503', '丙');

    const first = post(env.services, a.id, { amount: 20, description: '第一餐' });
    env.services.acceptPost(first.id, b.id);
    env.services.submitValue(first.id, a.id, 12);
    assert.equal(env.services.submitValue(first.id, b.id, 18).amount, 12);

    const withC = post(env.services, a.id, { amount: 15, description: '給另一個人' });
    env.services.acceptPost(withC.id, c.id);
    env.services.submitValue(withC.id, a.id, 10);
    const sameDayOtherPair = env.services.submitValue(withC.id, c.id, 10);
    assert.equal(sameDayOtherPair.status, 'settled');
    assert.equal(sameDayOtherPair.amount, 10);

    const second = post(env.services, a.id, { amount: 15, description: '同一天第二餐' });
    env.services.acceptPost(second.id, b.id);
    env.services.submitValue(second.id, a.id, 9);
    assert.equal(env.services.submitValue(second.id, b.id, 9).status, 'daily');
    assert.equal(env.balances(a.id).merit, 100 - 12 - 10);
    assert.equal(env.balances(a.id).quota, 100 + 12 + 10);
    assert.equal(env.balances(b.id).merit, 112);
    assert.equal(env.balances(b.id).quota, 112);

    env.setNow('2026-10-03T16:30:00.000Z');
    const nextDay = env.services.retrySettle(second.id, a.id);
    assert.equal(nextDay.status, 'settled');
    assert.equal(nextDay.amount, 9);
    assert.equal(nextDay.date, '2026-10-04');
    assert.equal(env.balances(a.id).quota, 100 + 12 + 10 + 9);
    assert.equal(env.balances(b.id).quota, 112 + 9);
    assert.equal(env.balances(a.id).merit, 100 - 12 - 10 - 9);
    assert.equal(env.balances(b.id).merit, 112 + 9);
  } finally {
    env.close();
  }
});

test('結算超過付出方的功德時不會變成負數', () => {
  const env = setup();
  try {
    const seeker = env.services.register('0912000601', '甲');
    const host = env.services.register('0912000602', '乙');
    const item = post(env.services, seeker.id, { amount: 40, description: '一頓飯' });
    env.services.acceptPost(item.id, host.id);
    env.services.submitValue(item.id, seeker.id, 150);
    const failed = env.services.submitValue(item.id, host.id, 150);
    assert.equal(failed.status, 'insufficient');
    assert.equal(env.balances(seeker.id).merit, 100);
    assert.equal(env.db.prepare('SELECT status FROM posts WHERE id = ?').get(item.id).status, 'matched');

    const done = env.services.submitValue(item.id, seeker.id, 20);
    assert.equal(done.status, 'settled');
    assert.equal(done.amount, 20);
    assert.equal(env.balances(seeker.id).merit, 80);
  } finally {
    env.close();
  }
});

test('福利機構與創辦人可以付功德給幫手', () => {
  const env = setup();
  try {
    const founder = env.services.seedFounder('0912000701', '創辦人');
    assert.equal(founder.role, 'founder');
    assert.equal(founder.merit, 100_000_000);
    assert.equal(founder.quota, 100_000_000);

    const org = env.services.createOrg(founder.id, '0912000702', '食物銀行').user;
    assert.equal(org.role, 'org');
    assert.equal(org.merit, 1_000_000);
    assert.equal(org.quota, 1_000_000);
    assert.throws(
      () => post(env.services, org.id, { kind: 'offer', description: '機構不提供' }),
      /只能發布/
    );

    const helper = env.services.register('0912000703', '幫手');
    const need = post(env.services, org.id, { amount: 500, description: '發放便當需要人手' });
    env.services.acceptPost(need.id, helper.id);
    env.services.submitValue(need.id, org.id, 400);
    const done = env.services.submitValue(need.id, helper.id, 250);
    assert.equal(done.amount, 250);
    assert.equal(env.balances(org.id).merit, 1_000_000 - 250);
    assert.equal(env.balances(org.id).quota, 1_000_000 + 250);
    assert.equal(env.balances(helper.id).merit, 350);
    assert.equal(env.balances(helper.id).quota, 350);

    const founderNeed = post(env.services, founder.id, { amount: 10000, description: '需要接送物資' });
    const helperTwo = env.services.register('0912000704', '司機');
    env.services.acceptPost(founderNeed.id, helperTwo.id);
    env.services.submitValue(founderNeed.id, founder.id, 8000);
    const paid = env.services.submitValue(founderNeed.id, helperTwo.id, 9000);
    assert.equal(paid.amount, 8000);
    assert.equal(env.balances(founder.id).merit, 100_000_000 - 8000);
    assert.equal(env.balances(helperTwo.id).merit, 100 + 8000);

    env.services.seedFounder('0912000701', '另一個名字');
    assert.equal(env.balances(founder.id).merit, 100_000_000 - 8000);
    assert.equal(env.services.findByMobile('0912000701').display_name, '創辦人');
  } finally {
    env.close();
  }
});

test('機構功德不夠就不能完成結算', () => {
  const env = setup();
  try {
    const founder = env.services.seedFounder('0912000801', '創辦人');
    const org = env.services.createOrg(founder.id, '0912000802', '小機構').user;
    env.db.prepare('UPDATE users SET merit = 20 WHERE id = ?').run(org.id);
    const helper = env.services.register('0912000803', '幫手');
    const need = post(env.services, org.id, { amount: 10, description: '需要搬一箱' });
    env.services.acceptPost(need.id, helper.id);
    env.services.submitValue(need.id, org.id, 30);
    const failed = env.services.submitValue(need.id, helper.id, 30);
    assert.equal(failed.status, 'insufficient');
    assert.match(failed.message, /福利機構/);
    assert.equal(env.balances(org.id).merit, 20);
    assert.equal(env.balances(helper.id).merit, 100);

    const done = env.services.submitValue(need.id, helper.id, 15);
    assert.equal(done.amount, 15);
    assert.equal(env.balances(org.id).merit, 5);
    assert.equal(env.balances(helper.id).merit, 115);
    assert.ok(env.balances(helper.id).merit <= env.balances(helper.id).quota);
    assert.ok(env.balances(org.id).merit <= env.balances(org.id).quota);
  } finally {
    env.close();
  }
});

test('星等會留下，備註只進資料庫', () => {
  const env = setup();
  try {
    const a = env.services.register('0912000901', '甲');
    const b = env.services.register('0912000902', '乙');
    const item = post(env.services, a.id, { amount: 10, description: '一瓶水' });
    env.services.acceptPost(item.id, b.id);
    env.services.submitValue(item.id, a.id, 10);
    env.services.submitValue(item.id, b.id, 10);
    env.services.rate(item.id, a.id, 5, '秘密評語MARKER');
    env.services.rate(item.id, b.id, 4, '另一段不該出現的話');
    const stored = env.db.prepare('SELECT comment FROM ratings ORDER BY id').all();
    assert.deepEqual(stored.map((row) => row.comment), ['秘密評語MARKER', '另一段不該出現的話']);

    const profile = env.services.getProfile(b.id);
    assert.equal(profile.ratingAvg, 5);
    assert.equal(profile.ratingCount, 1);
    assert.equal(Object.hasOwn(profile.ratings[0], 'comment'), false);
    assert.equal(JSON.stringify(profile).includes('MARKER'), false);
    const page = env.services.postPage(item.id, a.id);
    assert.equal(JSON.stringify(page).includes('MARKER'), false);
    assert.equal(page.myStars, 5);
  } finally {
    env.close();
  }
});

test('封鎖後不能發布或接下，創辦人可以審核機構', () => {
  const env = setup();
  try {
    const founder = env.services.seedFounder('0912001001', '創辦人');
    const user = env.services.register('0912001002', '阿明');
    env.services.applyOrg(user.id, '社區食物站');
    assert.throws(() => env.services.approveApplication(user.id, 1), /只有創辦人/);
    const approved = env.services.approveApplication(founder.id, 1);
    assert.equal(approved.role, 'org');
    assert.equal(approved.display_name, '社區食物站');
    assert.equal(approved.merit, 1_000_000);
    assert.equal(approved.quota, 1_000_000);

    const other = env.services.register('0912001003', '路人');
    env.services.blockUser(founder.id, other.mobile, '收取現金');
    assert.throws(() => post(env.services, other.id, { description: '我想幫忙' }), /封鎖/);
    const open = post(env.services, founder.id, { amount: 10, description: '需要一個幫手' });
    assert.throws(() => env.services.acceptPost(open.id, other.id), /封鎖/);
    env.services.unblockUser(founder.id, other.mobile);
    env.services.acceptPost(open.id, other.id);
  } finally {
    env.close();
  }
});

test('升成機構不會把已經更高的餘額調低', () => {
  const env = setup();
  try {
    const founder = env.services.seedFounder('0912001101', '創辦人');
    const user = env.services.register('0912001102', '老志工');
    env.db.prepare('UPDATE users SET merit = 2000000, quota = 2000000 WHERE id = ?').run(user.id);
    const result = env.services.createOrg(founder.id, user.mobile, '大機構');
    assert.equal(result.user.role, 'org');
    assert.equal(result.user.merit, 2_000_000);
    assert.equal(result.user.quota, 2_000_000);
    assert.equal(result.user.display_name, '大機構');
  } finally {
    env.close();
  }
});

test('沒有金鑰的 EVERY8D 不會退回開發驗證碼', async () => {
  const previousProvider = process.env.SMS_PROVIDER;
  const previousUid = process.env.EVERY8D_UID;
  const previousPwd = process.env.EVERY8D_PWD;
  delete process.env.EVERY8D_UID;
  delete process.env.EVERY8D_PWD;
  process.env.SMS_PROVIDER = 'every8d';
  const env = setup();
  try {
    await assert.rejects(() => env.services.requestOtp('0912001201'), /EVERY8D_UID/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n, 0);
  } finally {
    if (previousProvider === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = previousProvider;
    if (previousUid === undefined) delete process.env.EVERY8D_UID;
    else process.env.EVERY8D_UID = previousUid;
    if (previousPwd === undefined) delete process.env.EVERY8D_PWD;
    else process.env.EVERY8D_PWD = previousPwd;
    env.close();
  }
});

test('開發模式驗證碼可以登入，錯誤的碼不行', async () => {
  const env = setup();
  try {
    const sent = await env.services.requestOtp('0912001301');
    assert.match(sent.devCode, /^\d{6}$/);
    const wrong = sent.devCode === '111111' ? '222222' : '111111';
    assert.throws(() => env.services.verifyOtp(sent.mobile, wrong), /不正確或已過期/);
    const verified = env.services.verifyOtp(sent.mobile, sent.devCode);
    assert.equal(verified.user, null);
    assert.throws(() => env.services.verifyOtp(sent.mobile, sent.devCode), /不正確或已過期/);
  } finally {
    env.close();
  }
});
