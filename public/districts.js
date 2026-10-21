// 鄉鎮市區選單跟著縣市走。沒選縣市時不能選。清單本身在頁面上，這裡只負責顯示對的那一組。
(function () {
  function remember(select) {
    if (select._districtOptions) return;
    select._districtOptions = Array.from(select.options).filter((option) => option.value);
  }

  function sync(citySelect, districtSelect) {
    if (!citySelect || !districtSelect) return;
    remember(districtSelect);
    const city = citySelect.value;
    const current = districtSelect.value;
    const blank = districtSelect.querySelector('option[value=""]');
    districtSelect.replaceChildren(blank);
    const enabled = Boolean(city) && city !== 'all';
    districtSelect.disabled = !enabled;
    if (!enabled) {
      districtSelect.value = '';
      return;
    }
    for (const option of districtSelect._districtOptions) {
      if (option.getAttribute('data-city') === city) districtSelect.appendChild(option);
    }
    const still = Array.from(districtSelect.options).some((option) => option.value === current);
    districtSelect.value = still ? current : '';
  }

  function mount(doc) {
    const pairs = [];
    doc.querySelectorAll('select[data-district-for]').forEach((districtSelect) => {
      const citySelect = doc.getElementById(districtSelect.getAttribute('data-district-for'));
      if (!citySelect) return;
      const run = () => sync(citySelect, districtSelect);
      citySelect.addEventListener('change', run);
      pairs.push(run);
    });
    function runAll() {
      pairs.forEach((run) => run());
    }
    runAll();
    const clearButton = doc.querySelector('[data-draft-clear]');
    if (clearButton) clearButton.addEventListener('click', runAll);
  }

  if (typeof document !== 'undefined') {
    const start = () => mount(document);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
