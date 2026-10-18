const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');

test('今日空檔出現在個人頁與廣場，清空後就不見', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-avail-'));
  const db = openDatabase(path.join(dir, 't.db'));
  const services = createServices(db);
  try {
    const user = services.register('0912700001', '有空的人');
    services.updateAvailability(user.id, '今天 14:00–18:00');
    const post = services.createPost(user.id, {
      kind: 'offer', category: 'other', city: '臺北市', amount: 10, description: '可以陪一段',
    });
    assert.equal(services.getProfile(user.id).user.availability, '今天 14:00–18:00');
    assert.equal(services.listOpenPosts()[0].author_availability, '今天 14:00–18:00');
    assert.equal(services.postPage(post.id, null).author.availability, '今天 14:00–18:00');
    services.updateAvailability(user.id, '   ');
    assert.equal(services.getProfile(user.id).user.availability, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
