(function () {
  if (!('serviceWorker' in navigator)) return;
  const src = document.currentScript && document.currentScript.dataset.sw;
  if (!src) return;
  navigator.serviceWorker.register(src, { scope: '/' }).catch(function () {});
})();
