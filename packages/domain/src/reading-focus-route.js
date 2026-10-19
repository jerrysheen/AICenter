export const READING_ROUTE_VERSION = 'reading-route-2026-10-19.1';
export const READING_CLASS_VERSION = 'reading-class-2026-10-10.1';
export const INFORMATION_TYPES = ['capital_flow','macro','investment_method','technical_method','supply','operations','deal','capability','workflow','graphics','trade_control','conflict','index_move','product_progress'];
const TYPE_ALIAS_VERSION = 'type-alias-2026-10-09.1';

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function factText(facts) { return (facts || []).map((fact) => typeof fact === 'string' ? fact : fact?.text || '').join('\n'); }

export function normalizeReadingSemantics({domainTagIds = [], informationTypes = [], entities = [], facts = [], uncertainties = [], catalogIds}) {
  const aliases = [];
  const invalidTypes = [];
  const invalidDomains = unique(domainTagIds).filter((id) => !catalogIds.has(id) && id !== 'trading_method');
  const domains = unique(domainTagIds).filter((id) => catalogIds.has(id) || id === 'trading_method');
  let types = [];
  for (const raw of unique(informationTypes)) {
    if (INFORMATION_TYPES.includes(raw)) { types.push(raw); continue; }
    if (raw === 'corporate_results') { types.push('operations'); aliases.push({from: raw, to: 'operations', rule: TYPE_ALIAS_VERSION}); continue; }
    if (raw === 'method') {
      const investment = domains.some((id) => id === 'trading_method' || id.startsWith('market_'));
      const to = investment ? 'investment_method' : 'technical_method';
      types.push(to); aliases.push({from: raw, to, rule: TYPE_ALIAS_VERSION}); continue;
    }
    invalidTypes.push(raw);
  }
  const text = factText(facts);
  const companyResult = types.includes('operations') || types.includes('deal') || types.includes('supply');
  const priceMove = /下跌|上涨|涨跌|指数|股价|板块/.test(text);
  if (!companyResult && priceMove && invalidTypes.some((id) => id.startsWith('market_'))) {
    for (const id of invalidTypes.filter((id) => id.startsWith('market_'))) aliases.push({from: id, to: 'index_move', rule: 'price-move-is-index'});
    if (!types.includes('index_move')) types.push('index_move');
  }
  if (types.includes('macro') && /融资余额|两融余额/.test(text) && !/利率|CPI|GDP|汇率|国债收益率|黄金/.test(text)) {
    types = types.filter((type) => type !== 'macro');
    types.push('capital_flow');
    aliases.push({from: 'macro', to: 'capital_flow', rule: 'margin-balance-is-not-macro'});
  }
  return {domainTagIds: domains, invalidDomains, informationTypes: unique(types), invalidTypes, aliases, partial: invalidTypes.length > 0 || invalidDomains.length > 0, entities, facts, uncertainties};
}

const DIRECTION_NAMES = {finance: '金融', industry: '产业个股', ai: '科技与AI', geopolitics: '地缘政治', other: '待分类', pending: '待分类'};
export const READING_DIRECTIONS = ['finance','industry','ai','geopolitics'].map((id) => ({id, name: DIRECTION_NAMES[id]}));
export const READING_THEME_ORDER = READING_DIRECTIONS.map((item) => item.id);
export const FOCUS_QUESTIONS = {
  FIN_POLICY: '材料的主要内容是否是宏观经济数据、财政税收、货币政策或整体金融制度，并提供具体指标、措施、适用范围、时间或明确政策表态中的至少一项？',
  FIN_MARKET: '材料的主要内容是否是整体股票市场、指数、板块整体、ETF及市场级资金、债券利率、汇率、商品或期货行情，或公司融资、资本开支、算力需求、产能或订单在给出具体金额、规模或条件后会影响这些市场？并提供具体价格、涨跌、成交、资金、结构变化、金额或有依据的关系分析？',
  CO_EVENT: '材料是否以可识别的具体公司为主要对象，提供其营收、利润、应收、订单、客户认证、供应生产、业务或产品举措、资本开支、并购融资、人事、监管诉讼、事故或其他具体公司动态中的至少一项？',
  CO_MARKET: '材料是否以某家或几家可识别公司的证券表现为主要对象，提供具体股价、涨跌、估值、成交、公司级资金或持仓变化，或具体解释与比较？',
  AI_TECH: '材料是否主要介绍AI模型、算法、论文、数据集、训练推理或AI运行技术，并提供具体新增能力、机制、性能、评测、训练部署条件、限制或可用性变化中的至少一项？',
  AI_USE: '材料是否主要介绍AI应用、AI相关开源仓库、Agent、AI接口或自动化工作流，并能辨认它解决什么问题、怎样使用、有什么功能、价格额度或限制中的至少一项？',
  GEO_SECURITY: '材料是否以战争安全、军事行动、外交谈判、国家关系或国际政治进程为主要内容，并提供具体行动、条件、部署、决定、结果或有依据的分析？',
  GEO_RULES: '材料是否主要介绍跨国关税、制裁、出口管制、技术或资源准入、跨境运输限制，并提供具体措施、对象、范围、时间或执行变化？',
};
export const FOCUS_GROUP_NAMES = {
  FIN_POLICY: '宏观与财政货币', FIN_MARKET: '整体市场与资产行情',
  CO_EVENT: '公司事件与经营', CO_MARKET: '个股与公司证券表现',
  AI_TECH: '模型与技术进展', AI_USE: '应用、项目与工作流',
  GEO_SECURITY: '战争、外交与国际政治', GEO_RULES: '跨国贸易与限制措施',
};
export const FOCUS_GROUP_ORDER = Object.keys(FOCUS_GROUP_NAMES);

const QUESTION_BY_KIND = {
  macro_policy: ['FIN_POLICY'],
  market_asset: ['FIN_MARKET', 'CO_EVENT'],
  company_event: ['CO_EVENT', 'FIN_MARKET'],
  company_security: ['CO_MARKET'],
  ai_model_method: ['AI_TECH'],
  ai_application: ['AI_USE'],
  geopolitics_event: ['GEO_SECURITY'],
  geopolitics_rules: ['GEO_RULES'],
};
const DIRECTION_BY_KIND = {
  macro_policy: 'finance', market_asset: 'finance',
  company_event: 'industry', company_security: 'industry',
  ai_model_method: 'ai', ai_application: 'ai',
  geopolitics_event: 'geopolitics', geopolitics_rules: 'geopolitics',
};

const CLASS_PREFIX = {finance: 'FIN', industry: 'CO', ai: 'AI', geopolitics: 'GEO'};

export function classifyReading({primaryDirection, subjectKind, classificationStatus} = {}) {
  if (classificationStatus === 'failed') return {direction: 'pending', subjectKind: 'unknown', status: 'failed', questions: []};
  if (classificationStatus === 'budget-deferred') return {direction: 'pending', subjectKind: 'unknown', status: 'budget-deferred', questions: []};
  if (classificationStatus === 'invalid-output') return {direction: 'pending', subjectKind: 'unknown', status: 'invalid-output', questions: []};
  if (classificationStatus === 'pending' || primaryDirection === 'pending') return {direction: 'pending', subjectKind: 'unknown', status: 'pending', questions: []};
  if (!['finance','industry','ai','geopolitics','other'].includes(primaryDirection)) return {direction: 'pending', subjectKind: 'unknown', status: 'missing', questions: []};
  if (primaryDirection === 'other' || classificationStatus === 'out-of-scope') return {direction: 'other', subjectKind: subjectKind || 'other', status: 'out-of-scope', questions: []};
  const prefix = CLASS_PREFIX[primaryDirection];
  const mapped = QUESTION_BY_KIND[subjectKind];
  const questions = mapped && mapped[0].startsWith(prefix) ? mapped : FOCUS_GROUP_ORDER.filter((id) => id.startsWith(prefix));
  return {direction: primaryDirection, subjectKind: mapped && mapped[0].startsWith(prefix) ? subjectKind : 'unknown', status: 'classified', questions};
}

export function routeReadingFocus(input = {}) {
  const classified = classifyReading(input);
  return {groupIds: classified.questions, reasons: [{groupId: classified.questions[0] || null, reason: classified.subjectKind}], routed: classified.questions.length > 0, routeVersion: READING_ROUTE_VERSION, ...classified};
}

const REGION_RULES = [
  ['中国', /中国|A股|沪指|深成指|创业板|人民币|恒生|港股|国务院|两市|融资余额|紫金|招联/],
  ['美国', /美国|美股|纳指|标普|道琼斯|美联储|华尔街|OpenAI|SpaceX|Lumentum/],
  ['欧洲', /欧洲|欧元|欧股|英国|德国|法国|欧盟/],
  ['日本', /日本|日经|东京|日元|软银/],
  ['韩国', /韩国|三星|海力士/],
];

export function readingRegion(text = '') {
  const found = REGION_RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (found.length > 1) return '多地';
  return found[0] || '其他';
}

export function readingSlice(classified, text) {
  if (classified.direction === 'ai') return classified.subjectKind === 'ai_model_method' ? '模型与技术' : classified.subjectKind === 'ai_application' ? '应用与工作流' : '';
  if (classified.direction === 'geopolitics') return classified.subjectKind === 'geopolitics_rules' ? '贸易与限制' : classified.direction === 'geopolitics' ? '安全与外交' : '';
  if (classified.direction !== 'finance' && classified.direction !== 'industry') return '';
  return readingRegion(text);
}

export function readingPlacement(input = {}) {
  const classified = classifyReading(input);
  const direction = classified.direction === 'pending' ? 'other' : classified.direction;
  const slice = readingSlice(classified, input.title || '');
  return {
    readingDirectionId: direction,
    readingDirectionName: DIRECTION_NAMES[direction] || '待分类',
    readingThemeId: slice || direction,
    readingThemeName: slice,
    subjectKind: classified.subjectKind,
    classificationStatus: classified.status,
  };
}
