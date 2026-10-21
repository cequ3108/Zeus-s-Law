const { AppError } = require('./errors');

const CITIES = [
  '臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣',
  '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市',
  '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣',
];

const DISTRICTS = require('./districts.json');

function normalizeCity(raw, { required = true } = {}) {
  const text = String(raw || '').trim().replace(/台/g, '臺');
  if (!text) {
    if (!required) return null;
    throw new AppError('請選擇縣市。');
  }
  if (!CITIES.includes(text)) throw new AppError('請選擇縣市。');
  return text;
}

function districtsFor(city) {
  return DISTRICTS[city] ? DISTRICTS[city].slice() : [];
}

function normalizeDistrict(raw, city) {
  const text = String(raw || '').replace(/[\u0000-\u001F]/g, '').trim().replace(/台/g, '臺');
  if (!text) return null;
  if (!city) throw new AppError('要填鄉鎮市區，請先選擇縣市。');
  if (!districtsFor(city).includes(text)) throw new AppError('請選擇這個縣市裡的鄉鎮市區。');
  return text;
}

function placeLabel(city, district) {
  if (!city) return '';
  if (!district) return city;
  return `${city}・${district}`;
}

module.exports = { CITIES, DISTRICTS, districtsFor, normalizeCity, normalizeDistrict, placeLabel };
