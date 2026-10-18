import * as OpenCC from 'opencc-js';

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });

const AUTHORITY_ZH = new Map([
  ['u.s. bureau of labor statistics', '美国劳工统计局'],
  ['us bureau of labor statistics', '美国劳工统计局'],
  ['bureau of labor statistics', '美国劳工统计局'],
  ['u.s. bureau of economic analysis', '美国经济分析局'],
  ['us bureau of economic analysis', '美国经济分析局'],
  ['bureau of economic analysis', '美国经济分析局'],
  ['u.s. census bureau', '美国人口普查局'],
  ['us census bureau', '美国人口普查局'],
  ['census bureau', '美国人口普查局'],
  ['institute for supply management', '美国供应管理协会'],
  ['u.s. department of labor', '美国劳工部'],
  ['us department of labor', '美国劳工部'],
  ['department of labor', '美国劳工部'],
  ['labor department', '美国劳工部'],
  ['federal reserve board', '美联储理事会'],
  ['federal reserve system', '美联储'],
  ['federal open market committee', '联邦公开市场委员会'],
  ['federal register', '联邦公报'],
  ['the white house', '白宫'],
  ['white house', '白宫'],
  ['treasury department', '美国财政部'],
  ['department of the treasury', '美国财政部'],
  ['u.s. department of the treasury', '美国财政部'],
  ['commerce department', '美国商务部'],
  ['department of commerce', '美国商务部'],
  ['defense department', '美国国防部'],
  ['department of defense', '美国国防部'],
  ['state department', '美国国务院'],
  ['department of state', '美国国务院'],
  ['justice department', '美国司法部'],
  ['department of justice', '美国司法部'],
  ['interior department', '美国内政部'],
  ['department of the interior', '美国内政部'],
  ['agriculture department', '美国农业部'],
  ['department of agriculture', '美国农业部'],
  ['health and human services department', '美国卫生与公众服务部'],
  ['department of health and human services', '美国卫生与公众服务部'],
  ['transportation department', '美国交通部'],
  ['department of transportation', '美国交通部'],
  ['energy department', '美国能源部'],
  ['department of energy', '美国能源部'],
  ['education department', '美国教育部'],
  ['department of education', '美国教育部'],
  ['homeland security department', '美国国土安全部'],
  ['department of homeland security', '美国国土安全部'],
  ['housing and urban development department', '美国住房和城市发展部'],
  ['department of housing and urban development', '美国住房和城市发展部'],
  ['veterans affairs department', '美国退伍军人事务部'],
  ['department of veterans affairs', '美国退伍军人事务部'],
  ['environmental protection agency', '美国环境保护局'],
  ['securities and exchange commission', '美国证券交易委员会'],
  ['federal communications commission', '联邦通信委员会'],
  ['commodity futures trading commission', '商品期货交易委员会'],
  ['federal trade commission', '联邦贸易委员会'],
  ['internal revenue service', '美国国税局'],
  ['food and drug administration', '美国食品药品监督管理局'],
  ['federal deposit insurance corporation', '联邦存款保险公司'],
  ['consumer financial protection bureau', '消费者金融保护局'],
  ['small business administration', '小企业管理局'],
  ['social security administration', '社会保障局'],
  ['office of management and budget', '行政管理和预算局'],
  ['executive office of the president', '总统行政办公室'],
]);

function authorityKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '').toLowerCase();
}

export function localizeOfficialAuthority(value) {
  const parts = String(value || '').split(/\s*;\s*/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return '';
  let mapped = false;
  const names = parts.map((part) => {
    const chinese = AUTHORITY_ZH.get(authorityKey(part));
    if (chinese) {
      mapped = true;
      return chinese;
    }
    return part;
  });
  return mapped ? names.join('；') : parts.join('; ');
}

export function simplifyOfficialTitle(value) {
  const text = String(value || '').trim();
  if (!text) return text;
  return toSimplified(text);
}

export function localizeOfficialRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const next = { ...record };
  if (next.authority) next.authority = localizeOfficialAuthority(next.authority);
  if (next.title) next.title = simplifyOfficialTitle(next.title);
  return next;
}

export function localizeOfficialView(data) {
  if (!data || typeof data !== 'object') return data;
  const next = { ...data };
  if (Array.isArray(data.events)) next.events = data.events.map(localizeOfficialRecord);
  if (Array.isArray(data.releases)) next.releases = data.releases.map(localizeOfficialRecord);
  return next;
}

export function localizeOfficialBoard(board) {
  if (!board || typeof board !== 'object') return board;
  const next = { ...board };
  if (Array.isArray(board.upcoming)) next.upcoming = board.upcoming.map(localizeOfficialRecord);
  if (Array.isArray(board.releases)) next.releases = board.releases.map(localizeOfficialRecord);
  return next;
}
