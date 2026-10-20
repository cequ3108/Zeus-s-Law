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

const RATING_TAGS = ['準時', '親切', '溝通清楚', '份量實在', '守約', '乾淨整潔'];

const MEETING_MODES = [
  '超商',
  '車站或捷運站',
  '公園或廣場',
  '公家機關或福利機構',
  '到府或上門',
  '線上或不需見面',
  '其他',
];

const PUBLIC_MEETING_MODES = [
  '超商',
  '車站或捷運站',
  '公園或廣場',
  '公家機關或福利機構',
];

const HOME_VISIT_MODE = '到府或上門';

const HOME_VISIT_NOTE = '建議第一次互助約在公共場所，也可以先看對方的信譽和評價。';

module.exports = {
  ROLES,
  KINDS,
  CATEGORIES,
  STATUSES,
  ENDOWMENTS,
  MAX_AMOUNT,
  RATING_TAGS,
  MEETING_MODES,
  PUBLIC_MEETING_MODES,
  HOME_VISIT_MODE,
  HOME_VISIT_NOTE,
};
