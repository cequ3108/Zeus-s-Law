importScripts('__SW_POLICY__');

self.addEventListener('fetch', (event) => {
  if (!self.zeusSw.shouldHandle(event.request)) return;
  event.respondWith(networkOrOffline(event.request));
});

async function networkOrOffline(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(self.zeusSw.OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
