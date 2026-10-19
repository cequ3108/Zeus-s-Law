// 發文草稿只放在這支瀏覽器，依登入帳號分開。伺服器不存草稿。
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.ZeusDraft = api;
    const start = () => api.mount(document);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(function () {
  const PREFIX = 'zeus-post-draft:';
  const DELAY = 1000;
  const FIELDS = [
    'kind', 'category', 'title', 'city', 'district', 'amount',
    'meeting_place', 'meeting_time', 'expires_hours', 'description',
  ];
  const LIMITS = {
    kind: 10,
    category: 20,
    title: 40,
    city: 20,
    district: 20,
    amount: 12,
    meeting_place: 80,
    meeting_time: 80,
    expires_hours: 3,
    description: 1000,
  };

  function keyFor(userId) {
    return PREFIX + String(userId);
  }

  function save(storage, userId, values) {
    const payload = {};
    for (const name of FIELDS) {
      if (values[name] == null) continue;
      payload[name] = String(values[name]).slice(0, LIMITS[name]);
    }
    storage.setItem(keyFor(userId), JSON.stringify(payload));
  }

  function load(storage, userId) {
    let raw;
    try {
      raw = storage.getItem(keyFor(userId));
    } catch {
      return null;
    }
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const values = {};
    let any = false;
    for (const name of FIELDS) {
      if (parsed[name] == null) continue;
      values[name] = String(parsed[name]).slice(0, LIMITS[name]);
      any = true;
    }
    return any ? values : null;
  }

  function clear(storage, userId) {
    try {
      storage.removeItem(keyFor(userId));
    } catch {
      /* 瀏覽器拒寫時，表單仍可送出。 */
    }
  }

  function clearAll(storage) {
    const keys = [];
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && key.startsWith(PREFIX)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      /* 同上。 */
    }
  }

  function readField(element) {
    if (!element || typeof element.value !== 'string') return '';
    return element.value;
  }

  function writeField(element, value) {
    if (!element || element.type === 'hidden') return;
    if (typeof element.length === 'number' && element[0] && element[0].type === 'radio') {
      for (let i = 0; i < element.length; i += 1) element[i].checked = element[i].value === value;
      return;
    }
    if (element.type === 'radio') {
      element.checked = element.value === value;
      return;
    }
    element.value = value;
  }

  function readForm(form) {
    const values = {};
    for (const name of FIELDS) values[name] = readField(form.elements.namedItem(name));
    return values;
  }

  function writeForm(form, values) {
    for (const name of FIELDS) {
      if (values[name] == null) continue;
      writeField(form.elements.namedItem(name), values[name]);
    }
  }

  function mount(doc, options = {}) {
    const storage = options.storage || window.localStorage;
    const delay = options.delay == null ? DELAY : options.delay;
    const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = options.clearTimer || ((id) => clearTimeout(id));
    const flag = doc.body && doc.body.getAttribute('data-clear-draft');
    if (flag === 'all') clearAll(storage);
    else if (flag && /^[0-9]+$/.test(flag)) clear(storage, flag);

    const form = doc.querySelector('form[data-draft-user]');
    if (!form) return;
    const userId = form.getAttribute('data-draft-user');
    if (!/^[0-9]+$/.test(userId || '')) return;
    const notice = doc.querySelector('[data-draft-notice]');
    const clearButton = doc.querySelector('[data-draft-clear]');
    const initial = readForm(form);
    const draft = load(storage, userId);
    if (draft) {
      writeForm(form, draft);
      if (notice) notice.hidden = false;
    }

    let timer = 0;
    let waiting = false;
    let pending = null;
    function flush() {
      if (!pending) return;
      const values = pending;
      pending = null;
      try {
        save(storage, userId, values);
      } catch {
        /* 存不下就略過，下一頁仍可手動填。 */
      }
    }
    function schedule() {
      pending = readForm(form);
      if (waiting) clearTimer(timer);
      waiting = true;
      timer = setTimer(() => {
        waiting = false;
        flush();
      }, delay);
    }
    form.addEventListener('input', schedule);
    form.addEventListener('change', schedule);
    form.addEventListener('submit', () => {
      if (waiting) clearTimer(timer);
      waiting = false;
      flush();
    });
    const view = doc.defaultView;
    if (view && view.addEventListener) {
      view.addEventListener('pagehide', () => {
        if (waiting) clearTimer(timer);
        waiting = false;
        flush();
      });
    }
    if (clearButton) {
      clearButton.addEventListener('click', (event) => {
        event.preventDefault();
        if (waiting) clearTimer(timer);
        waiting = false;
        pending = null;
        clear(storage, userId);
        writeForm(form, initial);
        if (notice) notice.hidden = true;
      });
    }
  }

  return { PREFIX, DELAY, FIELDS, keyFor, save, load, clear, clearAll, readForm, writeForm, mount };
});
