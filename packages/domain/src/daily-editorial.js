import {createHash} from 'node:crypto';
import {DailyEditorialSchema, DAILY_EDITORIAL_VERSION, DAILY_DIRECTIONS} from '../../contracts/src/daily-editorial.js';

const HOUR = 3600000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const QUALIFIERS = ['至多', '最多', '最高', '不超过', '不少于', '至少', '约', '近', '计划', '拟', '预计', '预测', '可能', '传闻', '有望', '尚未', '寻求', '据报道', '洽谈'];

export function collectDailyEditorialMaterials(repository, workspaceId, window) {
  const listed = repository.list(workspaceId, Math.floor(window.startAt / HOUR) * HOUR, window.endAt, 'hourly');
  const hours = [];
  const incompleteHours = [];
  const pending = new Set();
  const modules = [];
  const nodes = [];
  const seen = new Set();
  const unprocessedIds = [];
  for (let at = Math.floor(window.startAt / HOUR) * HOUR; at < window.endAt; at += HOUR) {
    const startAt = Math.max(at, window.startAt);
    const endAt = Math.min(at + HOUR, window.endAt);
    const row = listed.find(item => {
      const edition = item.edition;
      return edition?.window?.startAt === startAt && edition.window.endAt === endAt;
    });
    const edition = row?.edition || null;
    if (!edition || edition.status !== 'ready') incompleteHours.push(at);
    if (!edition || edition.status === 'failed') continue;
    hours.push(edition);
    for (const id of edition.pendingIds || []) pending.add(id);
    for (const rootId of edition.roots || []) {
      const module = repository.getNode(workspaceId, rootId);
      if (!module || module.layer !== 'hourly') {
        unprocessedIds.push(rootId);
        continue;
      }
      modules.push(module);
      for (const childId of module.children || []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        const node = repository.getNode(workspaceId, childId);
        if (!node || node.layer !== 'information' || !node.text) {
          unprocessedIds.push(childId);
          continue;
        }
        nodes.push(node);
      }
    }
  }
  nodes.sort((a, b) => (a.eventAt || 0) - (b.eventAt || 0) || a.id.localeCompare(b.id));
  return {window, hours, modules, nodes, incompleteHours, pendingIds: [...pending], unprocessedIds};
}

function normalized(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

function jaccard(left, right) {
  if (!left.length || !right.length) return 0;
  const set = new Set(left);
  const seen = new Set();
  let inter = 0;
  for (const item of right) {
    if (set.has(item) && !seen.has(item)) {
      seen.add(item);
      inter += 1;
    }
  }
  return inter / new Set([...left, ...right]).size;
}

function commonRun(left, right) {
  let best = 0;
  const row = new Uint16Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j];
      if (left[i - 1] === right[j - 1]) {
        row[j] = previous + 1;
        if (row[j] > best) best = row[j];
      } else row[j] = 0;
      previous = saved;
    }
  }
  return best;
}

function opening(text) {
  return text.match(/^[\p{Script=Han}]{2}/u)?.[0] || '';
}

function sameEvent(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const score = jaccard(bigrams(left), bigrams(right));
  if (score < 0.34) return false;
  const leftOpening = opening(left);
  const rightOpening = opening(right);
  if (leftOpening && rightOpening && leftOpening !== rightOpening && score < 0.85) return false;
  const run = commonRun(left, right);
  return run >= 8 || score >= 0.75;
}

function inferStatus(texts) {
  const joined = texts.join('\n');
  const flags = [
    ['planned', /计划|拟于|拟在|准备|将于/],
    ['forecast', /预计|预测|有望|或将/],
    ['rumor', /传闻|据传|未证实/],
    ['opinion', /认为|观点|看好|看空/],
  ].filter(([, pattern]) => pattern.test(joined)).map(([name]) => name);
  if (flags.length > 1) return 'mixed';
  return flags[0] || 'occurred';
}

function directionOf(nodes, directionByTag) {
  const counts = new Map();
  for (const node of nodes) {
    const value = directionByTag[node.tagId] || 'other';
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'other';
}

export function clusterInformationNodes(nodes, directionByTag = {}) {
  const rows = [...nodes].sort((a, b) => (a.eventAt || 0) - (b.eventAt || 0) || a.id.localeCompare(b.id));
  const parent = rows.map((_, index) => index);
  const find = index => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    return cursor;
  };
  const unite = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const keys = rows.map(node => normalized(node.title));
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (sameEvent(keys[i], keys[j])) unite(i, j);
    }
  }
  const groups = new Map();
  rows.forEach((node, index) => {
    const key = find(index);
    const group = groups.get(key) || [];
    group.push(node);
    groups.set(key, group);
  });
  return [...groups.values()].flatMap(group => {
    const ordered = [...group].sort((a, b) => (a.eventAt || 0) - (b.eventAt || 0) || a.id.localeCompare(b.id));
    const chunks = [];
    let current = [];
    let facts = [];
    for (const node of ordered) {
      const text = String(node.text || '').replace(/\s*\n+\s*/g, ' ').trim();
      if (!text) continue;
      const next = facts.includes(text) ? facts : [...facts, text];
      if (current.length && next.length > 40) {
        chunks.push({nodes: current, facts});
        current = [node];
        facts = [text];
      } else {
        current.push(node);
        facts = next;
      }
    }
    if (current.length) chunks.push({nodes: current, facts});
    return chunks.map(({nodes: chunk, facts: chunkFacts}) => {
      const sourceNodeIds = chunk.map(node => node.id);
      const longest = [...chunk].sort((a, b) => String(b.text || '').length - String(a.text || '').length || a.id.localeCompare(b.id))[0];
      return {
        eventId: `e${hash(sourceNodeIds).slice(0, 16)}`,
        title: String(longest.title || chunk[0].title).slice(0, 160),
        facts: chunkFacts,
        sourceNodeIds,
        status: inferStatus(chunkFacts),
        direction: directionOf(chunk, directionByTag),
        nodes: chunk,
      };
    });
  });
}

function unsupportedNumbers(text, facts) {
  const blob = facts.join('\n');
  const problems = [];
  for (const match of String(text).matchAll(/\d+(?:\.\d+)?/g)) {
    const number = match[0];
    if (number.length < 2) continue;
    if (!blob.includes(number)) problems.push(number);
  }
  return problems;
}

function droppedQualifiers(text, facts) {
  const blob = facts.join('\n');
  const dropped = [];
  for (const match of String(text).matchAll(/\d+(?:\.\d+)?/g)) {
    const number = match[0];
    let from = 0;
    while (from < blob.length) {
      const at = blob.indexOf(number, from);
      if (at < 0) break;
      const around = blob.slice(Math.max(0, at - 12), at + number.length + 12);
      for (const qualifier of QUALIFIERS) {
        if (around.includes(qualifier) && !text.includes(qualifier)) dropped.push(`${qualifier}${number}`);
      }
      from = at + number.length;
    }
  }
  return [...new Set(dropped)];
}

function indexLine(event) {
  const clean = value => String(value).replace(/\s+/g, ' ').trim();
  const latest = clean(event.facts.at(-1));
  const earlier = clean(event.facts[0]);
  const body = event.facts.length > 1 ? `${latest}（此前：${earlier}）` : latest;
  const line = `${event.title}：${body}`;
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}

function articleShell(direction, events) {
  return {
    direction,
    title: {finance: '金融与市场', tech: '科技与产业', policy: '时事与政策', other: '其他动态'}[direction],
    lead: '这一方向今天没有单独展开的核心变化，下列事项保留信息入口。',
    leadEventIds: [events[0].eventId],
    sections: [],
  };
}

export function buildDailyEditorial({materials, directionByTag = {}, overlay = {}, meta = {}}) {
  if (!materials.nodes.length) throw new Error('窗口内没有可整理的信息节点');
  let clusters = clusterInformationNodes(materials.nodes, directionByTag);
  const byId = new Map(clusters.map(cluster => [cluster.eventId, cluster]));
  const patches = overlay.events || {};
  const alias = new Map();
  const resolve = eventId => alias.get(eventId) || eventId;
  for (const group of overlay.merge || []) {
    const members = group.map(eventId => byId.get(eventId)).filter(Boolean);
    if (members.length < 2) continue;
    const sourceNodeIds = [...new Set(members.flatMap(item => item.sourceNodeIds))];
    const facts = [];
    for (const item of members) for (const fact of item.facts) if (!facts.includes(fact)) facts.push(fact);
    const patch = members.map(item => patches[item.eventId]).find(Boolean) || {};
    const merged = {
      ...members[0],
      eventId: `e${hash(sourceNodeIds).slice(0, 16)}`,
      facts: facts.slice(0, 40),
      sourceNodeIds,
      title: patch.title || members[0].title,
      patch,
    };
    for (const item of members) {
      byId.delete(item.eventId);
      alias.set(item.eventId, merged.eventId);
    }
    byId.set(merged.eventId, merged);
  }
  clusters = [...byId.values()];
  const events = clusters.map(cluster => {
    const patch = cluster.patch || patches[cluster.eventId] || {};
    return {
      eventId: cluster.eventId,
      title: patch.title || cluster.title,
      facts: cluster.facts,
      sourceNodeIds: cluster.sourceNodeIds,
      status: patch.status || cluster.status,
      direction: patch.direction || cluster.direction,
      relatedEventIds: patch.relatedEventIds || [],
      importanceLevel: patch.importanceLevel || 'other',
      importanceReason: patch.importanceReason || '独立动态，现有材料不足以并入当天的主要研究主题。',
    };
  });
  const eventMap = new Map(events.map(event => [event.eventId, event]));
  for (const eventId of Object.keys(patches)) {
    if (!eventMap.has(eventId) && !(overlay.merge || []).some(group => group.includes(eventId))) {
      throw new Error(`未知事件 ${eventId}`);
    }
  }
  const drafted = [];
  for (const direction of DAILY_DIRECTIONS) {
    const source = (overlay.articles || []).find(article => article.direction === direction);
    const owned = events.filter(event => event.direction === direction);
    if (!source && !owned.length) continue;
    drafted.push(source ? {
      direction,
      title: source.title,
      lead: source.lead,
      leadEventIds: [...new Set(source.leadEventIds.map(resolve))],
      sections: source.sections.map(section => ({...section, eventIds: [...new Set(section.eventIds.map(resolve))]})),
    } : articleShell(direction, owned));
  }
  const inBody = new Set();
  for (const article of drafted) {
    const thematic = article.sections.some(section => section.kind === 'theme' || section.kind === 'lead');
    if (thematic) article.leadEventIds.forEach(eventId => inBody.add(eventId));
    for (const section of article.sections) {
      if (section.kind === 'theme' || section.kind === 'lead') section.eventIds.forEach(eventId => inBody.add(eventId));
    }
  }
  const articles = [];
  for (const article of drafted) {
    const leftovers = events.filter(event => event.direction === article.direction && !inBody.has(event.eventId));
    if (leftovers.length && !article.sections.some(section => section.kind === 'other')) {
      for (let index = 0; index < leftovers.length; index += 400) {
        const slice = leftovers.slice(index, index + 400);
        article.sections.push({
          heading: index === 0 ? '其他动态' : '其他动态（续）',
          kind: 'other',
          eventIds: slice.map(event => event.eventId),
          paragraphs: slice.map(indexLine),
        });
      }
    }
    if (article.sections.length) articles.push(article);
  }
  const relations = (overlay.relations || []).map(relation => ({...relation, eventIds: [...new Set(relation.eventIds.map(resolve))]}));
  const factBook = new Map(events.map(event => [event.eventId, event.facts]));
  const overviewFacts = events.flatMap(event => event.facts);
  const overviewProblems = [
    ...unsupportedNumbers(overlay.overview || '', overviewFacts).map(item => `导读数字无来源:${item}`),
    ...droppedQualifiers(overlay.overview || '', overviewFacts).map(item => `导读限定被改写:${item}`),
  ];
  for (const article of articles) {
    const leadFacts = article.leadEventIds.flatMap(eventId => factBook.get(eventId) || []);
    overviewProblems.push(...unsupportedNumbers(article.lead, leadFacts).map(item => `${article.direction}导读数字无来源:${item}`));
    overviewProblems.push(...droppedQualifiers(article.lead, leadFacts).map(item => `${article.direction}导读限定被改写:${item}`));
    for (const section of article.sections) {
      if (section.kind === 'other') continue;
      const facts = section.eventIds.flatMap(eventId => factBook.get(eventId) || []);
      for (const text of section.paragraphs) {
        overviewProblems.push(...unsupportedNumbers(text, facts).map(item => `${section.heading}数字无来源:${item}`));
        overviewProblems.push(...droppedQualifiers(text, facts).map(item => `${section.heading}限定被改写:${item}`));
      }
    }
  }
  if (overviewProblems.length) throw new Error(overviewProblems.slice(0, 6).join('；'));
  const indexed = new Set(articles.flatMap(article => article.sections.filter(section => section.kind === 'other').flatMap(section => section.eventIds)));
  for (const event of events) {
    if (!inBody.has(event.eventId) && !indexed.has(event.eventId)) throw new Error(`事件未进入正文或其他动态:${event.eventId}`);
    if (event.importanceLevel === 'core' && !inBody.has(event.eventId)) throw new Error(`核心事件未进入正文:${event.eventId}`);
  }
  const allowedNodes = new Set(materials.nodes.map(node => node.id));
  const seenNodes = new Set();
  for (const event of events) {
    for (const nodeId of event.sourceNodeIds) {
      if (!allowedNodes.has(nodeId) || seenNodes.has(nodeId)) throw new Error(`未知或重复信息节点:${nodeId}`);
      seenNodes.add(nodeId);
    }
    for (const related of event.relatedEventIds) if (!events.some(item => item.eventId === related)) throw new Error(`未知关联事件:${related}`);
  }
  if (seenNodes.size !== allowedNodes.size) throw new Error('信息节点归属不完整');
  for (const relation of relations) {
    if (relation.eventIds.some(eventId => !events.some(event => event.eventId === eventId))) throw new Error('关联引用了未知事件');
    if (relation.type === 'supported-impact' && relation.certainty === 'unverified') throw new Error('有依据的影响不能标成未验证');
    if (relation.type === 'unverified-link' && relation.certainty === 'stated') throw new Error('潜在联系不能写成已陈述事实');
  }
  for (const article of articles) {
    for (const eventId of [...article.leadEventIds, ...article.sections.flatMap(section => section.eventIds)]) {
      if (!events.some(event => event.eventId === eventId)) throw new Error(`文章引用了未知事件:${eventId}`);
    }
  }
  const coverage = {
    hourlyModuleCount: materials.modules.length,
    informationNodeCount: materials.nodes.length,
    eventCount: events.length,
    inBodyEventCount: events.filter(event => inBody.has(event.eventId)).length,
    indexOnlyEventCount: events.filter(event => !inBody.has(event.eventId)).length,
    unprocessedCount: materials.unprocessedIds.length,
    incompleteHours: materials.incompleteHours,
    pendingMaterialCount: materials.pendingIds.length,
    complete: materials.incompleteHours.length === 0 && materials.pendingIds.length === 0 && materials.unprocessedIds.length === 0,
  };
  const overview = overlay.overview || '本窗口已经落盘的信息都归入了事件索引。分析段落尚未写入，所以这里只保证每条信息有归属。';
  const status = coverage.complete ? 'ready' : 'partial';
  const statusNote = coverage.complete
    ? '已覆盖当前窗口内已落盘的小时模块和信息节点。'
    : `部分覆盖：${coverage.incompleteHours.length} 个小时窗口未完成，待补材料 ${coverage.pendingMaterialCount} 项，未能读取 ${coverage.unprocessedCount} 条。本文只分析已经落盘的材料，不是完整全天结论。`;
  const inputSnapshotHash = hash({
    nodes: materials.nodes.map(node => ({id: node.id, version: node.version || ''})).sort((a, b) => a.id.localeCompare(b.id)),
    hours: materials.hours.map(hour => hour.id).sort(),
  });
  const id = `editorial:${hash({
    inputSnapshotHash,
    strategyVersion: DAILY_EDITORIAL_VERSION,
    model: meta.model || 'cursor-session',
    overview,
    events: events.map(event => ({id: event.eventId, title: event.title, importance: event.importanceLevel, direction: event.direction, status: event.status})),
    articles,
    relations,
  })}`;
  return DailyEditorialSchema.parse({
    id,
    version: DAILY_EDITORIAL_VERSION,
    reportDate: meta.reportDate,
    window: materials.window,
    timezone: meta.timezone || 'Asia/Shanghai',
    status,
    statusNote,
    overview,
    events,
    relations,
    articles,
    coverage,
    usage: {
      calls: meta.calls ?? 0,
      inputTokens: meta.inputTokens ?? null,
      outputTokens: meta.outputTokens ?? null,
      cost: meta.cost ?? null,
      model: meta.model || 'cursor-session',
    },
    inputSnapshotHash,
    strategyVersion: DAILY_EDITORIAL_VERSION,
    generatedAt: meta.generatedAt ?? Date.now(),
  });
}
