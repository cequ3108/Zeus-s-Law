const path = require('path');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { isDevMode } = require('./sms');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('正式環境請設定 SESSION_SECRET。');
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'zeus.db');
const db = openDatabase(dbPath);
const app = createApp({ db });
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`宙斯法則 http://localhost:${port}`);
  if (isDevMode()) {
    console.log('簡訊是開發模式：驗證碼會顯示在畫面上，沒有呼叫簡訊商。');
  }
});
