const { AppError } = require('./errors');

const SLOTS = ['平日白天', '平日晚上', '週末白天', '週末晚上'];

function tokens(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list
    .map((item) => String(item).replace(/[\u0000-\u001F]/g, '').trim())
    .filter(Boolean);
}

function parseSlots(raw) {
  const known = new Set(SLOTS);
  const found = new Set();
  for (const token of tokens(raw)) {
    if (known.has(token)) found.add(token);
  }
  return SLOTS.filter((slot) => found.has(slot));
}

function normalizeSlots(raw) {
  const list = tokens(raw);
  if (!list.length) return null;
  const known = new Set(SLOTS);
  for (const token of list) {
    if (!known.has(token)) throw new AppError('請選擇列出的方便時段。');
  }
  return parseSlots(list).join(',');
}

module.exports = { SLOTS, parseSlots, normalizeSlots };
