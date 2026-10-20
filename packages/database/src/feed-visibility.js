function fallbackReasonSql(alias) {
  return `(json_extract(${alias}.metadata_json,'$.filterReason') LIKE 'fallback-%' OR json_extract(${alias}.metadata_json,'$.filterReason') LIKE 'jev-disabled-%')`;
}

function whenFilterReady(columnSql, jsonSql) {
  return `CASE WHEN c.feed_filter_ready = 1 THEN (${columnSql}) ELSE (${jsonSql}) END`;
}

function captureApprovedSql(rule = '') {
  if (!rule) return '1=1';
  if (rule !== 'all-three-0.60') throw new Error('Unsupported admission rule');
  return whenFilterReady(
    `c.filter_rule = 'all-three-0.60'
    AND c.filter_decision = 'KEEP'
    AND ((c.filter_reading >= 0.60
      AND c.filter_specific >= 0.60
      AND c.filter_sufficient >= 0.60)
      OR ${fallbackReasonSql('c')})`,
    `json_extract(c.metadata_json,'$.filterRule')='all-three-0.60'
    AND json_extract(c.metadata_json,'$.filterDecision')='KEEP'
    AND ((json_extract(c.metadata_json,'$.filterScores.reading_value')>=0.60
      AND json_extract(c.metadata_json,'$.filterScores.specific_content')>=0.60
      AND json_extract(c.metadata_json,'$.filterScores.sufficient_information')>=0.60)
      OR ${fallbackReasonSql('c')})`,
  );
}

// json_extract 缺字段时是 NULL。直接 NOT (NULL) 也会把行滤掉，所以缺字段按「不是低价值」处理。
const JOINED_LOW_VALUE_SQL = whenFilterReady(
  `c.filter_mode = 'enforce' AND c.filter_decision IN ('DROP','REVIEW') AND c.filter_applied = 1`,
  `IFNULL(json_extract(c.metadata_json,'$.filterMode'), '') = 'enforce'
  AND IFNULL(json_extract(c.metadata_json,'$.filterDecision'), '') IN ('DROP','REVIEW')
  AND IFNULL(json_extract(c.metadata_json,'$.filterApplied'), 0) = 1`,
);

// 与信息流列表同一套可见性：已经 JOIN 的 captures（c）和 user_item_states（item_state）。
export function joinedFeedVisibilitySql({ qualityRule = '', includeLowValue = false } = {}) {
  const visible = 'COALESCE(item_state.is_hidden, 0) = 0';
  if (!includeLowValue) return `${visible} AND NOT (${JOINED_LOW_VALUE_SQL}) AND (${captureApprovedSql(qualityRule)})`;
  if (!qualityRule) return visible;
  return `${visible} AND ((${captureApprovedSql(qualityRule)}) OR (${JOINED_LOW_VALUE_SQL}))`;
}

// 作者未读列表和未读数共用。YouTube 跟信息流按 id 取条目一样，未隐藏就保留。
export function authorItemVisibilitySql({ qualityRule = '' } = {}) {
  const visibility = joinedFeedVisibilitySql({ qualityRule });
  return `((${visibility}) OR (COALESCE(item_state.is_hidden, 0) = 0 AND COALESCE(c.provider, '') = 'youtube'))`;
}
