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
import {TreeManifestQuerySchema,TreeNodeQuerySchema,TreeWindowQuerySchema} from '../../../../packages/contracts/src/information-tree.js';

function briefView(brief) {
  if(!brief) return null;
  const {providerId,modelId,...view}=brief;
  return view;
}

export function createReportRoutes() {
  return [
    {method:'GET',path:'/api/v1/reports/tree',handler({response,services,url,identity}) {
      const window=parseContract(TreeManifestQuerySchema,{startAt:url.searchParams.get('startAt'),endAt:url.searchParams.get('endAt'),view:url.searchParams.get('view') || undefined,information:url.searchParams.get('information') || undefined});
      json(response,200,{ok:true,...services.informationTree.list(identity?.device?.workspaceId || 'local',window)},{},{compress:true});
    }},
    {method:'GET',path:'/api/v1/reports/tree/edition',handler({response,services,url,identity}) {
      const {id}=parseContract(TreeNodeQuerySchema,{id:url.searchParams.get('id')});
      const result=services.informationTree.edition(identity?.device?.workspaceId || 'local',id);
      json(response,result ? 200 : 404,{ok:Boolean(result),...result},{},{compress:true});
    }},
    {method:'GET',path:'/api/v1/reports/tree/node',handler({response,services,url,identity}) {
      const {id}=parseContract(TreeNodeQuerySchema,{id:url.searchParams.get('id')});
      const node=services.informationTree.node(identity?.device?.workspaceId || 'local',id);json(response,node ? 200 : 404,{ok:Boolean(node),node});
    }},
    {method:'GET',path:'/api/v1/reports/tree/children',handler({response,services,url,identity}) {
      const {id}=parseContract(TreeNodeQuerySchema,{id:url.searchParams.get('id')});
      const children=services.informationTree.children(identity?.device?.workspaceId || 'local',id);json(response,children ? 200 : 404,{ok:Boolean(children),children});
    }},
    {method:'GET',path:'/api/v1/reports/reading-hour',handler({response,services,url,identity}) {
      if(!services.readingHour) return json(response,404,{ok:false});
      const window={startAt:Number(url.searchParams.get('startAt')),endAt:Number(url.searchParams.get('endAt'))};
      const scope=url.searchParams.get('scope') || 'hour';
      const workspace=identity?.device?.workspaceId || 'local';
      const snapshot=services.readingHour.forWindow(workspace,window,scope);
      json(response,snapshot ? 200 : 404,{ok:Boolean(snapshot),snapshot});
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
