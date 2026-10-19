const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const HASH_LENGTH = 12;

function hashFile(name) {
  const body = fs.readFileSync(path.join(publicDir, name));
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, HASH_LENGTH);
}

// 程序啟動時算一次。樣式改了要重啟，網址才會換，Cloudflare 才不會一直送舊檔。
const versions = {
  '/styles.css': hashFile('styles.css'),
  '/favicon.svg': hashFile('favicon.svg'),
  '/draft.js': hashFile('draft.js'),
};

function asset(pathname) {
  const version = versions[pathname];
  if (!version) return pathname;
  return `${pathname}?v=${version}`;
}

module.exports = { asset, versions, publicDir };
