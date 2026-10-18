const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { lineShareUrl } = require('../src/share');

test('配對後可以把對方稱呼與時間地點組成 LINE 分享', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-share-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db, { now: () => new Date('2026-10-03T02:00:00.000Z') });
  try {
    const author = services.register('0912500001', '阿明');
    const helper = services.register('0912500002', '阿花');
    const post = services.createPost(author.id, {
      kind: 'need',
      category: 'food',
      city: '臺北市',
      amount: 20,
      description: '便當',
      meeting_place: '公館捷運站',
      meeting_time: '週六下午',
    });
    services.acceptPost(post.id, helper.id);
    const page = services.postPage(post.id, author.id);
    assert.match(page.lineShare.text, /阿花/);
    assert.match(page.lineShare.text, /公館捷運站/);
    assert.match(page.lineShare.text, /週六下午/);
    assert.match(page.lineShare.text, /便利商店或捷運站/);
    assert.equal(page.lineShare.url, lineShareUrl(page.lineShare.text));
    assert.match(page.lineShare.url, /^https:\/\/line\.me\/R\/share\?text=/);
    assert.equal(services.postPage(post.id, null).lineShare, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
