const ROLES = {
  user: '一般使用者',
  org: '福利機構',
  founder: '創辦人',
};

const KINDS = {
  offer: '我可以提供',
  need: '我需要',
};

const CATEGORIES = {
  food: '食物',
  transport: '交通',
  other: '其他',
};

const STATUSES = {
  open: '招募中',
  matched: '進行中',
  settled: '已結算',
  cancelled: '已取消',
};

const ENDOWMENTS = {
  user: { merit: 100, quota: 100 },
  org: { merit: 1_000_000, quota: 1_000_000 },
  founder: { merit: 100_000_000, quota: 100_000_000 },
};

const MAX_AMOUNT = 100_000_000;

module.exports = {
  ROLES,
  KINDS,
  CATEGORIES,
  STATUSES,
  ENDOWMENTS,
  MAX_AMOUNT,
};
