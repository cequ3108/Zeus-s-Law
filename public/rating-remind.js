// 待評分提醒的「稍後再說」只存在這支瀏覽器，當天不再出現。
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    const start = () => api.mount(document);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(function () {
  const PREFIX = 'zeus-rating-remind:';

  function keyFor(userId, day) {
    return `${PREFIX}${userId}:${day}`;
  }

  function dismissed(storage, userId, day) {
    try {
      return storage.getItem(keyFor(userId, day)) === '1';
    } catch {
      return false;
    }
  }

  function dismiss(storage, userId, day) {
    try {
      storage.setItem(keyFor(userId, day), '1');
    } catch {
      /* 這支瀏覽器不讓存，這一頁仍可先收起 */
    }
  }

  function mount(document, storage) {
    const card = document.querySelector('[data-rating-remind]');
    if (!card) return;
    const store = storage || window.localStorage;
    const userId = card.getAttribute('data-remind-user');
    const day = card.getAttribute('data-remind-day');
    if (dismissed(store, userId, day)) {
      card.hidden = true;
      return;
    }
    const button = card.querySelector('[data-remind-dismiss]');
    if (!button) return;
    button.addEventListener('click', () => {
      dismiss(store, userId, day);
      card.hidden = true;
    });
  }

  return { keyFor, dismissed, dismiss, mount };
});
