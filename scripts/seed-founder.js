const path = require('path');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { AppError } = require('../src/errors');

const mobile = process.argv[2];
const displayName = process.argv[3] || '創辦人';

if (!mobile) {
  console.error('用法：npm run seed:founder -- 09xxxxxxxx 顯示名稱');
  process.exit(1);
}

const db = openDatabase(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'zeus.db'));
const services = createServices(db);

try {
  const user = services.seedFounder(mobile, displayName);
  console.log(`已把 ${user.mobile}（${user.display_name}）設為創辦人。`);
  console.log(`功德 ${user.merit}，功德額度 ${user.quota}。`);
  console.log('這不是公開註冊選項。請用這個手機號碼登入。開發模式會在畫面上顯示驗證碼。');
} catch (err) {
  if (err instanceof AppError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
} finally {
  db.close();
}
