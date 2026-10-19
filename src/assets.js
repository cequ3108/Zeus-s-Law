const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const HASH_LENGTH = 12;
const THEME_COLOR = '#9d1c1c';
const BACKGROUND_COLOR = '#f3eadb';

function hashBuffer(body) {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, HASH_LENGTH);
}

function hashFile(name) {
  return hashBuffer(fs.readFileSync(path.join(publicDir, name)));
}

const versions = {
  '/styles.css': hashFile('styles.css'),
  '/favicon.svg': hashFile('favicon.svg'),
  '/draft.js': hashFile('draft.js'),
  '/icon-192.png': hashFile('icon-192.png'),
  '/icon-512.png': hashFile('icon-512.png'),
  '/icon-maskable-192.png': hashFile('icon-maskable-192.png'),
  '/icon-maskable-512.png': hashFile('icon-maskable-512.png'),
  '/apple-touch-icon.png': hashFile('apple-touch-icon.png'),
  '/pwa.js': hashFile('pwa.js'),
  '/install.js': hashFile('install.js'),
  '/large-text.js': hashFile('large-text.js'),
  '/sw-policy.js': hashFile('sw-policy.js'),
  '/offline.html': hashFile('offline.html'),
};

function asset(pathname) {
  const version = versions[pathname];
  if (!version) return pathname;
  return `${pathname}?v=${version}`;
}

const manifest = {
  name: '宙斯法則',
  short_name: '宙斯法則',
  lang: 'zh-Hant',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: THEME_COLOR,
  background_color: BACKGROUND_COLOR,
  icons: [
    { src: asset('/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: asset('/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: asset('/icon-maskable-192.png'), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: asset('/icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const manifestBody = `${JSON.stringify(manifest)}\n`;
versions['/manifest.webmanifest'] = hashBuffer(manifestBody);

const swBody = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8')
  .replace('__SW_POLICY__', asset('/sw-policy.js'));
versions['/sw.js'] = hashBuffer(swBody);

module.exports = {
  asset,
  versions,
  publicDir,
  manifest,
  manifestBody,
  swBody,
  THEME_COLOR,
  BACKGROUND_COLOR,
};
