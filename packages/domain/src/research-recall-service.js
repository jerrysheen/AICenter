import { randomUUID } from 'node:crypto';
import { ValidationError } from '../../contracts/src/index.js';
import { isUnavailableTreeText } from '../../contracts/src/information-tree.js';
import { ResearchReportSchema } from '../../contracts/src/research-recall.js';
import {
  RESEARCH_RELEVANCE_PROMPT_VERSION,
  RESEARCH_TAG_PROMPT_VERSION,
  applyResearchAddition,
  canonicalHash,
  loadResearchCatalog,
  projectResearchTags,
  tagsForQuestion,
} from './research-catalog.js';
import { composeResearchReport } from './research-report.js';

const PAGE = 200;
const LEASE_MS = 120000;
const VERDICTS = new Set(['direct', 'background', 'irrelevant', 'insufficient']);

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function usable(member) {
  if (member.lane === 'missing-body') return false;
  return Boolean(String(member.title || '').trim() || String(member.text || '').trim() || String(member.body || '').trim());
}

function inputHash(member, pass) {
  return canonicalHash({
    title: member.title,
    text: member.text,
    bodyHash: canonicalHash(member.body || ''),
    pass,
    body: pass === 'body' ? member.body || '' : '',
  });
}

function originOf(node) {
  const sourceId = node.sourceId || '';
  if (sourceId.startsWith('feed:')) return { originType: 'content-item', originId: sourceId.slice(5), preparedKey: sourceId };
  if (sourceId.startsWith('media:')) return { originType: 'media-index', originId: sourceId.slice(6), preparedKey: sourceId };
  return { originType: 'information-node', originId: node.id, preparedKey: sourceId || node.id };
}

function pageUntil(read) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const page = read(cursor);
    rows.push(...page);
    if (page.length < PAGE) break;
    cursor = page.at(-1);
  }
  return rows;
}

function addTokens(usage, extra = {}) {
  const input = extra.inputTokens ?? extra.input_tokens;
  const output = extra.outputTokens ?? extra.output_tokens;
  if (Number.isFinite(Number(input))) usage.inputTokens = (usage.inputTokens ?? 0) + Number(input);
  if (Number.isFinite(Number(output))) usage.outputTokens = (usage.outputTokens ?? 0) + Number(output);
  const reported = extra.requests;
  usage.requests += Number.isInteger(reported) && reported > 0 ? reported : 1;
}

function rateLimited(error) {
  return error?.code === 'rate-limit' || error?.status === 429;
}

function normalizeJudge(judge) {
  if (!judge) return null;
  if (typeof judge.judge === 'function') return judge;
  if (typeof judge === 'function') return { judge, batchCharge: 'once' };
  throw new Error('研究判断端口无效');
}

function blocked(state) {
  return state.stoppedReason === 'budget-requests' || state.stoppedReason === 'budget-time' || state.stoppedReason === 'rate-limit';
}

function publicCoverage(coverage) {
  const { poolId, historyPoolId, ...rest } = coverage;
  return { ...rest, note: '已检查数量不是召回率。' };
}

export function createResearchRecallService({
  repository,
  feedRepository,
  mediaRepository,
  informationRepository,
  tagJudge = null,
  relevanceJudge = null,
  modelId = 'research-unconfigured',
  now = () => Date.now(),
  batchSize = 8,
  createToken = randomUUID,
} = {}) {
  if (!repository) throw new Error('research repository is required');
  const tagPort = normalizeJudge(tagJudge);
  const relevancePort = normalizeJudge(relevanceJudge);

  function freezePool({ workspaceId = 'local', window, history = false } = {}) {
    if (!window || !Number.isInteger(window.startAt) || !Number.isInteger(window.endAt) || window.endAt <= window.startAt) {
      throw new ValidationError('研究窗口无效', ['window']);
    }
    const prepared = new Set();
    const members = [];
    for (const node of pageUntil((cursor) => informationRepository.listInformationInWindow(workspaceId, window, {
      limit: PAGE,
      cursor: cursor ? { eventAt: cursor.eventAt, sourceId: cursor.sourceId } : null,
    }))) {
      const origin = originOf(node);
      prepared.add(origin.preparedKey);
      const missing = !node.text || isUnavailableTreeText(node.text);
      members.push({
        lane: missing ? 'missing-body' : 'information',
        resourceType: origin.originType,
        resourceId: origin.originId,
        sourceVersion: String(node.sourceVersion || node.headSourceVersion || node.version),
        eventAt: node.eventAt || window.startAt,
        title: node.title || '',
        text: missing ? '' : node.text || '',
        body: node.body || '',
        originType: origin.originType,
        originId: origin.originId,
        nodeId: node.id,
        columnTagId: node.tagId || null,
        history,
      });
    }
    if (feedRepository?.listContentItemsInWindow) {
      for (const item of pageUntil((cursor) => feedRepository.listContentItemsInWindow(workspaceId, {
        ...window, limit: PAGE, timeBasis: 'published', cursor: cursor ? { eventAt: cursor.eventAt, id: cursor.id } : null,
      }))) {
        if (item.provider === 'youtube' || prepared.has(`feed:${item.id}`)) continue;
        members.push({
          lane: 'unprepared',
          resourceType: 'content-item',
          resourceId: item.id,
          sourceVersion: String(item.updatedAt || item.createdAt || item.eventAt),
          eventAt: item.eventAt,
          title: item.title || '',
          text: item.summary || '',
          body: item.body || '',
          originType: 'content-item',
          originId: item.id,
          nodeId: null,
          columnTagId: null,
          history,
        });
      }
    }
    if (mediaRepository?.listEntriesAcrossWindow) {
      for (const item of pageUntil((cursor) => mediaRepository.listEntriesAcrossWindow(workspaceId, {
        ...window, limit: PAGE, cursor: cursor ? { eventAt: cursor.eventAt, id: cursor.externalId } : null,
      }))) {
        if (prepared.has(`media:${item.externalId}`)) continue;
        members.push({
          lane: item.briefStatus === 'failed' ? 'prepare-failed' : 'unprepared',
          resourceType: 'media-index',
          resourceId: item.externalId,
          sourceVersion: String(item.updatedAt || item.revision || item.observedAt),
          eventAt: item.eventAt,
          title: item.title || '',
          text: item.summary || '',
          body: '',
          originType: 'media-index',
          originId: item.externalId,
          nodeId: null,
          columnTagId: null,
          history,
        });
      }
    }
    members.sort((a, b) => a.eventAt - b.eventAt || a.originType.localeCompare(b.originType) || String(a.originId).localeCompare(String(b.originId)));
    const poolId = canonicalHash({
      window,
      history,
      members: members.map((member) => [member.lane, member.originType, member.originId, member.sourceVersion, canonicalHash(member.title), canonicalHash(member.text), canonicalHash(member.body)]),
    });
    repository.savePool(workspaceId, { poolId, window, members, frozenAt: now() });
    return { poolId, window, memberCount: members.length, counts: countLanes(members) };
  }

  function activate({ workspaceId = 'local', catalog = null, addition = null } = {}) {
    const current = repository.activeRelease(workspaceId);
    const loaded = addition
      ? applyResearchAddition(current ? loadResearchCatalog(current.catalog) : null, addition)
      : loadResearchCatalog(catalog);
    return repository.activateRelease(workspaceId, {
      releaseId: `${loaded.id}:${loaded.contentHash}`,
      catalogId: loaded.id,
      labelVersion: loaded.version,
      contentHash: loaded.contentHash,
      catalog: loaded,
      activatedAt: now(),
    });
  }

  function pin(workspaceId) {
    const stored = repository.activeRelease(workspaceId);
    if (!stored) throw new ValidationError('研究配置尚未加载', ['catalog']);
    const catalog = loadResearchCatalog(stored.catalog);
    if (catalog.contentHash !== stored.contentHash) throw new Error('研究配置快照哈希不一致');
    return { ...stored, catalog };
  }

  async function buildReport({ workspaceId = 'local', questionId, window, budget = {}, retryFailed = false } = {}) {
    if (!questionId) throw new ValidationError('缺少研究问题', ['questionId']);
    if (!window || !Number.isInteger(window.startAt) || !Number.isInteger(window.endAt) || window.endAt <= window.startAt) {
      throw new ValidationError('研究窗口无效', ['window']);
    }
    const pinned = pin(workspaceId);
    const question = pinned.catalog.questions.find((item) => item.id === questionId);
    if (!question) throw new ValidationError(`未知研究问题：${questionId}`, ['questionId']);
    const tags = tagsForQuestion(pinned.catalog, question);
    const started = now();
    const limits = {
      maxRequests: Number.isInteger(budget.maxRequests) ? budget.maxRequests : 400,
      maxMilliseconds: Number.isInteger(budget.maxMilliseconds) ? budget.maxMilliseconds : 120000,
    };
    const currentPool = freezePool({ workspaceId, window, history: false });
    const token = createToken();
    const runId = `run:${canonicalHash({ token, question: question.questionHash, pool: currentPool.poolId, at: started })}`;
    repository.saveRun(workspaceId, {
      id: runId,
      releaseId: pinned.releaseId,
      contentHash: pinned.contentHash,
      questionHash: question.questionHash,
      createdAt: started,
      snapshot: { releaseId: pinned.releaseId, contentHash: pinned.contentHash, questionId, questionHash: question.questionHash, window, poolId: currentPool.poolId },
    });
    const usage = { requests: 0, inputTokens: null, outputTokens: null, cost: null, elapsedMs: 0, model: modelId };
    const state = { stoppedReason: null, cacheHits: 0, discarded: new Set() };
    try {
      const currentMembers = repository.listMembers(workspaceId, currentPool.poolId);
      await judgeMembers(currentMembers, { workspaceId, question, tags, token, retryFailed, limits, started, usage, state });
      let historyPool = null;
      let historyMembers = [];
      if (question.historyLookbackMs > 0) {
        historyPool = freezePool({
          workspaceId,
          window: { startAt: window.startAt - question.historyLookbackMs, endAt: window.startAt },
          history: true,
        });
        historyMembers = repository.listMembers(workspaceId, historyPool.poolId);
        const currentOpen = tally(currentMembers, tags, question, workspaceId).open;
        if (!state.stoppedReason && currentOpen === 0) {
          await judgeMembers(historyMembers, { workspaceId, question, tags, token, retryFailed, limits, started, usage, state });
        }
      }
      const currentTally = tally(currentMembers, tags, question, workspaceId);
      const historyTally = tally(historyMembers, tags, question, workspaceId);
      const historyNotStarted = historyMembers.length && currentTally.open > 0 ? historyTally.usable : historyTally.open;
      const coverage = buildCoverage({
        currentMembers, currentTally, historyNotStarted, state, usage, poolId: currentPool.poolId, historyPoolId: historyPool?.poolId || null,
      });
      const recalled = recallMembers([...currentMembers, ...historyMembers], { workspaceId, question, tags });
      coverage.recalled = recalled.length;
      coverage.byPath = {
        tag: recalled.filter((member) => member.hits.tag.length).length,
        query: recalled.filter((member) => member.hits.query.length).length,
        relevance: recalled.filter((member) => member.hits.relevance === 'direct' || member.hits.relevance === 'background').length,
      };
      const composed = composeResearchReport({ question, recalled, poolId: currentPool.poolId, historyPoolId: historyPool?.poolId || null });
      usage.elapsedMs = Math.max(0, now() - started);
      usage.model = usage.model || modelId;
      const snapshot = judgmentSnapshot(workspaceId, [...currentMembers, ...historyMembers], tags, question);
      const backfillStatus = currentTally.usable === 0 || (currentTally.open === 0 && currentTally.failed === 0 && currentTally.inflight === 0)
        ? 'complete'
        : (currentTally.judged === 0 && currentTally.failed === 0 && usage.requests === 0 && state.cacheHits === 0 ? 'not-started' : 'partial');
      const reportId = `research:${canonicalHash({
        releaseId: pinned.releaseId,
        questionHash: question.questionHash,
        poolId: currentPool.poolId,
        historyPoolId: historyPool?.poolId || null,
        snapshot,
        conclusion: composed.conclusion,
        sections: composed.sections.map((section) => ({ id: section.subquestionId, supporting: section.supporting.map((item) => item.originId), unresolved: section.unresolved.map((item) => item.originId) })),
      })}`;
      const status = coverage.checkedComplete && coverage.unprepared === 0 && coverage.missingBody === 0 && coverage.prepareFailed === 0 && !coverage.stoppedReason && historyNotStarted === 0
        ? 'ready' : 'partial';
      const statusNote = status === 'ready'
        ? '当前窗口可用材料已完成研究判断。已检查数量不是召回率。'
        : `部分覆盖：未完成判断 ${coverage.pending + coverage.failed + coverage.inflight} 项，未整理 ${coverage.unprepared}，缺正文 ${coverage.missingBody}，准备失败 ${coverage.prepareFailed}。已检查数量不是召回率。`;
      const report = ResearchReportSchema.parse({
        id: reportId,
        releaseId: pinned.releaseId,
        contentHash: pinned.contentHash,
        labelVersion: pinned.labelVersion,
        questionId,
        questionHash: question.questionHash,
        window,
        status,
        statusNote,
        conclusion: composed.conclusion,
        overview: `${composed.overview}${statusNote}`,
        sections: composed.sections,
        relations: composed.relations,
        pack: composed.pack,
        coverage: publicCoverage(coverage),
        states: {
          definitionLoaded: { releaseId: pinned.releaseId, contentHash: pinned.contentHash, labelVersion: pinned.labelVersion },
          windowBackfill: { status: backfillStatus, judged: currentTally.judged, pending: currentTally.pending, failed: currentTally.failed },
          reportUsed: { reportId, releaseId: pinned.releaseId, contentHash: pinned.contentHash, questionHash: question.questionHash, status },
        },
        usage,
        judgmentSnapshot: snapshot,
        runId,
        generatedAt: now(),
      });
      const saved = repository.saveReport(workspaceId, report);
      repository.finishRun(workspaceId, runId, { status: report.status, reportId: report.id });
      return saved;
    } catch (error) {
      try { repository.finishRun(workspaceId, runId, { status: 'failed', reportId: '' }); } catch { /* keep the original error */ }
      throw error;
    }
  }

  function baseKey(workspaceId, member) {
    return { workspaceId, resourceType: member.resourceType, resourceId: member.resourceId, sourceVersion: member.sourceVersion, modelId };
  }

  function tagKey(workspaceId, member, tag, pass) {
    return { ...baseKey(workspaceId, member), tagId: tag.id, definitionHash: tag.definitionHash, promptVersion: RESEARCH_TAG_PROMPT_VERSION, inputHash: inputHash(member, pass) };
  }

  function relevanceKey(workspaceId, member, question, pass) {
    return { ...baseKey(workspaceId, member), questionId: question.id, questionHash: question.questionHash, promptVersion: RESEARCH_RELEVANCE_PROMPT_VERSION, inputHash: inputHash(member, pass) };
  }

  async function judgeMembers(members, ctx) {
    await runPass(members.filter(usable), 'summary', ctx);
    if (ctx.state.stoppedReason) return;
    const needBody = members.filter((member) => {
      if (!usable(member) || !member.body) return false;
      const row = repository.getRelevanceJudgment(relevanceKey(ctx.workspaceId, member, ctx.question, 'summary'));
      return row?.status === 'succeeded' && row.verdict === 'insufficient';
    });
    if (needBody.length) await runPass(needBody, 'body', ctx);
  }

  async function runPass(members, pass, ctx) {
    const tagQueue = [];
    const relevanceQueue = [];
    for (const member of members) {
      const needed = [];
      for (const tag of ctx.tags) {
        const row = repository.getTagJudgment(tagKey(ctx.workspaceId, member, tag, pass));
        if (row?.status === 'succeeded') { ctx.state.cacheHits += 1; continue; }
        if (row?.status === 'failed' && !ctx.retryFailed) continue;
        if (row?.status === 'running' && row.leaseUntil > now() && row.claimToken !== ctx.token) continue;
        needed.push(tag);
      }
      if (needed.length) tagQueue.push({ member, needed });
      const relevance = repository.getRelevanceJudgment(relevanceKey(ctx.workspaceId, member, ctx.question, pass));
      if (relevance?.status === 'succeeded') ctx.state.cacheHits += 1;
      else if (!(relevance?.status === 'failed' && !ctx.retryFailed) && !(relevance?.status === 'running' && relevance.leaseUntil > now() && relevance.claimToken !== ctx.token)) {
        relevanceQueue.push(member);
      }
    }
    let tagIndex = 0;
    let relevanceIndex = 0;
    while (tagIndex < tagQueue.length || relevanceIndex < relevanceQueue.length) {
      if (blocked(ctx.state)) return;
      if (!tagPort) {
        if (tagQueue.length) ctx.state.stoppedReason = ctx.state.stoppedReason || 'model-unavailable';
        tagIndex = tagQueue.length;
      } else if (tagIndex < tagQueue.length) tagIndex = await takeTags(tagQueue, tagIndex, pass, ctx);
      if (blocked(ctx.state)) return;
      if (!relevancePort) {
        if (relevanceQueue.length) ctx.state.stoppedReason = ctx.state.stoppedReason || 'model-unavailable';
        relevanceIndex = relevanceQueue.length;
      } else if (relevanceIndex < relevanceQueue.length) relevanceIndex = await takeRelevance(relevanceQueue, relevanceIndex, pass, ctx);
    }
  }

  function budgetAllows(charge, ctx) {
    if (ctx.usage.requests + charge > ctx.limits.maxRequests) { ctx.state.stoppedReason = ctx.state.stoppedReason || 'budget-requests'; return false; }
    if (now() - ctx.started >= ctx.limits.maxMilliseconds) { ctx.state.stoppedReason = ctx.state.stoppedReason || 'budget-time'; return false; }
    return true;
  }

  async function takeTags(queue, index, pass, ctx) {
    const slice = queue.slice(index, index + batchSize);
    const charge = tagPort.batchCharge === 'item' ? slice.length : 1;
    if (!budgetAllows(charge, ctx)) return queue.length;
    const claimed = [];
    for (const item of slice) {
      const tags = [];
      for (const tag of item.needed) {
        const claim = repository.claimTag(tagKey(ctx.workspaceId, item.member, tag, pass), { token: ctx.token, now: now(), leaseMs: LEASE_MS, retryFailed: ctx.retryFailed, pass });
        if (claim.action === 'call') tags.push(tag);
        else if (claim.action === 'cache') ctx.state.cacheHits += 1;
      }
      if (tags.length) claimed.push({ member: item.member, tags });
    }
    if (claimed.length) {
      const asked = projectResearchTags(uniqueTags(claimed.flatMap((item) => item.tags)));
      try {
        const result = await tagPort.judge({ tags: asked, items: claimed.map((item) => payloadItem(item.member, pass)), promptVersion: RESEARCH_TAG_PROMPT_VERSION, question: ctx.question });
        addTokens(ctx.usage, result?.usage || {});
        if (result?.model) ctx.usage.model = result.model;
        const byId = new Map((result?.assignments || []).map((item) => [item.resourceId, item]));
        for (const item of claimed) {
          const assignment = byId.get(item.member.resourceId);
          const allowed = new Set(item.tags.map((tag) => tag.id));
          if (!assignment || !Array.isArray(assignment.tagIds)) {
            for (const tag of item.tags) repository.failTag(tagKey(ctx.workspaceId, item.member, tag, pass), ctx.token, 'invalid-output');
            continue;
          }
          for (const tagId of assignment.tagIds) if (!allowed.has(tagId)) ctx.state.discarded.add(tagId);
          for (const tag of item.tags) repository.completeTag(tagKey(ctx.workspaceId, item.member, tag, pass), ctx.token, assignment.tagIds.includes(tag.id));
        }
      } catch (error) {
        for (const item of claimed) for (const tag of item.tags) repository.failTag(tagKey(ctx.workspaceId, item.member, tag, pass), ctx.token, error.code || 'failed');
        if (rateLimited(error)) ctx.state.stoppedReason = ctx.state.stoppedReason || 'rate-limit';
      }
    }
    return index + slice.length;
  }

  async function takeRelevance(queue, index, pass, ctx) {
    const slice = queue.slice(index, index + batchSize);
    const charge = relevancePort.batchCharge === 'item' ? slice.length : 1;
    if (!budgetAllows(charge, ctx)) return queue.length;
    const claimed = [];
    for (const member of slice) {
      const claim = repository.claimRelevance(relevanceKey(ctx.workspaceId, member, ctx.question, pass), { token: ctx.token, now: now(), leaseMs: LEASE_MS, retryFailed: ctx.retryFailed, pass });
      if (claim.action === 'call') claimed.push(member);
      else if (claim.action === 'cache') ctx.state.cacheHits += 1;
    }
    if (claimed.length) {
      try {
        const result = await relevancePort.judge({
          question: { id: ctx.question.id, objective: ctx.question.objective, subquestions: ctx.question.subquestions.map((item) => ({ id: item.id, text: item.text })), evidence: ctx.question.evidence },
          items: claimed.map((member) => payloadItem(member, pass)),
          promptVersion: RESEARCH_RELEVANCE_PROMPT_VERSION,
        });
        addTokens(ctx.usage, result?.usage || {});
        if (result?.model) ctx.usage.model = result.model;
        const byId = new Map((result?.results || []).map((item) => [item.resourceId, item]));
        for (const member of claimed) {
          const verdict = byId.get(member.resourceId)?.verdict;
          if (!VERDICTS.has(verdict)) repository.failRelevance(relevanceKey(ctx.workspaceId, member, ctx.question, pass), ctx.token, 'invalid-verdict');
          else repository.completeRelevance(relevanceKey(ctx.workspaceId, member, ctx.question, pass), ctx.token, verdict);
        }
      } catch (error) {
        for (const member of claimed) repository.failRelevance(relevanceKey(ctx.workspaceId, member, ctx.question, pass), ctx.token, error.code || 'failed');
        if (rateLimited(error)) ctx.state.stoppedReason = ctx.state.stoppedReason || 'rate-limit';
      }
    }
    return index + slice.length;
  }

  function chosenTag(workspaceId, member, tag) {
    const body = member.body ? repository.getTagJudgment(tagKey(workspaceId, member, tag, 'body')) : null;
    const summary = repository.getTagJudgment(tagKey(workspaceId, member, tag, 'summary'));
    if (body?.status === 'succeeded') return body;
    if (summary?.status === 'succeeded') return summary;
    return body?.status === 'running' || body?.status === 'failed' ? body : summary;
  }

  function chosenRelevance(workspaceId, member, question) {
    const body = member.body ? repository.getRelevanceJudgment(relevanceKey(workspaceId, member, question, 'body')) : null;
    const summary = repository.getRelevanceJudgment(relevanceKey(workspaceId, member, question, 'summary'));
    if (summary?.status === 'succeeded' && summary.verdict === 'insufficient' && member.body) {
      if (body?.status === 'succeeded' || body?.status === 'failed' || body?.status === 'running') return body;
      return null;
    }
    if (body?.status === 'succeeded') return body;
    if (summary?.status === 'succeeded') return summary;
    return body?.status === 'running' || body?.status === 'failed' ? body : summary;
  }

  function tally(members, tags, question, workspaceId) {
    const counts = { usable: 0, judged: 0, pending: 0, failed: 0, inflight: 0, open: 0 };
    for (const member of members) {
      if (!usable(member)) continue;
      counts.usable += 1;
      const rows = [...tags.map((tag) => chosenTag(workspaceId, member, tag)), relevancePort ? chosenRelevance(workspaceId, member, question) : null];
      const kind = rows.some((row) => row?.status === 'failed') ? 'failed'
        : rows.some((row) => !row) ? 'pending'
          : rows.some((row) => row.status === 'running') ? 'inflight'
            : 'judged';
      counts[kind] += 1;
      if (kind === 'pending' || kind === 'inflight') counts.open += 1;
    }
    return counts;
  }

  function recallMembers(members, { workspaceId, question, tags }) {
    const recalled = [];
    for (const member of members) {
      if (!usable(member)) continue;
      const tagHits = tags.filter((tag) => chosenTag(workspaceId, member, tag)?.status === 'succeeded' && chosenTag(workspaceId, member, tag)?.matched).map((tag) => tag.id);
      const terms = matchedTerms(member, question, tags);
      const relevance = chosenRelevance(workspaceId, member, question);
      const verdict = relevance?.status === 'succeeded' ? relevance.verdict : null;
      const relevanceHit = verdict === 'direct' || verdict === 'background' ? verdict : null;
      if (!tagHits.length && !terms.length && !relevanceHit) continue;
      const usedBody = tags.some((tag) => chosenTag(workspaceId, member, tag)?.pass === 'body' && chosenTag(workspaceId, member, tag)?.matched) || relevance?.pass === 'body';
      const subquestionIds = unique([
        ...question.subquestions.filter((sub) => sub.tagIds.some((tagId) => tagHits.includes(tagId))).map((sub) => sub.id),
        ...terms.map((term) => term.subquestionId).filter(Boolean),
      ]);
      recalled.push({
        memberId: `${member.originType}:${member.originId}`,
        ...member,
        factText: usedBody && member.body ? member.body.slice(0, 800) : (member.text || member.title),
        hits: { tag: tagHits, query: unique(terms.map((term) => term.term)), relevance: relevanceHit },
        subquestionIds,
      });
    }
    return recalled;
  }

  function judgmentSnapshot(workspaceId, members, tags, question) {
    const rows = [];
    for (const member of members) {
      if (!usable(member)) continue;
      for (const tag of tags) {
        const row = chosenTag(workspaceId, member, tag);
        if (!row) continue;
        rows.push({
          resourceType: member.resourceType, resourceId: member.resourceId, sourceVersion: member.sourceVersion,
          kind: 'tag', key: tag.id, status: row.status, matched: row.matched, verdict: '', inputHash: row.inputHash, definitionHash: tag.definitionHash,
        });
      }
      const relevance = chosenRelevance(workspaceId, member, question);
      if (relevance) {
        rows.push({
          resourceType: member.resourceType, resourceId: member.resourceId, sourceVersion: member.sourceVersion,
          kind: 'relevance', key: question.id, status: relevance.status, matched: null, verdict: relevance.verdict || '', inputHash: relevance.inputHash, definitionHash: question.questionHash,
        });
      }
    }
    return rows.sort((a, b) => `${a.resourceId}:${a.kind}:${a.key}`.localeCompare(`${b.resourceId}:${b.kind}:${b.key}`));
  }

  return { activate, freezePool, buildReport, pin };
}

function countLanes(members) {
  const counts = { information: 0, unprepared: 0, missingBody: 0, prepareFailed: 0 };
  for (const member of members) {
    if (member.lane === 'missing-body') counts.missingBody += 1;
    else if (member.lane === 'prepare-failed') counts.prepareFailed += 1;
    else if (member.lane === 'unprepared') counts.unprepared += 1;
    else counts.information += 1;
  }
  return counts;
}

function buildCoverage({ currentMembers, currentTally, historyNotStarted, state, poolId, historyPoolId }) {
  const lanes = countLanes(currentMembers);
  const checkedComplete = currentTally.usable === currentTally.judged && currentTally.failed === 0 && currentTally.inflight === 0 && !state.stoppedReason && historyNotStarted === 0;
  const openMembers = currentMembers.filter(usable);
  return {
    denominator: currentMembers.length,
    information: lanes.information,
    unprepared: lanes.unprepared,
    missingBody: lanes.missingBody,
    prepareFailed: lanes.prepareFailed,
    usable: currentTally.usable,
    judged: currentTally.judged,
    pending: currentTally.pending,
    failed: currentTally.failed,
    inflight: currentTally.inflight,
    recalled: 0,
    byPath: { tag: 0, query: 0, relevance: 0 },
    checkedComplete,
    note: '已检查数量不是召回率。',
    unjudged: unjudgedRange(openMembers, currentTally),
    historyNotStarted,
    stoppedReason: state.stoppedReason,
    discardedTagIds: [...state.discarded],
    cacheHits: state.cacheHits,
    poolId,
    historyPoolId,
  };
}

function unjudgedRange(members, tally) {
  if (!tally.open) return { count: 0, fromOrdinal: null, toOrdinal: null, sampleIds: [] };
  return {
    count: tally.open,
    fromOrdinal: members[0]?.ordinal ?? null,
    toOrdinal: members.at(-1)?.ordinal ?? null,
    sampleIds: members.slice(0, 20).map((member) => member.resourceId),
  };
}

function payloadItem(member, pass) {
  return {
    resourceId: member.resourceId,
    resourceType: member.resourceType,
    title: member.title,
    text: member.text,
    body: pass === 'body' ? member.body || '' : '',
    bodyIncluded: pass === 'body',
    bodyAvailable: Boolean(member.body),
  };
}

function uniqueTags(tags) {
  const seen = new Set();
  return tags.filter((tag) => (seen.has(tag.id) ? false : seen.add(tag.id)));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function matchedTerms(member, question, tags) {
  const blob = normalize(`${member.title}\n${member.text}\n${member.body || ''}`);
  const found = [];
  const take = (query, subquestionId) => {
    for (const term of [query.phrase, ...(query.aliases || []), ...(query.entities || [])]) {
      if (term && blob.includes(normalize(term))) found.push({ term, subquestionId });
    }
  };
  for (const query of question.queries || []) take(query, null);
  for (const sub of question.subquestions) for (const query of sub.queries || []) take(query, sub.id);
  for (const tag of tags) {
    const subquestionId = question.subquestions.find((sub) => sub.tagIds.includes(tag.id))?.id || null;
    for (const term of [...(tag.keywords || []), ...(tag.aliases || [])]) {
      if (term && blob.includes(normalize(term))) found.push({ term, subquestionId });
    }
  }
  return found;
}
