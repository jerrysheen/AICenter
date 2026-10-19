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
const JUDGE_HYDRATE = 16;
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
  if (extra.requests === 0) return;
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

function budgetAborted(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

function tagMapKey(key) {
  return [key.resourceType, key.resourceId, key.sourceVersion, key.tagId, key.definitionHash, key.promptVersion, key.inputHash].join('\u0001');
}

function relevanceMapKey(key) {
  return [key.resourceType, key.resourceId, key.sourceVersion, key.questionId, key.questionHash, key.promptVersion, key.inputHash].join('\u0001');
}

function tagPassKey(key, pass) {
  return [key.resourceType, key.resourceId, key.sourceVersion, key.tagId, key.definitionHash, key.promptVersion, pass].join('\u0001');
}

function relevancePassKey(key, pass) {
  return [key.resourceType, key.resourceId, key.sourceVersion, key.questionId, key.questionHash, key.promptVersion, pass].join('\u0001');
}

function putPass(map, key, row) {
  if (!key || !row?.pass) return;
  const current = map.get(key);
  if (!current) { map.set(key, row); return; }
  const rank = (item) => (item.status === 'succeeded' ? 2 : 1);
  if (rank(row) > rank(current) || (rank(row) === rank(current) && (row.updatedAt || 0) >= (current.updatedAt || 0))) {
    map.set(key, row);
  }
}

function lookupJudgment(exactMap, passMap, exactKey, passKey, member) {
  const exact = exactMap.get(exactKey);
  if (exact) return exact;
  if (member.body || !member.hasBody) return null;
  return passMap.get(passKey) || null;
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
    const deadlineAt = started + limits.maxMilliseconds;
    const signal = AbortSignal.timeout(Math.max(1, limits.maxMilliseconds));
    const previous = repository.latestReport?.(workspaceId, questionId, window) || null;
    const reusable = previous
      && previous.status === 'partial'
      && previous.contentHash === pinned.contentHash
      && previous.questionHash === question.questionHash
      ? previous
      : null;
    const reusedCurrent = reusable?.pack?.poolId && repository.hasPool?.(workspaceId, reusable.pack.poolId)
      ? { poolId: reusable.pack.poolId }
      : null;
    const currentPool = reusedCurrent || freezePool({ workspaceId, window, history: false });
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
    const maps = { tag: new Map(), relevance: new Map(), tagPass: new Map(), relevancePass: new Map() };
    try {
      loadPoolJudgments(workspaceId, currentPool.poolId, maps);
      const currentMembers = repository.listMemberHeads(workspaceId, currentPool.poolId);
      const judgeContext = { workspaceId, question, tags, token, retryFailed, limits, started, deadlineAt, signal, usage, state, maps, poolId: currentPool.poolId };
      await judgeOpen(currentMembers, judgeContext);
      let historyPool = null;
      let historyPoolId = null;
      let historyMembers = [];
      let historyNotStartedOverride = null;
      if (question.historyLookbackMs > 0) {
        const historyWindow = { startAt: window.startAt - question.historyLookbackMs, endAt: window.startAt };
        const currentOpen = tally(currentMembers, tags, question, workspaceId, maps).open;
        const timeLeft = !signal.aborted && now() < deadlineAt;
        const reusedHistoryId = reusable?.pack?.historyPoolId && repository.hasPool?.(workspaceId, reusable.pack.historyPoolId)
          ? reusable.pack.historyPoolId
          : null;
        if (!state.stoppedReason && currentOpen === 0 && timeLeft) {
          historyPool = reusedHistoryId ? { poolId: reusedHistoryId } : freezePool({ workspaceId, window: historyWindow, history: true });
          historyPoolId = historyPool.poolId;
          historyMembers = repository.listMemberHeads(workspaceId, historyPool.poolId);
          loadPoolJudgments(workspaceId, historyPool.poolId, maps);
          await judgeOpen(historyMembers, { ...judgeContext, poolId: historyPool.poolId });
        } else if (reusedHistoryId) {
          historyPoolId = reusedHistoryId;
          historyNotStartedOverride = repository.countMembers(workspaceId, reusedHistoryId);
        } else {
          historyNotStartedOverride = countHistorySources(workspaceId, historyWindow);
        }
      }
      const currentTally = tally(currentMembers, tags, question, workspaceId, maps);
      const historyTally = tally(historyMembers, tags, question, workspaceId, maps);
      const historyNotStarted = historyNotStartedOverride != null
        ? historyNotStartedOverride
        : (historyMembers.length && currentTally.open > 0 ? historyTally.usable : historyTally.open);
      const coverage = buildCoverage({
        currentMembers, currentTally, historyNotStarted, state, usage, poolId: currentPool.poolId, historyPoolId,
      });
      const recalled = [
        ...recallHydrated(currentMembers, { workspaceId, question, tags, maps, poolId: currentPool.poolId }),
        ...recallHydrated(historyMembers, { workspaceId, question, tags, maps, poolId: historyPoolId }),
      ];
      coverage.recalled = recalled.length;
      coverage.byPath = {
        tag: recalled.filter((member) => member.hits.tag.length).length,
        query: recalled.filter((member) => member.hits.query.length).length,
        relevance: recalled.filter((member) => member.hits.relevance === 'direct' || member.hits.relevance === 'background').length,
      };
      const composed = composeResearchReport({ question, recalled, poolId: currentPool.poolId, historyPoolId });
      usage.elapsedMs = Math.max(0, now() - started);
      usage.model = usage.model || modelId;
      const snapshot = judgmentSnapshot(workspaceId, [...currentMembers, ...historyMembers], tags, question, maps);
      const backfillStatus = currentTally.usable === 0 || (currentTally.open === 0 && currentTally.failed === 0 && currentTally.inflight === 0)
        ? 'complete'
        : (currentTally.judged === 0 && currentTally.failed === 0 && usage.requests === 0 && state.cacheHits === 0 ? 'not-started' : 'partial');
      const reportId = `research:${canonicalHash({
        releaseId: pinned.releaseId,
        questionHash: question.questionHash,
        poolId: currentPool.poolId,
        historyPoolId,
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

  function tagPromptVersion() {
    return tagPort?.promptVersion || RESEARCH_TAG_PROMPT_VERSION;
  }

  function relevancePromptVersion() {
    return relevancePort?.promptVersion || RESEARCH_RELEVANCE_PROMPT_VERSION;
  }

  function loadPoolJudgments(workspaceId, poolId, maps) {
    if (!poolId || !repository.listTagJudgmentsForPool) return;
    for (const row of repository.listTagJudgmentsForPool(workspaceId, poolId, modelId)) {
      maps.tag.set(tagMapKey(row), row);
      putPass(maps.tagPass, tagPassKey(row, row.pass), row);
    }
    for (const row of repository.listRelevanceJudgmentsForPool(workspaceId, poolId, modelId)) {
      maps.relevance.set(relevanceMapKey(row), row);
      putPass(maps.relevancePass, relevancePassKey(row, row.pass), row);
    }
  }

  function countHistorySources(workspaceId, historyWindow) {
    let count = 0;
    if (informationRepository?.countInformationInWindow) count += informationRepository.countInformationInWindow(workspaceId, historyWindow) || 0;
    if (feedRepository?.countContentItemsInWindow) count += feedRepository.countContentItemsInWindow(workspaceId, { ...historyWindow, timeBasis: 'published' }) || 0;
    if (mediaRepository?.countEntriesAcrossWindow) count += mediaRepository.countEntriesAcrossWindow(workspaceId, historyWindow) || 0;
    return count;
  }

  function tagKey(workspaceId, member, tag, pass) {
    return { ...baseKey(workspaceId, member), tagId: tag.id, definitionHash: tag.definitionHash, promptVersion: tagPromptVersion(), inputHash: inputHash(member, pass) };
  }

  function relevanceKey(workspaceId, member, question, pass) {
    return { ...baseKey(workspaceId, member), questionId: question.id, questionHash: question.questionHash, promptVersion: relevancePromptVersion(), inputHash: inputHash(member, pass) };
  }

  async function judgeMembers(members, ctx) {
    await runPass(members.filter(usable), 'summary', ctx);
    if (ctx.state.stoppedReason) return;
    const needBody = members.filter((member) => {
      if (!usable(member) || !member.body) return false;
      const row = ctx.maps.relevance.get(relevanceMapKey(relevanceKey(ctx.workspaceId, member, ctx.question, 'summary')));
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
        const row = ctx.maps.tag.get(tagMapKey(tagKey(ctx.workspaceId, member, tag, pass)));
        if (row?.status === 'succeeded') { ctx.state.cacheHits += 1; continue; }
        if (row?.status === 'failed' && !ctx.retryFailed) continue;
        if (row?.status === 'running' && row.leaseUntil > now() && row.claimToken !== ctx.token) continue;
        needed.push(tag);
      }
      if (needed.length) tagQueue.push({ member, needed });
      const relevance = ctx.maps.relevance.get(relevanceMapKey(relevanceKey(ctx.workspaceId, member, ctx.question, pass)));
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
    if (ctx.signal?.aborted || now() >= ctx.deadlineAt) { ctx.state.stoppedReason = ctx.state.stoppedReason || 'budget-time'; return false; }
    return true;
  }

  function rememberTag(ctx, key, row) {
    ctx.maps.tag.set(tagMapKey(key), row);
    if (row.pass) ctx.maps.tagPass.set(tagPassKey(key, row.pass), row);
  }

  function rememberRelevance(ctx, key, row) {
    ctx.maps.relevance.set(relevanceMapKey(key), row);
    if (row.pass) ctx.maps.relevancePass.set(relevancePassKey(key, row.pass), row);
  }

  function releaseBudgetTags(ctx, claimed, pass) {
    for (const item of claimed) {
      for (const tag of item.tags) {
        const key = tagKey(ctx.workspaceId, item.member, tag, pass);
        repository.releaseTag(key, ctx.token);
        ctx.maps.tag.delete(tagMapKey(key));
        const cached = ctx.maps.tagPass.get(tagPassKey(key, pass));
        if (cached?.inputHash === key.inputHash) ctx.maps.tagPass.delete(tagPassKey(key, pass));
      }
    }
    ctx.state.stoppedReason = ctx.state.stoppedReason || 'budget-time';
  }

  function releaseBudgetRelevance(ctx, claimed, pass) {
    for (const member of claimed) {
      const key = relevanceKey(ctx.workspaceId, member, ctx.question, pass);
      repository.releaseRelevance(key, ctx.token);
      ctx.maps.relevance.delete(relevanceMapKey(key));
      const cached = ctx.maps.relevancePass.get(relevancePassKey(key, pass));
      if (cached?.inputHash === key.inputHash) ctx.maps.relevancePass.delete(relevancePassKey(key, pass));
    }
    ctx.state.stoppedReason = ctx.state.stoppedReason || 'budget-time';
  }

  async function takeTags(queue, index, pass, ctx) {
    const step = tagPort.batchCharge === 'item' ? 1 : batchSize;
    const slice = queue.slice(index, index + step);
    const charge = tagPort.batchCharge === 'item' ? slice.length : 1;
    if (!budgetAllows(charge, ctx)) return queue.length;
    const claimed = [];
    for (const item of slice) {
      const tags = [];
      for (const tag of item.needed) {
        const key = tagKey(ctx.workspaceId, item.member, tag, pass);
        const claim = repository.claimTag(key, { token: ctx.token, now: now(), leaseMs: LEASE_MS, retryFailed: ctx.retryFailed, pass });
        if (claim.action === 'call') tags.push(tag);
        else if (claim.action === 'cache') {
          ctx.state.cacheHits += 1;
          if (claim.row) rememberTag(ctx, key, claim.row);
        }
      }
      if (tags.length) claimed.push({ member: item.member, tags });
    }
    if (claimed.length) {
      const asked = projectResearchTags(uniqueTags(claimed.flatMap((item) => item.tags)));
      try {
        const result = await tagPort.judge({
          tags: asked,
          items: claimed.map((item) => payloadItem(item.member, pass)),
          promptVersion: tagPromptVersion(),
          question: ctx.question,
          signal: ctx.signal,
        });
        addTokens(ctx.usage, result?.usage || {});
        if (result?.model) ctx.usage.model = result.model;
        const byId = new Map((result?.assignments || []).map((item) => [item.resourceId, item]));
        let missedBecauseBudget = false;
        for (const item of claimed) {
          const assignment = byId.get(item.member.resourceId);
          const allowed = new Set(item.tags.map((tag) => tag.id));
          if (!assignment || !Array.isArray(assignment.tagIds)) {
            if (ctx.signal?.aborted) {
              missedBecauseBudget = true;
              continue;
            }
            for (const tag of item.tags) {
              const key = tagKey(ctx.workspaceId, item.member, tag, pass);
              repository.failTag(key, ctx.token, 'invalid-output');
              rememberTag(ctx, key, { status: 'failed', matched: null, inputHash: key.inputHash, pass, leaseUntil: 0, claimToken: ctx.token, errorCode: 'invalid-output' });
            }
            continue;
          }
          for (const tagId of assignment.tagIds) if (!allowed.has(tagId)) ctx.state.discarded.add(tagId);
          for (const tag of item.tags) {
            const key = tagKey(ctx.workspaceId, item.member, tag, pass);
            const matched = assignment.tagIds.includes(tag.id);
            repository.completeTag(key, ctx.token, matched);
            rememberTag(ctx, key, { status: 'succeeded', matched, inputHash: key.inputHash, pass, leaseUntil: 0, claimToken: '', errorCode: '' });
          }
        }
        if (missedBecauseBudget) releaseBudgetTags(ctx, claimed.filter((item) => !byId.has(item.member.resourceId)), pass);
      } catch (error) {
        if (budgetAborted(error, ctx.signal)) {
          releaseBudgetTags(ctx, claimed, pass);
          return queue.length;
        }
        for (const item of claimed) for (const tag of item.tags) {
          const key = tagKey(ctx.workspaceId, item.member, tag, pass);
          const errorCode = error.code || 'failed';
          repository.failTag(key, ctx.token, errorCode);
          rememberTag(ctx, key, { status: 'failed', matched: null, inputHash: key.inputHash, pass, leaseUntil: 0, claimToken: ctx.token, errorCode });
        }
        if (rateLimited(error)) ctx.state.stoppedReason = ctx.state.stoppedReason || 'rate-limit';
      }
    }
    if (ctx.signal?.aborted || now() >= ctx.deadlineAt) ctx.state.stoppedReason = ctx.state.stoppedReason || 'budget-time';
    return index + slice.length;
  }

  async function takeRelevance(queue, index, pass, ctx) {
    const step = relevancePort.batchCharge === 'item' ? 1 : batchSize;
    const slice = queue.slice(index, index + step);
    const charge = relevancePort.batchCharge === 'item' ? slice.length : 1;
    if (!budgetAllows(charge, ctx)) return queue.length;
    const claimed = [];
    for (const member of slice) {
      const key = relevanceKey(ctx.workspaceId, member, ctx.question, pass);
      const claim = repository.claimRelevance(key, { token: ctx.token, now: now(), leaseMs: LEASE_MS, retryFailed: ctx.retryFailed, pass });
      if (claim.action === 'call') claimed.push(member);
      else if (claim.action === 'cache') {
        ctx.state.cacheHits += 1;
        if (claim.row) rememberRelevance(ctx, key, claim.row);
      }
    }
    if (claimed.length) {
      try {
        const result = await relevancePort.judge({
          question: { id: ctx.question.id, objective: ctx.question.objective, subquestions: ctx.question.subquestions.map((item) => ({ id: item.id, text: item.text })), evidence: ctx.question.evidence },
          items: claimed.map((member) => payloadItem(member, pass)),
          promptVersion: relevancePromptVersion(),
          signal: ctx.signal,
        });
        addTokens(ctx.usage, result?.usage || {});
        if (result?.model) ctx.usage.model = result.model;
        const byId = new Map((result?.results || []).map((item) => [item.resourceId, item]));
        const missed = [];
        for (const member of claimed) {
          const verdict = byId.get(member.resourceId)?.verdict;
          const key = relevanceKey(ctx.workspaceId, member, ctx.question, pass);
          if (!VERDICTS.has(verdict)) {
            if (ctx.signal?.aborted) { missed.push(member); continue; }
            repository.failRelevance(key, ctx.token, 'invalid-verdict');
            rememberRelevance(ctx, key, { status: 'failed', verdict: '', inputHash: key.inputHash, pass, leaseUntil: 0, claimToken: ctx.token, errorCode: 'invalid-verdict' });
          } else {
            repository.completeRelevance(key, ctx.token, verdict);
            rememberRelevance(ctx, key, { status: 'succeeded', verdict, inputHash: key.inputHash, pass, leaseUntil: 0, claimToken: '', errorCode: '' });
          }
        }
        if (missed.length) releaseBudgetRelevance(ctx, missed, pass);
      } catch (error) {
        if (budgetAborted(error, ctx.signal)) {
          releaseBudgetRelevance(ctx, claimed, pass);
          return queue.length;
        }
        for (const member of claimed) {
          const key = relevanceKey(ctx.workspaceId, member, ctx.question, pass);
          const errorCode = error.code || 'failed';
          repository.failRelevance(key, ctx.token, errorCode);
          rememberRelevance(ctx, key, { status: 'failed', verdict: '', inputHash: key.inputHash, pass, leaseUntil: 0, claimToken: ctx.token, errorCode });
        }
        if (rateLimited(error)) ctx.state.stoppedReason = ctx.state.stoppedReason || 'rate-limit';
      }
    }
    if (ctx.signal?.aborted || now() >= ctx.deadlineAt) ctx.state.stoppedReason = ctx.state.stoppedReason || 'budget-time';
    return index + slice.length;
  }

  function lookupTag(workspaceId, member, tag, pass, maps) {
    const key = tagKey(workspaceId, member, tag, pass);
    return lookupJudgment(maps.tag, maps.tagPass, tagMapKey(key), tagPassKey(key, pass), member);
  }

  function lookupRelevance(workspaceId, member, question, pass, maps) {
    const key = relevanceKey(workspaceId, member, question, pass);
    return lookupJudgment(maps.relevance, maps.relevancePass, relevanceMapKey(key), relevancePassKey(key, pass), member);
  }

  function chosenTag(workspaceId, member, tag, maps) {
    const body = lookupTag(workspaceId, member, tag, 'body', maps);
    const summary = lookupTag(workspaceId, member, tag, 'summary', maps);
    if (body?.status === 'succeeded') return body;
    if (summary?.status === 'succeeded') return summary;
    return body?.status === 'running' || body?.status === 'failed' ? body : summary;
  }

  function chosenRelevance(workspaceId, member, question, maps) {
    const body = lookupRelevance(workspaceId, member, question, 'body', maps);
    const summary = lookupRelevance(workspaceId, member, question, 'summary', maps);
    const bodyAvailable = Boolean(member.body) || member.hasBody;
    if (summary?.status === 'succeeded' && summary.verdict === 'insufficient' && bodyAvailable) {
      if (body?.status === 'succeeded' || body?.status === 'failed' || body?.status === 'running') return body;
      return null;
    }
    if (body?.status === 'succeeded') return body;
    if (summary?.status === 'succeeded') return summary;
    return body?.status === 'running' || body?.status === 'failed' ? body : summary;
  }

  function memberNeedsCall(member, ctx) {
    if (!usable(member)) return false;
    for (const tag of ctx.tags) {
      const row = chosenTag(ctx.workspaceId, member, tag, ctx.maps);
      if (!row) return true;
      if (row.status === 'failed' && ctx.retryFailed) return true;
      if (row.status === 'running' && !(row.leaseUntil > now() && row.claimToken !== ctx.token)) return true;
    }
    if (!relevancePort) return false;
    const relevance = chosenRelevance(ctx.workspaceId, member, ctx.question, ctx.maps);
    if (!relevance) return true;
    if (relevance.status === 'failed' && ctx.retryFailed) return true;
    if (relevance.status === 'running' && !(relevance.leaseUntil > now() && relevance.claimToken !== ctx.token)) return true;
    return false;
  }

  function hydrateBodies(workspaceId, poolId, members) {
    const need = members.filter((member) => member.hasBody && !member.body);
    if (!need.length || !poolId || !repository.memberBodies) return;
    const bodies = repository.memberBodies(workspaceId, poolId, need.map((member) => member.ordinal));
    for (const member of need) member.body = bodies.get(member.ordinal) || '';
  }

  async function judgeOpen(members, ctx) {
    while (!blocked(ctx.state) && !ctx.signal?.aborted && now() < ctx.deadlineAt) {
      const slice = members.filter((member) => memberNeedsCall(member, ctx)).slice(0, JUDGE_HYDRATE);
      if (!slice.length) return;
      hydrateBodies(ctx.workspaceId, ctx.poolId, slice);
      const before = slice.filter((member) => memberNeedsCall(member, ctx)).length;
      if (!before) continue;
      await judgeMembers(slice, ctx);
      const after = slice.filter((member) => memberNeedsCall(member, ctx)).length;
      if (after >= before) return;
    }
  }

  function recallHydrated(members, ctx) {
    if (!members.length || !ctx.poolId) return recallMembers(members, ctx);
    const recalled = [];
    for (let index = 0; index < members.length; index += PAGE) {
      const chunk = members.slice(index, index + PAGE);
      hydrateBodies(ctx.workspaceId, ctx.poolId, chunk);
      recalled.push(...recallMembers(chunk, ctx));
      for (const member of chunk) if (member.hasBody) member.body = '';
    }
    return recalled;
  }

  function tally(members, tags, question, workspaceId, maps) {
    const counts = { usable: 0, judged: 0, pending: 0, failed: 0, inflight: 0, open: 0 };
    for (const member of members) {
      if (!usable(member)) continue;
      counts.usable += 1;
      const rows = [...tags.map((tag) => chosenTag(workspaceId, member, tag, maps)), relevancePort ? chosenRelevance(workspaceId, member, question, maps) : null];
      const kind = rows.some((row) => row?.status === 'failed') ? 'failed'
        : rows.some((row) => !row) ? 'pending'
          : rows.some((row) => row.status === 'running') ? 'inflight'
            : 'judged';
      counts[kind] += 1;
      if (kind === 'pending' || kind === 'inflight') counts.open += 1;
    }
    return counts;
  }

  function recallMembers(members, { workspaceId, question, tags, maps }) {
    const recalled = [];
    for (const member of members) {
      if (!usable(member)) continue;
      const tagRows = tags.map((tag) => ({ tag, row: chosenTag(workspaceId, member, tag, maps) }));
      const tagHits = tagRows.filter((item) => item.row?.status === 'succeeded' && item.row?.matched).map((item) => item.tag.id);
      const terms = matchedTerms(member, question, tags);
      const relevance = chosenRelevance(workspaceId, member, question, maps);
      const verdict = relevance?.status === 'succeeded' ? relevance.verdict : null;
      const relevanceHit = verdict === 'direct' || verdict === 'background' ? verdict : null;
      if (!tagHits.length && !terms.length && !relevanceHit) continue;
      const usedBody = tagRows.some((item) => item.row?.pass === 'body' && item.row?.matched) || relevance?.pass === 'body';
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

  function judgmentSnapshot(workspaceId, members, tags, question, maps) {
    const rows = [];
    for (const member of members) {
      if (!usable(member)) continue;
      for (const tag of tags) {
        const row = chosenTag(workspaceId, member, tag, maps);
        if (!row) continue;
        rows.push({
          resourceType: member.resourceType, resourceId: member.resourceId, sourceVersion: member.sourceVersion,
          kind: 'tag', key: tag.id, status: row.status, matched: row.matched, verdict: '', inputHash: row.inputHash, definitionHash: tag.definitionHash,
        });
      }
      const relevance = chosenRelevance(workspaceId, member, question, maps);
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
  const haystack = `${member.title}\n${member.text}\n${member.body || ''}`;
  const anchors = [];
  const weak = [];
  const take = (term, subquestionId, source) => {
    if (!containsResearchTerm(haystack, term)) return;
    const hit = { term, subquestionId };
    if (researchTermAnchors(term, source)) anchors.push(hit);
    else weak.push(hit);
  };
  for (const query of question.queries || []) {
    for (const term of [query.phrase, ...(query.aliases || []), ...(query.entities || [])]) take(term, null, 'query');
  }
  for (const sub of question.subquestions) {
    for (const query of sub.queries || []) {
      for (const term of [query.phrase, ...(query.aliases || []), ...(query.entities || [])]) take(term, sub.id, 'query');
    }
  }
  for (const tag of tags) {
    const subquestionId = question.subquestions.find((sub) => sub.tagIds.includes(tag.id))?.id || null;
    for (const term of [...(tag.keywords || []), ...(tag.aliases || [])]) take(term, subquestionId, 'tag');
  }
  if (!anchors.length) return [];
  return [...anchors, ...weak];
}

function containsResearchTerm(haystack, term) {
  const raw = String(term || '').trim();
  if (!raw || !haystack) return false;
  if (/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(raw)) {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(haystack);
  }
  return normalize(haystack).includes(normalize(raw));
}

// Question phrases, aliases and entities are anchors. Tag words are anchors only
// when they are specific: at least three characters, or a Latin token of four
// or more with a word boundary. Two-character tag words such as 采用 or 价格 do
// not recall a story by themselves.
function researchTermAnchors(term, source) {
  const raw = String(term || '').trim();
  if (!raw) return false;
  if (source === 'query') return true;
  if (/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(raw)) return raw.length >= 4;
  return [...raw.replace(/\s+/g, '')].length >= 3;
}
