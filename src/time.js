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

const LAST_SEEN_INTERVAL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function lastSeenLabel(iso, now = new Date()) {
  if (!iso) return '';
  const seen = new Date(iso);
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(seen.getTime()) || Number.isNaN(current.getTime())) return '';
  if (taipeiDate(seen) === taipeiDate(current)) return '今天上線';
  const elapsed = current.getTime() - seen.getTime();
  if (elapsed < 0) return '今天上線';
  if (elapsed <= 3 * DAY_MS) return '3天內上線';
  if (elapsed <= 7 * DAY_MS) return '一週內上線';
  return '超過一週';
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

module.exports = {
  taipeiDate, formatTaipei, formatMerit, weekRange, lastSeenLabel, LAST_SEEN_INTERVAL_MS,
};
