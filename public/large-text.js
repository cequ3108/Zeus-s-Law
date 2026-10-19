// 大字模式只存在這支瀏覽器。預設關閉。
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    const start = () => api.mount(document);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(function () {
  const KEY = 'zeus-large-text';

  function read(storage) {
    try {
      return storage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  }

  function write(storage, on) {
    try {
      if (on) storage.setItem(KEY, '1');
      else storage.removeItem(KEY);
    } catch {
      /* 這支瀏覽器不讓存，這一頁仍可切換 */
    }
  }

  function apply(root, on) {
    root.classList.toggle('large-text', !!on);
  }

  function sync(button, on) {
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.classList.toggle('is-on', on);
    if (button.getAttribute('data-large-text') === 'label') {
      button.textContent = on ? '關閉大字模式' : '開啟大字模式';
    }
  }

  function mount(document, storage) {
    const store = storage || document.defaultView.localStorage;
    const root = document.documentElement;
    const buttons = [...document.querySelectorAll('[data-large-text]')];
    const paint = (on) => {
      apply(root, on);
      buttons.forEach((button) => sync(button, on));
    };
    paint(read(store));
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const next = !read(store);
        write(store, next);
        paint(next);
      });
    });
  }

  return { KEY, read, write, apply, mount };
});
