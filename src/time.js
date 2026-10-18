function taipeiDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatTaipei(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function formatMerit(value) {
  return new Intl.NumberFormat('zh-TW').format(value);
}

function weekRange(date) {
  const ymd = taipeiDate(date);
  const [year, month, day] = ymd.split('-').map(Number);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    weekday: 'short',
  }).format(date);
  const offset = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday];
  const start = new Date(Date.UTC(year, month - 1, day - offset));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const stamp = (value) => value.toISOString().slice(0, 10);
  return { start: stamp(start), end: stamp(end) };
}

module.exports = { taipeiDate, formatTaipei, formatMerit, weekRange };
