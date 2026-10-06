import {
  inHalfOpenWindow,
  resolveDailyConfig,
  resolveDailyTimeContext,
  resolveReportDate,
} from './daily-window.js';
import { DailyBriefCandidateSchema, ReferenceInputSchema, InformationSearchInputSchema, InformationEvidenceInputSchema, HourlyDigestIndexQuerySchema, HourlyDigestIndexSchema } from '../../contracts/src/index.js';
import {prepareDailyMaterials,contextMaterials,materialHash} from './daily-materials.js';
import { DailyBriefWindowQuerySchema, DailyBriefWindowSchema } from '../../contracts/src/report.js';
import {editorialReadingItems} from './brief-editorial.js';

const MARKET_NOTE = '这是生成日报时能够取得的最新行情状态，不是刚好截止到日报窗口结束的历史快照。';

function clip(value, max) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max) : text;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function lightBoard(board, key, endAt) {
  const indices = Array.isArray(board?.indices) ? board.indices.slice(0, 100).map((quote) => ({
    symbol: String(quote.symbol || ''),
    name: String(quote.name || ''),
    lastPrice: finiteOrNull(quote.lastPrice),
    changePct: finiteOrNull(quote.changePct),
    asOf: Number.isInteger(quote.asOf) ? quote.asOf : null,
  })) : [];
  const asOf = [...indices,...(board?.watchlist || [])].reduce((latest, quote) => Math.max(latest, quote.asOf || 0), 0) || null;
  return {
    board: key,
    ...(board?.calendar ? {calendar:board.calendar} : {}),
    mode: board?.mode === 'live' || board?.mode === 'partial' ? board.mode : 'unavailable',
    fetchedAt: Number.isInteger(board?.fetchedAt) ? board.fetchedAt : null,
    asOf,
    observations: (board?.watchlist || []).slice(0,300).map(quote=>Object.fromEntries(
      ['symbol','name','lastPrice','prevClose','previousClose','changePct','asOf','tradeDate','currency','unit','group','assetClass','summary','fetchedAt','session','expiry'].filter(k=>quote[k]!==undefined).map(k=>[k,quote[k]]))),
    groups: (board?.groups || []).slice(0,100),
    stale: asOf===null || (Number.isFinite(endAt) && asOf<endAt-36*3600000),
    afterWindow: Number.isFinite(endAt) && (asOf>endAt || (board?.watchlist || []).some(q=>q.asOf>endAt)),
    indices,
    note: `${MARKET_NOTE}${board?.note ? ` ${board.note}` : ''}`.slice(0,1000),
  };
}

function unavailableBoard(key) {
  return lightBoard(null, key);
}

export function createReportService({
  reportRepository,
  feedService,
  mediaPort = null,
  tradingService,
  staticSignalPort,
  strategyPort = null,
  sourceReadinessPort = null,
  defaultConfig = resolveDailyConfig({}),
  now = () => Date.now(),
}) {
  if (!reportRepository || !feedService || !tradingService) {
    throw new Error('report service requires report, feed, and trading ports');
  }

  return Object.freeze({
    getHourlyDigest(workspaceId,hourStart) {return reportRepository.getHourlyDigest(workspaceId || 'local',hourStart);},
    getHourlySnapshotDigest(workspaceId,snapshotId) {return reportRepository.getHourlySnapshot(workspaceId || 'local',snapshotId)?.digest || null;},
    listHourlyDigests(workspaceId,startAt,endAt) {return reportRepository.listHourlyDigests(workspaceId || 'local',startAt,endAt);},
    getHourlyDigestIndex(workspaceId,raw) {
      const input=HourlyDigestIndexQuerySchema.parse(raw);
      const rows=reportRepository.listHourlyDigestIndex(workspaceId || 'local',input.startAt,input.endAt),byHour=new Map(rows.map(r=>[r.hourStart,r]));
      const hours=[];
      for(let start=Math.ceil(input.startAt/3600000)*3600000;start+3600000<=Math.min(input.endAt,now());start+=3600000) {
        hours.push(byHour.get(start) || {hourStart:start,id:null,generatedAt:null,itemCount:0,status:'not-started',updatedAt:0,
          readable:false,draftId:null,draftItemCount:0,phase:'not-started',unread:0,failed:0});
      }
      return HourlyDigestIndexSchema.parse({timezone:defaultConfig.timezone,hours:hours.reverse()});
    },
    searchInformation(workspaceId,raw) {
      const input=InformationSearchInputSchema.parse(raw);
      const digests=reportRepository.listHourlyInformationDigests(workspaceId || 'local',Math.floor(input.startAt/3600000)*3600000,input.endAt);
      const matches=digests.flatMap(d=>d.items.map(i=>({...i,hourStart:d.window.startAt}))).filter(i=>
        i.occurredAt>=input.startAt && i.occurredAt<input.endAt && (!input.query || i.sentence.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())));
      return {items:matches.slice(input.offset,input.offset+input.limit),total:matches.length,
        nextOffset:input.offset+input.limit<matches.length ? input.offset+input.limit : null,
        hours:digests.map(d=>({id:d.id,window:d.window,itemCount:d.items.length,
          available:d.coverage.reduce((s,c)=>s+c.available,0),read:d.coverage.reduce((s,c)=>s+(c.read || 0),0),
          unread:d.coverage.reduce((s,c)=>s+(c.unread || 0),0),failed:d.coverage.reduce((s,c)=>s+c.failed,0),
          warnings:[...d.warnings,...(d.editorial?.status==='failed' ? [d.editorial.message] : [])]})),
        warnings:digests.length ? ['摘选只代表已采集、已处理材料；没有记录的小时不是没有事件。'] : ['所选窗口尚无小时摘选。']};
    },
    getInformationEvidence(workspaceId,raw) {
      const parsed=InformationEvidenceInputSchema.safeParse(raw);
      if(!parsed.success) return null;
      const e=parsed.data,snapshot=reportRepository.getHourlySnapshot(workspaceId || 'local',e.snapshotId);
      const m=snapshot?.frozen.materials.find(m=>m.id===e.materialId);
      if(!m || m.hash!==e.materialHash || m.version!==e.materialVersion) return null;
      const index=m.paragraphs.findIndex(p=>p.id===e.paragraphId);
      if(index<0) return null;
      return {material:{...m,paragraphs:undefined},paragraph:m.paragraphs[index],context:m.paragraphs.slice(Math.max(0,index-1),index+2)};
    },
    getTrackingQuestions(workspaceId='local') { return reportRepository.getTrackingQuestions(workspaceId); },
    saveTrackingQuestions(workspaceId='local',value) { return reportRepository.saveTrackingQuestions(workspaceId,value); },
    getAnalysisStatus(workspaceId,reportDate) { return reportRepository.getAnalysisStatus(workspaceId,reportDate); },
    getDailyBriefWindow(workspaceId,raw) {
      const {date,revision}=DailyBriefWindowQuerySchema.parse(raw);
      const snapshot=reportRepository.getDailyBriefReferenceSnapshot(workspaceId || 'local',date,revision);
      const content=snapshot?.brief.generatedAt===revision ? snapshot.inputSnapshot?.report?.content : null;
      return DailyBriefWindowSchema.parse({window:content?.window || null,timezone:content?.timezone || null});
    },
    getDailyEvidence(workspaceId,reportDate,revision,materialId,paragraphId) {
      const snapshot=reportRepository.getDailyBriefReferenceSnapshot(workspaceId,reportDate,revision);
      if(!snapshot || snapshot.brief.generatedAt!==revision) return null;
      const info=snapshot.brief.informationItems?.flatMap(i=>i.evidence).find(e=>e.materialId===materialId && e.paragraphId===paragraphId);
      if(info) return this.getInformationEvidence(workspaceId,info);
      const material=snapshot.inputSnapshot?.report?.content?.materials?.find(m=>m.id===materialId);
      const paragraph=material?.paragraphs.find(p=>p.id===paragraphId);
      return paragraph ? {material:{...material,paragraphs:undefined},paragraph} : null;
    },
    getDailyReport(workspaceId, reportDate) {
      return reportRepository.getDailyReport(workspaceId || 'local', reportDate);
    },
    getLatestDailyReport(workspaceId) {
      return reportRepository.getLatestDailyReport(workspaceId || 'local');
    },
    listDailyReports(workspaceId, limit) {
      return reportRepository.listDailyReports(workspaceId || 'local', limit);
    },
    getDailyBrief(workspaceId, reportDate) {
      return reportRepository.getDailyBriefByDate(workspaceId || 'local', reportDate);
    },
    getLatestDailyBrief(workspaceId) {
      return reportRepository.getLatestDailyBrief(workspaceId || 'local');
    },
    listDailyBriefs(workspaceId, limit) {
      return reportRepository.listDailyBriefs(workspaceId || 'local', limit);
    },
    getDailyBriefItemReference(workspaceId, input) {
      const parsed = ReferenceInputSchema.safeParse(input);
      if (!parsed.success || parsed.data.resourceType !== 'daily-brief-item') return null;
      const { resourceId, revision } = parsed.data;
      const reportDate = resourceId.slice(0, 10);
      const candidateId = resourceId.slice(11);
      const snapshot = reportRepository.getDailyBriefReferenceSnapshot(workspaceId || 'local', reportDate,revision);
      if (!snapshot || snapshot.brief.generatedAt !== revision) return null;
      const topic=editorialReadingItems(snapshot.brief.editorial).find(t=>t.id===candidateId);
      const information=topic ? {...topic,sentence:topic.body} : snapshot.brief.informationItems?.find(i=>i.id===candidateId);
      const item = information ? {candidateId:information.id,type:'news',headline:information.title || information.sentence.slice(0,120),whyItMatters:information.sentence.slice(0,400),
        watchNext:'沿来源查看原文',body:information.sentence,evidence:information.evidence,occurredAt:information.occurredAt,sourceRefs:[]}
        : snapshot.brief.items.find((entry) => entry.candidateId === candidateId);
      if (!item) return null;
      const candidates = Array.isArray(snapshot.inputSnapshot?.candidates) ? snapshot.inputSnapshot.candidates : [];
      const candidate = DailyBriefCandidateSchema.safeParse(candidates.find((entry) => entry?.id === candidateId));
      return {
        reportDate,
        generatedAt: snapshot.brief.generatedAt,
        item,
        candidate: candidate.success ? candidate.data : null,
        ...(item.body ? {body:item.body,evidence:(item.evidence || []).map(e=>information ? this.getInformationEvidence(workspaceId,e) : this.getDailyEvidence(workspaceId,reportDate,revision,e.materialId,e.paragraphId)).filter(Boolean)} : {}),
      };
    },
    async generateDailyReport(input = {}) {
      const generatedAt = now();
      const timezone = input.timezone || defaultConfig.timezone;
      const cutoffHour = input.cutoffHour ?? defaultConfig.cutoffHour;
      const cutoffMinute = input.cutoffMinute ?? defaultConfig.cutoffMinute;
      const upcomingHours = defaultConfig.upcomingHours;
      const clock = Number.isInteger(input.scheduledFor) ? input.scheduledFor : generatedAt;
      const reportDate = input.reportDate || resolveReportDate(clock, { timezone, cutoffHour, cutoffMinute });
      const time = resolveDailyTimeContext({
        reportDate,
        timezone,
        cutoffHour,
        cutoffMinute,
        generatedAt,
        upcomingHours,
      });
      const workspaceId = input.workspaceId || 'local';
      const warnings = [];
      const prior=reportRepository.getDailyReport(workspaceId,time.reportDate);
      if(input.requestKey && prior?.content.generationKey===input.requestKey) return prior;
      warnings.push(...(sourceReadinessPort?.notes?.(workspaceId,time.contentWindow) || []));
      const prepared=await prepareDailyMaterials({feedService,mediaPort,workspaceId,time,frozenAt:generatedAt,perSourceLimit:input.newsLimit || 3000});
      warnings.push(...prepared.warnings);
      if(prepared.coverage.some(c=>c.omitted || c.failed || ['unavailable','failed'].includes(c.status))) warnings.push('部分来源材料未覆盖或读取失败，详见覆盖统计');
      const newsRows=prepared.materials.filter(m=>m.id.startsWith('feed:')).slice(0,500).map(m=>({
        id:m.id.slice(5),title:m.title,summary:m.paragraphs.map(p=>p.text).join('\n'),sourceUrl:m.sourceUrl,
        authorName:m.author,publishedAt:m.publishedAt,createdAt:m.obtainedAt,capturedAt:m.capturedAt,eventAt:m.eventAt,
      }));
      const news = newsRows.map((item) => ({
        id: item.id,
        title: clip(item.title, 1_000),
        summary: clip(item.summary, 500),
        ...(mediaPort?.briefForContentItem(workspaceId,item.id) ? { generatedBrief: mediaPort.briefForContentItem(workspaceId,item.id) } : {}),
        sourceUrl: item.sourceUrl || '',
        authorName: clip(item.authorName, 512),
        publishedAt: item.publishedAt ?? null,
        createdAt: item.createdAt,
        capturedAt: item.capturedAt ?? null,
        eventAt: item.eventAt ?? item.publishedAt ?? item.createdAt,
      }));

      let releases = [];
      let upcoming = [];
      if (staticSignalPort?.readBoard) {
        try {
          const board = await staticSignalPort.readBoard({
            from: time.upcomingWindow.startAt,
            to: Math.max(time.upcomingWindow.startAt, time.upcomingWindow.endAt - 1),
            focus: false,
            includeUndated: false,
            limit: 200,
            releaseLimit: 80,
          });
          releases = (board.releases || []).filter((release) => inHalfOpenWindow(release.publishedAt, time.contentWindow));
          upcoming = (board.upcoming || []).filter((event) => inHalfOpenWindow(event.scheduledAt, time.upcomingWindow));
          for (const health of board.sourceHealth || []) {
            if (health.status === 'unavailable' && health.note) warnings.push(clip(health.note, 500));
          }
        } catch (error) {
          warnings.push(clip(error instanceof Error ? error.message : error, 500) || '官方与日程读取失败');
        }
      } else {
        warnings.push('官方与日程端口未配置');
      }

      const markets = {};
      for (const board of ['cn', 'global']) {
        try {
          markets[board] = lightBoard(await tradingService.getBoard({ board }), board,time.contentWindow.endAt);
          if (markets[board].mode !== 'live') warnings.push(`${board} 行情不是完整快照`);
        } catch (error) {
          markets[board] = unavailableBoard(board);
          warnings.push(clip(error instanceof Error ? error.message : error, 500) || `${board} 行情读取失败`);
        }
      }

      let strategy = null;
      let strategyRef = null;
      if (strategyPort?.latestBefore) {
        const snapshot = await strategyPort.latestBefore(workspaceId, time.contentWindow.endAt);
        if (snapshot?.factors?.regime) {
          strategy = {
            strategyKey: snapshot.strategyKey,
            asOf: snapshot.asOf,
            regime: snapshot.factors.regime,
            factors: snapshot.factors,
          };
          strategyRef = { type: 'strategy-snapshot', id: snapshot.id, at: snapshot.asOf };
        } else {
          warnings.push('尚无可用的红利策略快照');
        }
      }

      const sourceRefs = [
        ...news.map((item) => ({ type: 'content-item', id: item.id, at: item.eventAt })),
        ...releases.map((release) => ({ type: 'official-release', id: release.releaseId, at: release.publishedAt })),
        ...upcoming.map((event) => ({ type: 'scheduled-event', id: event.eventId, at: event.scheduledAt })),
        ...['cn', 'global'].map((board) => ({
          type: 'market-snapshot',
          id: board,
          at: markets[board].asOf,
        })),
        ...(strategyRef ? [strategyRef] : []),
      ];
      const content = {
        schemaVersion:2,
        ...(input.requestKey ? {generationKey:input.requestKey} : {}),
        frozenAt:Math.max(generatedAt,now()),
        materials:prepared.materials,
        coverage:prepared.coverage,
        tracking:(reportRepository.getTrackingQuestions?.(workspaceId) || []).filter(q=>q.enabled).map(question=>({question,...(reportRepository.getPreviousTracking?.(workspaceId,time.reportDate,question) || {previous:null,previousDate:null})})),
        reportDate: time.reportDate,
        timezone,
        window: time.contentWindow,
        upcomingWindow: time.upcomingWindow,
        generatedAt,
        news,
        officialReleases: releases.slice(0, 200),
        upcoming: upcoming.slice(0, 200),
        market: { cn: markets.cn, global: markets.global },
        strategy,
        warnings: warnings.filter(Boolean).slice(0, 50),
      };
      content.materials.push(...contextMaterials(content));
      content.materialVersion=materialHash({materials:content.materials,tracking:content.tracking,window:content.window});
      return reportRepository.upsertDailyReport({
        workspaceId,
        reportDate: time.reportDate,
        status: warnings.length ? 'partial' : 'ready',
        content,
        sourceRefs,
      });
    },
  });
}
