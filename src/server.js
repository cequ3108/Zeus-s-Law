const { openDatabase, resolveDbPath } = require('./db');
const { createApp } = require('./app');
const { createServices } = require('./services');
const { isDevMode } = require('./sms');
const { AppError } = require('./errors');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('正式環境請設定 SESSION_SECRET。');
}

const dbPath = resolveDbPath();
const db = openDatabase(dbPath);
try {
  const founder = createServices(db).ensureFounderFromEnv(process.env);
  if (founder.status === 'created') {
    console.log(`已建立創辦人 ${founder.mobile}。功德與額度都是 100,000,000。密碼只存雜湊。`);
  } else if (founder.status === 'updated') {
    console.log(`已更新創辦人 ${founder.mobile} 的密碼雜湊。餘額沒有變動。`);
  } else if (founder.status === 'incomplete') {
    console.warn('FOUNDER_PHONE 與 FOUNDER_PASSWORD 要一起設定。創辦人帳號沒有建立。');
  } else if (founder.status === 'conflict') {
    console.warn(founder.message);
  }
} catch (err) {
  if (err instanceof AppError) console.warn(err.message);
  else throw err;
}
const app = createApp({ db });
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`宙斯法則 http://localhost:${port}`);
  if (isDevMode()) {
    console.log('簡訊是開發模式：驗證碼會顯示在畫面上，沒有呼叫簡訊商。');
  }
});
