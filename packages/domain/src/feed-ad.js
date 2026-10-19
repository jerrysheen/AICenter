// 经营事实不是推销。「广告业」后面不接「务」时，不会落到「广告业务」这条例外里，所以单独排除。
const AD_TERMS = Object.freeze([
  '返佣', '拉群', '加群', '收费群', '课程招揽', '联盟返佣', '联盟营销',
  '优惠券', '立即购买', '点击购买', '加微信', '私信领取', '推广链接',
  'sponsored', 'affiliate', 'advertisement', 'promo code',
]);
// 这些词只用于自动点赞。信息流入库仍用上面的词表，避免挡住「招募说明书」「折价发行」。
const AUTO_LIKE_AD_TERMS = Object.freeze([
  '承接', '招募', '代投', '折扣', '打折', '优惠码',
]);
const AD_MARK = /广告(?!收入|营收|费|费用|支出|投放|业绩|业务|主|商|市场|业(?!务))/u;

export function looksLikeFeedAd(value, options = {}) {
  const strict = options === true || options?.strict === true;
  const hay = String(value || '');
  if (AD_MARK.test(hay)) return true;
  const lower = hay.toLowerCase();
  const terms = strict ? AD_TERMS.concat(AUTO_LIKE_AD_TERMS) : AD_TERMS;
  return terms.some((term) => lower.includes(term.toLowerCase()));
}
