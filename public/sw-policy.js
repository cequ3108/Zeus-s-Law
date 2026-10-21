(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.zeusSw = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>目前離線 · 宙斯法則</title>
  <style>
    body { margin: 0; background: #f3eadb; color: #241c15; font-family: "PingFang TC", "Noto Sans TC", sans-serif; }
    main { width: min(560px, calc(100% - 32px)); margin: 18vh auto; }
    h1 { font-size: 1.6rem; }
  </style>
</head>
<body>
  <main>
    <h1>目前離線，請連上網路再試</h1>
  </main>
</body>
</html>`;

  const SENSITIVE = [
    '/login',
    '/join',
    '/register',
    '/verify',
    '/forgot',
    '/logout',
    '/account',
    '/me',
    '/admin',
    '/org',
    '/posts/new',
  ];

  function isSensitive(pathname) {
    if (SENSITIVE.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return true;
    return /\/(settle|value|accept|rating|bookmark|hide|unhide|repost|cancel|report|merit|questions|extend|remove)(\/|$)/.test(pathname);
  }

  function shouldHandle(request) {
    if (!request || request.method !== 'GET') return false;
    if (request.mode !== 'navigate') return false;
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return false;
    }
    if (typeof self !== 'undefined' && self.location && url.origin !== self.location.origin) return false;
    const cookie = request.headers && typeof request.headers.get === 'function'
      ? (request.headers.get('cookie') || '')
      : '';
    if (/(?:^|;\s*)zeus\.sid=/.test(cookie)) return false;
    if (isSensitive(url.pathname)) return false;
    return true;
  }

  return { shouldHandle, OFFLINE_HTML, isSensitive };
});
