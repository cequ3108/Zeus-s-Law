const TEMPLATES = [
  {
    id: 'bento',
    label: '便當',
    kind: 'need',
    category: 'food',
    title: '需要一份便當',
    description: '我想要一份便當。\n地點：\n時間：\n份數：',
    min: 60,
    max: 120,
  },
  {
    id: 'ride',
    label: '共乘',
    kind: 'offer',
    category: 'transport',
    title: '可以共乘一段',
    description: '我可以順路載人。\n起點：\n終點：\n時間：\n人數：',
    min: 50,
    max: 200,
  },
  {
    id: 'clinic',
    label: '陪看病',
    kind: 'need',
    category: 'other',
    title: '需要人陪去看病',
    description: '我想找人陪去看診。\n醫院：\n時間：\n大概多久：',
    min: 80,
    max: 200,
  },
  {
    id: 'errand',
    label: '代買',
    kind: 'need',
    category: 'other',
    title: '需要代買',
    description: '我想請人幫忙代買。\n買什麼：\n地點：\n時間：',
    min: 30,
    max: 100,
  },
];

function templatesFor(role) {
  return TEMPLATES.filter((item) => role !== 'org' || item.kind !== 'offer');
}

function findTemplate(id, role) {
  return templatesFor(role).find((item) => item.id === id) || null;
}

module.exports = { TEMPLATES, templatesFor, findTemplate };
