function meetingShareText({ nickname, ratingAvg, ratingCount, place, time }) {
  const lines = [`我在宙斯法則跟「${nickname}」約好互助。`];
  if (ratingCount) lines.push(`星等 ${ratingAvg}（${ratingCount} 則）。`);
  else lines.push('對方還沒有星等。');
  if (time) lines.push(`時間：${time}`);
  if (place) lines.push(`地點：${place}`);
  lines.push('請約在便利商店或捷運站這種公共場所。');
  return lines.join('\n');
}

function lineShareUrl(text) {
  return `https://line.me/R/share?text=${encodeURIComponent(text)}`;
}

module.exports = { meetingShareText, lineShareUrl };
