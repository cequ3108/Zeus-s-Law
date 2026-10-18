const crypto = require('crypto');
const { AppError } = require('./errors');

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function cleanPassword(raw) {
  const password = String(raw ?? '');
  const length = [...password].length;
  if (length < 8 || length > 64) {
    throw new AppError('密碼請填 8 到 64 個字。');
  }
  return password;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'base64');
    expected = Buffer.from(parts[2], 'base64');
  } catch {
    return false;
  }
  if (!salt.length || expected.length !== 32) return false;
  const actual = crypto.scryptSync(String(password ?? ''), salt, 32, SCRYPT_OPTS);
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { cleanPassword, hashPassword, verifyPassword };
