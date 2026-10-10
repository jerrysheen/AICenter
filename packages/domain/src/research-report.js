import { clusterInformationNodes } from './daily-editorial.js';

const UP = /上升|上调|增加|增长|扩产|提价/;
const DOWN = /下降|下调|减少|下滑|减产|降价/;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function evidence(member, fact) {
  return { fact, nodeId: member.nodeId || null, originType: member.originType, originId: member.originId };
}

function clusterMembers(members) {
  if (!members.length) return [];
  const byId = new Map(members.map((member) => [member.memberId, member]));
  const nodes = members.map((member) => ({
    id: member.memberId,
    title: member.title || member.memberId,
    text: member.factText || member.text || member.title || '无正文',
    tagId: null,
    eventAt: member.eventAt,
  }));
  return clusterInformationNodes(nodes, {}).map((event) => {
    const grouped = event.sourceNodeIds.map((id) => byId.get(id)).filter(Boolean);
    return { ...event, members: grouped };
  });
}

function bucketFor(members) {
  const supported = members.some((member) => member.hits.tag.length || member.hits.relevance === 'direct');
  const queryOnly = members.every((member) => member.hits.query.length && !member.hits.tag.length && member.hits.relevance !== 'direct' && member.hits.relevance !== 'background');
  if (members.every((member) => member.history) || members.every((member) => member.hits.relevance === 'background' && !member.hits.tag.length)) return 'background';
  if (!supported && queryOnly) return 'unverified';
  if (supported && !members.every((member) => member.history)) return 'current';
  return 'unverified';
}

function contradicts(facts) {
  const blob = facts.join('\n');
  return UP.test(blob) && DOWN.test(blob);
}

export function composeResearchReport({ question, recalled, poolId, historyPoolId = null }) {
  const events = clusterMembers(recalled).map((event) => {
    const members = event.members;
    const bucket = bucketFor(members);
    const hits = {
      tag: unique(members.flatMap((member) => member.hits.tag)),
      query: unique(members.flatMap((member) => member.hits.query)),
      relevance: unique(members.map((member) => member.hits.relevance).filter((item) => item === 'direct' || item === 'background')),
    };
    return {
      eventId: event.eventId,
      title: event.title,
      facts: event.facts,
      bucket,
      origins: members.map((member) => ({ type: member.originType, id: member.originId, nodeId: member.nodeId || null })),
      hits,
      members,
      conflict: contradicts(event.facts),
    };
  });
  const subquestionOfTag = new Map();
  for (const sub of question.subquestions) for (const tagId of sub.tagIds) subquestionOfTag.set(tagId, sub.id);
  const sections = question.subquestions.map((sub) => {
    const supporting = [];
    const opposing = [];
    const unresolved = [];
    for (const event of events) {
      const owned = event.members.filter((member) => member.subquestionIds.includes(sub.id) || member.hits.tag.some((tagId) => sub.tagIds.includes(tagId)));
      if (!owned.length && !event.hits.query.some((term) => (sub.queries || []).some((query) => query.phrase === term || (query.aliases || []).includes(term)))) continue;
      for (const member of event.members) {
        const fact = member.factText || member.text || member.title;
        const row = evidence(member, fact);
        const supports = (member.hits.tag.some((tagId) => sub.tagIds.includes(tagId)) || member.hits.relevance === 'direct') && !member.history && event.bucket === 'current' && !event.conflict;
        if (supports && member.subquestionIds.includes(sub.id)) supporting.push(row);
        else unresolved.push(row);
        if (event.conflict && DOWN.test(fact) && member.subquestionIds.includes(sub.id)) opposing.push(row);
      }
    }
    const paragraphs = [];
    if (supporting.length) paragraphs.push(...supporting.map((item) => `${sub.text}材料记载：${item.fact}（来源 ${item.originType}:${item.originId}）。`));
    else paragraphs.push(`${sub.text}这一问没有召回到可单独支持判断的材料。`);
    if (unresolved.length) paragraphs.push('其余命中只作为线索保留，关键词或同时出现不能单独决定相关性，也不能写成因果关系。');
    const blob = [...supporting, ...unresolved, ...opposing].map((item) => item.fact).join('\n');
    if (/融资|贷款|发行/.test(blob)) paragraphs.push('融资相关表述要区分计划、拟议和已经完成。');
    if (/价格|报价|现货|合约/.test(blob)) paragraphs.push('价格变化要区分现货、合约和传闻。');
    return { subquestionId: sub.id, heading: sub.text, paragraphs, supporting, opposing, unresolved };
  });
  const assigned = new Set(sections.flatMap((section) => [...section.supporting, ...section.unresolved, ...section.opposing].map((item) => `${item.originType}:${item.originId}`)));
  const loose = recalled.filter((member) => !assigned.has(`${member.originType}:${member.originId}`));
  if (loose.length) {
    sections.push({
      subquestionId: 'unassigned',
      heading: '已召回但还不能归入子问题',
      paragraphs: loose.map((member) => `${member.factText || member.text || member.title}（来源 ${member.originType}:${member.originId}）。`),
      supporting: loose.filter((member) => member.hits.relevance === 'direct' && !member.history).map((member) => evidence(member, member.factText || member.text || member.title)),
      opposing: [],
      unresolved: loose.filter((member) => member.hits.relevance !== 'direct' || member.history).map((member) => evidence(member, member.factText || member.text || member.title)),
    });
  }
  const relations = [];
  for (const event of events) {
    const subs = unique(event.hits.tag.map((tagId) => subquestionOfTag.get(tagId)));
    if (subs.length > 1) {
      relations.push({
        type: 'co-occurrence',
        eventIds: [event.eventId],
        note: '这些事实同时出现，不能据此建立因果关系，也不能判断它们针对同一种产品或能在同一时间兑现。',
      });
    }
    if (event.conflict) {
      relations.push({ type: 'conflict', eventIds: [event.eventId], note: '材料对变化方向存在冲突，不能合成单一结论。' });
    }
  }
  const supportCount = sections.reduce((sum, section) => sum + section.supporting.length, 0);
  const conclusion = supportCount ? '报告只组织已召回材料中的变化、冲突和尚未能成立的关联，不预设涨跌。' : '尚不能判断。';
  const overview = `${question.objective}${supportCount ? '' : '当前召回里没有可单独支持判断的材料。'}`;
  const buckets = { current: [], background: [], unverified: [] };
  for (const event of events) buckets[event.bucket].push(event.eventId);
  return {
    conclusion,
    overview,
    sections,
    relations,
    pack: {
      poolId,
      historyPoolId,
      events: events.map(({ members, conflict, ...event }) => event),
      buckets,
      evidence: events.flatMap((event) => event.facts.map((fact) => ({ fact, eventId: event.eventId, sources: event.origins }))),
    },
  };
}
