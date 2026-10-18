const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-rep-'));
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

function settle(services, postId, hostId, seekerId) {
  services.submitValue(postId, hostId, 10);
  services.submitValue(postId, seekerId, 10);
}

test('信譽計算幫過與被幫過，徽章不另外發功德', () => {
  const env = setup();
  try {
    const host = env.services.register('0912600001', '常幫忙的人');
    const people = [];
    for (let i = 0; i < 5; i += 1) {
      people.push(env.services.register(`091260000${i + 2}`, `夥伴${i}`));
    }
    assert.deepEqual(env.services.getProfile(host.id).reputation.badges, []);

    people.forEach((person) => {
      const offer = env.services.createPost(host.id, {
        kind: 'offer', category: 'transport', city: '臺北市', amount: 10, description: `載 ${person.display_name}`,
      });
      env.services.acceptPost(offer.id, person.id);
      settle(env.services, offer.id, host.id, person.id);
    });
    const helped = env.services.getProfile(host.id).reputation;
    assert.equal(helped.helped, 5);
    assert.equal(helped.helpedBy, 0);
    assert.deepEqual(helped.badges, ['伸出援手', '常幫忙']);

    const extra = env.services.register('0912600099', '另一位');
    const ask = env.services.createPost(host.id, {
      kind: 'need', category: 'food', city: '高雄市', amount: 10, description: '換一個縣市的便當',
    });
    env.services.acceptPost(ask.id, extra.id);
    settle(env.services, ask.id, extra.id, host.id);
    const both = env.services.getProfile(host.id).reputation;
    assert.equal(both.helpedBy, 1);
    assert.deepEqual(both.badges, ['伸出援手', '常幫忙', '互相往來']);
    assert.equal(env.db.prepare('SELECT merit FROM users WHERE id = ?').get(host.id).merit, 140);
  } finally {
    env.close();
  }
});
