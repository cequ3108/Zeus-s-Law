const { AppError } = require('./errors');

const CITIES = [
  '臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣',
  '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市',
  '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣',
];

function normalizeCity(raw, { required = true } = {}) {
  const text = String(raw || '').trim().replace(/台/g, '臺');
  if (!text) {
    if (!required) return null;
    throw new AppError('請選擇縣市。');
  }
  if (!CITIES.includes(text)) throw new AppError('請選擇縣市。');
  return text;
}

function cleanDistrict(raw) {
  const text = String(raw || '').replace(/[\u0000-\u001F]/g, '').trim().replace(/台/g, '臺');
  if (!text) return null;
  if ([...text].length > 20) throw new AppError('行政區請不要超過 20 個字。');
  return text;
}

module.exports = { CITIES, normalizeCity, cleanDistrict };
