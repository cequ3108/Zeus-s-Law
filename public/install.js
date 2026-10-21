(function () {
  const KEY = 'zeus-install-dismissed';
  const slot = document.querySelector('[data-install-prompt]');
  if (!slot) return;
  if (window.matchMedia('(display-mode: standalone)').matches) return;

  let dismissed = false;
  try {
    dismissed = localStorage.getItem(KEY) === '1';
  } catch {
    dismissed = false;
  }

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    if (dismissed) return;
    deferred = event;
    slot.hidden = false;
  });

  const button = slot.querySelector('[data-install-button]');
  if (!button) return;
  button.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    const choice = await deferred.userChoice;
    deferred = null;
    slot.hidden = true;
    if (!choice || choice.outcome !== 'dismissed') return;
    dismissed = true;
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* 記不住就下次再問 */
    }
  });
})();
