import {
  DailyReportDateQuerySchema,
  GenerateDailyBriefRequestSchema,
  GenerateDailyReportRequestSchema,
  SaveDailyTrackingQuestionsSchema,
  parseContract,
  HourlyDigestQuerySchema, GenerateHourlyDigestRequestSchema, InformationSearchInputSchema, InformationEvidenceInputSchema,
  HourlySnapshotQuerySchema,
  HourlyDigestIndexQuerySchema,
  DailyBriefWindowQuerySchema,
} from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';
import { createPreparedSlotStore } from '../http/prepared-slots.js';
import { sendOffthreadJson } from '../http/offthread-json.js';
import { reportReadingIndexSlot, reportTreeSlot } from '../../../../packages/runtime/src/web-snapshot-jobs.js';
import {TreeManifestQuerySchema,TreeNodeQuerySchema,TreeWindowQuerySchema,ReadingHourIndexQuerySchema} from '../../../../packages/contracts/src/information-tree.js';

function briefView(brief) {
  if(!brief) return null;
  const {providerId,modelId,...view}=brief;
  return view;
}

const reportMisses = new Set();

function logReportSlotMiss(line) {
  if (reportMisses.has(line)) return;
  reportMisses.add(line);
  console.log(`[web] report-slot-miss ${line}`);
}

function sendReportBuffer(slots, request, response, key, miss) {
  if (!key) {
    logReportSlotMiss(miss);
    slots.send(request, response, 'report-slot-miss', {
      headers: { 'Cache-Control': 'no-store' },
      allow304: false,
    });
    return;
  }
  slots.send(request, response, key, { headers: { 'Cache-Control': 'no-store' } });
}

export function createReportRoutes({ slots = createPreparedSlotStore(), offthread = null } = {}) {
  return [
    {method:'GET',path:'/api/v1/reports/tree',handler({request,response,url,identity}) {
      const window=parseContract(TreeManifestQuerySchema,{startAt:url.searchParams.get('startAt'),endAt:url.searchParams.get('endAt'),view:url.searchParams.get('view') || undefined,information:url.searchParams.get('information') || undefined});
      const key=reportTreeSlot(window);
      if (key) {
        sendReportBuffer(slots, request, response, key, '');
        return;
      }
      const workspace=identity?.device?.workspaceId || 'local';
      logReportSlotMiss(`path=tree view=${window.view || ''} information=${window.information || ''} start=${window.startAt} end=${window.endAt}`);
      return sendOffthreadJson(offthread, request, response, { kind: 'tree-list', workspace, window }, { 'Cache-Control': 'no-store' });
    }},
    {method:'GET',path:'/api/v1/reports/tree/edition',handler({request,response,url,identity}) {
      const {id}=parseContract(TreeNodeQuerySchema,{id:url.searchParams.get('id')});
      const workspace=identity?.device?.workspaceId || 'local';
      logReportSlotMiss('path=edition');
      return sendOffthreadJson(offthread, request, response, { kind: 'tree-edition', workspace, id }, { 'Cache-Control': 'no-store' });
    }},
    {method:'GET',path:'/api/v1/reports/tree/node',handler({response,services,url,identity}) {
      const {id}=parseContract(TreeNodeQuerySchema,{id:url.searchParams.get('id')});
      const node=services.informationTree.node(identity?.device?.workspaceId || 'local',id);json(response,node ? 200 : 404,{ok:Boolean(node),node});
    }},
    {method:'GET',path:'/api/v1/reports/tree/children',handler({response,services,url,identity}) {
      const {id}=parseContract(TreeNodeQuerySchema,{id:url.searchParams.get('id')});
      const children=services.informationTree.children(identity?.device?.workspaceId || 'local',id);json(response,children ? 200 : 404,{ok:Boolean(children),children});
    }},
    {method:'GET',path:'/api/v1/reports/reading-hour',handler({request,response,services,url,identity}) {
      if(!services.readingHour) return json(response,404,{ok:false});
      const startAt=Number(url.searchParams.get('startAt'));
      const endAt=Number(url.searchParams.get('endAt'));
      const scope=url.searchParams.get('scope') || 'hour';
      if(!Number.isFinite(startAt) || !Number.isFinite(endAt)) return json(response,400,{ok:false});
      const workspace=identity?.device?.workspaceId || 'local';
      logReportSlotMiss(`path=reading-hour scope=${scope}`);
      return sendOffthreadJson(offthread, request, response, { kind: 'reading-hour', workspace, startAt, endAt, scope }, { 'Cache-Control': 'no-store' });
    }},
    {method:'GET',path:'/api/v1/reports/reading-hour/index',handler({request,response,services,url,identity}) {
      if(!services.readingHour) return json(response,404,{ok:false});
      const startRaw=url.searchParams.get('startAt');
      const endRaw=url.searchParams.get('endAt');
      const input=parseContract(ReadingHourIndexQuerySchema,{
        ...(startRaw===null ? {} : {startAt:Number(startRaw)}),
        ...(endRaw===null ? {} : {endAt:Number(endRaw)}),
        scope:url.searchParams.get('scope') || 'hour',
      });
      const key=reportReadingIndexSlot(input);
      if (key) {
        sendReportBuffer(slots, request, response, key, '');
        return;
      }
      const workspace=identity?.device?.workspaceId || 'local';
      logReportSlotMiss(`path=reading-index scope=${input.scope} start=${input.startAt} end=${input.endAt}`);
      return sendOffthreadJson(offthread, request, response, {
        kind: 'reading-index',
        workspace,
        startAt: input.startAt,
        endAt: input.endAt,
        scope: input.scope,
      }, { 'Cache-Control': 'no-store' });
    }},
    {method:'GET',path:'/api/v1/reports/reading-hour/snapshot',handler({response,services,url,identity}) {
      if(!services.readingHour) return json(response,404,{ok:false});
      const snapshot=services.readingHour.get(identity?.device?.workspaceId || 'local',url.searchParams.get('id') || '');
      json(response,snapshot ? 200 : 404,{ok:Boolean(snapshot),snapshot});
    }},
    {method:'GET',path:'/api/v1/reports/tree/editorial',handler({response,services,url,identity}) {
      const window=parseContract(TreeWindowQuerySchema,{startAt:url.searchParams.get('startAt'),endAt:url.searchParams.get('endAt')});
      const editorial=services.informationTree.editorial?.(identity?.device?.workspaceId || 'local',window) || null;
      json(response,editorial ? 200 : 404,{ok:Boolean(editorial),editorial});
    }},
    {method:'GET',path:'/api/v1/reports/daily/brief/window',handler({response,services,url}) {
      const input=parseContract(DailyBriefWindowQuerySchema,{date:url.searchParams.get('date') || '',revision:Number(url.searchParams.get('revision') ?? NaN)});
      json(response,200,{ok:true,...services.report.getDailyBriefWindow('local',input)});
    }},
    {method:'GET',path:'/api/v1/reports/hourly/index',handler({response,services,url}) {
      const input=parseContract(HourlyDigestIndexQuerySchema,{startAt:Number(url.searchParams.get('startAt') ?? NaN),endAt:Number(url.searchParams.get('endAt') ?? NaN)});
      json(response,200,{ok:true,...services.report.getHourlyDigestIndex('local',input)});
    }},
    {method:'GET',path:'/api/v1/reports/hourly/snapshot',handler({response,services,url}) {
      const input=parseContract(HourlySnapshotQuerySchema,{snapshotId:url.searchParams.get('snapshotId')});
      const digest=services.report.getHourlySnapshotDigest('local',input.snapshotId);
      json(response,digest ? 200 : 404,{ok:Boolean(digest),digest});
    }},
    {method:'GET',path:'/api/v1/reports/hourly',handler({response,services,url}) {
      const input=parseContract(HourlyDigestQuerySchema,{hourStart:Number(url.searchParams.get('hourStart') ?? NaN)});
      json(response,200,{ok:true,digest:services.report.getHourlyDigest('local',input.hourStart)});
    }},
    {method:'GET',path:'/api/v1/reports/hourly/search',handler({response,services,url}) {
      const input=parseContract(InformationSearchInputSchema,{startAt:Number(url.searchParams.get('startAt') ?? NaN),endAt:Number(url.searchParams.get('endAt') ?? NaN),
        query:url.searchParams.get('query') || '',limit:Number(url.searchParams.get('limit') || 40),offset:Number(url.searchParams.get('offset') || 0)});
      json(response,200,{ok:true,...services.report.searchInformation('local',input)});
    }},
    {method:'GET',path:'/api/v1/reports/hourly/evidence',handler({response,services,url}) {
      const input=parseContract(InformationEvidenceInputSchema,Object.fromEntries(['snapshotId','materialId','paragraphId','materialHash','materialVersion'].map(k=>[k,url.searchParams.get(k)])));
      const evidence=services.report.getInformationEvidence('local',input);
      json(response,evidence ? 200 : 404,{ok:Boolean(evidence),evidence});
    }},
    {method:'POST',path:'/api/v1/reports/hourly/generate',access:'desktop',async handler({request,response,services}) {
      const input=parseContract(GenerateHourlyDigestRequestSchema,await readJson(request));
      json(response,202,{ok:true,job:services.runtime.requestHourlyDigest(input)});
    }},
    {method:'GET',path:'/api/v1/reports/daily/tracking',handler({response,services}) {
      json(response,200,{ok:true,questions:services.report.getTrackingQuestions('local')});
    }},
    {method:'PUT',path:'/api/v1/reports/daily/tracking',access:'desktop',async handler({request,response,services}) {
      const value=parseContract(SaveDailyTrackingQuestionsSchema,await readJson(request));
      json(response,200,{ok:true,questions:services.report.saveTrackingQuestions('local',value)});
    }},
    {method:'GET',path:'/api/v1/reports/daily/analysis/status',handler({response,services,url}) {
      const query=parseContract(DailyReportDateQuerySchema,{date:url.searchParams.get('date') || ''});
      json(response,200,{ok:true,analysis:services.report.getAnalysisStatus('local',query.date)});
    }},
    {method:'GET',path:'/api/v1/reports/daily/evidence',handler({response,services,url}) {
      const query=parseContract(DailyReportDateQuerySchema,{date:url.searchParams.get('date') || ''});
      const evidence=services.report.getDailyEvidence('local',query.date,Number(url.searchParams.get('revision')),url.searchParams.get('materialId'),url.searchParams.get('paragraphId'));
      json(response,evidence ? 200 : 404,{ok:Boolean(evidence),evidence});
    }},
    {
      method: 'GET',
      path: '/api/v1/reports/daily/latest',
      handler({ response, services }) {
        json(response, 200, { ok: true, report: services.report.getLatestDailyReport('local') });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/reports/daily',
      handler({ response, services, url }) {
        const query = parseContract(DailyReportDateQuerySchema, {
          date: url.searchParams.get('date') || '',
        });
        json(response, 200, { ok: true, report: services.report.getDailyReport('local', query.date) });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/reports/daily/latest/brief',
      handler({ response, services }) {
        json(response, 200, { ok: true, brief: briefView(services.report.getLatestDailyBrief('local')) });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/reports/daily/briefs',
      handler({ response, services, url }) {
        const limit = Number(url.searchParams.get('limit') || 60);
        json(response, 200, { ok: true, briefs: services.report.listDailyBriefs('local', limit).map(briefView) });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/reports/daily/brief',
      handler({ response, services, url }) {
        const query = parseContract(DailyReportDateQuerySchema, {
          date: url.searchParams.get('date') || '',
        });
        json(response, 200, { ok: true, brief: briefView(services.report.getDailyBrief('local', query.date)) });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/reports/daily/brief/generate',
      access: 'desktop',
      async handler({ request, response, services }) {
        const body = parseContract(GenerateDailyBriefRequestSchema, await readJson(request));
        if(!body.mode || body.mode==='refresh') {
          const job=services.runtime.requestDailyReport({reportDate:body.date});
          json(response,202,{ok:true,job});return;
        }
        const report = body.date
          ? services.report.getDailyReport('local', body.date)
          : services.report.getLatestDailyReport('local');
        if (!report) {
          json(response, 404, { ok: false, error: '日报不存在' });
          return;
        }
        const job = services.runtime.requestDailyBrief({ reportId: report.id,mode:body.mode,
          ...(body.mode==='resume' ? {sourceReportUpdatedAt:report.updatedAt} : {}) });
        json(response, 202, { ok: true, job });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/reports/daily/generate',
      access: 'desktop',
      async handler({ request, response, services }) {
        const body = parseContract(GenerateDailyReportRequestSchema, await readJson(request));
        const job = services.runtime.requestDailyReport({ reportDate: body.date });
        json(response, 202, { ok: true, job });
      },
    },
  ];
}
