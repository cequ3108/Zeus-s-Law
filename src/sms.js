const { AppError } = require('./errors');

// 簡訊只從這個檔案送出。
// 沒有設定 SMS_PROVIDER，或設成 dev：開發模式，不呼叫任何簡訊商，驗證碼改顯示在畫面上。
// 設成 every8d：呼叫 EVERY8D。帳密只讀環境變數，這裡沒有內建金鑰。

function isDevMode() {
  const provider = process.env.SMS_PROVIDER;
  return !provider || provider === 'dev';
}

async function sendOtp(mobile, code) {
  const message = `【宙斯法則】驗證碼 ${code}，10 分鐘內有效。請勿告知他人。`;
  const provider = process.env.SMS_PROVIDER;

  if (!provider || provider === 'dev') {
    console.info(`[開發模式簡訊] ${mobile} 的驗證碼顯示在登入頁，沒有送到簡訊商。`);
    return { mode: 'dev' };
  }

  if (provider === 'every8d') {
    await sendEvery8d(mobile, message);
    return { mode: 'every8d' };
  }

  throw new AppError('簡訊服務設定不正確。');
}

async function sendEvery8d(mobile, message) {
  const uid = process.env.EVERY8D_UID;
  const pwd = process.env.EVERY8D_PWD;
  if (!uid || !pwd) {
    throw new AppError('已指定 EVERY8D，但還沒有設定 EVERY8D_UID 或 EVERY8D_PWD。');
  }

  const url = process.env.EVERY8D_API_URL || 'https://api.e8d.tw/API21/HTTP/SendSMS.ashx';
  const body = new URLSearchParams({
    UID: uid,
    PWD: pwd,
    DEST: mobile,
    MSG: message,
    SB: '宙斯法則',
  });

  let response;
  let text;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    text = await response.text();
  } catch (err) {
    console.error('EVERY8D 連線失敗', err.message);
    throw new AppError('簡訊發送失敗，請稍後再試。');
  }

  const trimmed = text.trim();
  if (!response.ok || trimmed.startsWith('-')) {
    console.error('EVERY8D 發送失敗', response.status, trimmed.slice(0, 200));
    throw new AppError('簡訊發送失敗，請稍後再試。');
  }
}

module.exports = { sendOtp, isDevMode };
