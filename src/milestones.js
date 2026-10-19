// 由低到高。暱稱旁只顯示已經得到的最後一個。
const MILESTONES = [
  { id: 'first', label: '首次互助', metric: 'completed', need: 1, unit: '次', criterion: '完成 1 次互助。幫過或被幫過都算。' },
  { id: 'keen-5', label: '熱心 5次', metric: 'completed', need: 5, unit: '次', criterion: '完成 5 次互助。' },
  { id: 'keen-20', label: '熱心 20次', metric: 'completed', need: 20, unit: '次', criterion: '完成 20 次互助。' },
  { id: 'keen-50', label: '熱心 50次', metric: 'completed', need: 50, unit: '次', criterion: '完成 50 次互助。' },
  { id: 'praised', label: '好評達人', metric: 'fives', need: 10, unit: '則', criterion: '收到 10 則 5 星。' },
];

function milestoneBoard(completed, fives) {
  const counts = {
    completed: Number(completed) || 0,
    fives: Number(fives) || 0,
  };
  const badges = MILESTONES.map((badge) => {
    const current = counts[badge.metric];
    const earned = current >= badge.need;
    return {
      id: badge.id,
      label: badge.label,
      criterion: badge.criterion,
      unit: badge.unit,
      need: badge.need,
      current,
      earned,
      remaining: earned ? 0 : badge.need - current,
    };
  });
  const highest = badges.reduce((best, badge) => (badge.earned ? badge.label : best), '');
  return { completed: counts.completed, fives: counts.fives, badges, highest };
}

module.exports = { MILESTONES, milestoneBoard };
