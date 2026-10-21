const { openDatabase, resolveDbPath } = require('../src/db');
const { createServices } = require('../src/services');
const { AppError } = require('../src/errors');

const DEMO = [
  { mobile: '0918000001', name: '阿明', password: 'demo-aming-1', city: '臺北市', district: '大安區', availability: '今天 14:00–18:00 可以' },
  { mobile: '0918000002', name: '阿花', password: 'demo-ahua-2', city: '臺北市', district: '中正區', availability: '今晚七點後有空' },
];

function ensureDemoUser(services, spec) {
  const existing = services.findByMobile(spec.mobile);
  if (existing) return existing;
  return services.registerWithPassword(spec.mobile, spec.name, spec.password, spec.password);
}

function seedDemo(db) {
  const services = createServices(db);
  const ming = ensureDemoUser(services, DEMO[0]);
  const hua = ensureDemoUser(services, DEMO[1]);
  services.updateAccountPlace(ming.id, { city: DEMO[0].city, district: DEMO[0].district });
  services.updateAvailability(ming.id, DEMO[0].availability);
  services.updateAccountPlace(hua.id, { city: DEMO[1].city, district: DEMO[1].district });
  services.updateAvailability(hua.id, DEMO[1].availability);

  const settledMarker = '示範結算：公館便當';
  if (!db.prepare('SELECT id FROM posts WHERE description = ?').get(settledMarker)) {
    const post = services.createPost(ming.id, {
      kind: 'need',
      category: 'food',
      title: '需要一份便當',
      city: '臺北市',
      district: '大安區',
      amount: 40,
      description: settledMarker,
      meeting_place: '公館捷運站',
      meeting_time: '今晚七點',
      expires_hours: 72,
    });
    services.acceptPost(post.id, hua.id);
    services.submitValue(post.id, hua.id, 50);
    services.submitValue(post.id, ming.id, 30);
    services.rate(post.id, ming.id, 5, '示範備註不顯示');
    services.rate(post.id, hua.id, 4, '另一則不顯示');
  }

  const openMarker = '示範招募：週六下午可以共乘到公館';
  if (!db.prepare('SELECT id FROM posts WHERE description = ?').get(openMarker)) {
    services.createPost(hua.id, {
      kind: 'offer',
      category: 'transport',
      title: '可以共乘一段',
      city: '臺北市',
      district: '中正區',
      amount: 80,
      description: openMarker,
      meeting_place: '台大捷運站',
      meeting_time: '週六下午',
    });
  }

  const southMarker = '示範招募：高雄晚間需要代買';
  if (!db.prepare('SELECT id FROM posts WHERE description = ?').get(southMarker)) {
    services.createPost(ming.id, {
      kind: 'need',
      category: 'other',
      title: '需要代買',
      city: '高雄市',
      amount: 40,
      description: southMarker,
    });
  }

  return {
    ming: services.findByMobile(DEMO[0].mobile),
    hua: services.findByMobile(DEMO[1].mobile),
  };
}

if (require.main === module) {
  const db = openDatabase(resolveDbPath());
  try {
    const result = seedDemo(db);
    console.log(`示範帳號 ${result.ming.mobile}（${result.ming.display_name}）密碼 demo-aming-1。`);
    console.log(`示範帳號 ${result.hua.mobile}（${result.hua.display_name}）密碼 demo-ahua-2。`);
    console.log('再執行一次不會重算已結算的示範互助，也不會變動餘額。');
    console.log('創辦人請用 FOUNDER_PHONE 與 FOUNDER_PASSWORD，這個指令不會建立創辦人。');
  } catch (err) {
    if (err instanceof AppError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  } finally {
    db.close();
  }
}

module.exports = { seedDemo, DEMO };
