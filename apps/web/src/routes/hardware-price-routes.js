import { parseContract } from '../../../../packages/contracts/src/index.js';
import { HardwarePriceListQuerySchema } from '../../../../packages/contracts/src/hardware-prices.js';
import { json } from '../http/response.js';
import { labelEventLoop } from '../http/event-loop-blocks.js';
import { prepareJsonBody, prepareJsonText, sendPreparedJson } from '../http/prepared-json.js';
import { createStaleReadCache, HARDWARE_PRICE_CACHE_TTL_MS } from '../http/stale-read-cache.js';
import { HARDWARE_PRICE_SNAPSHOT_KEY, HARDWARE_PRICE_SNAPSHOT_TTL_MS } from '../../../../packages/runtime/src/web-snapshot-jobs.js';
const workspace = identity => identity?.device?.workspaceId || 'local';

function ifNoneMatch(request, etag) {
  const header = String(request?.headers?.['if-none-match'] || '').trim();
  if (!header) return false;
  if (header === '*') return true;
  const wanted = etag.replace(/^W\//, '');
  return header.split(',').some((part) => part.trim().replace(/^W\//, '') === wanted);
}

export function createHardwarePriceRoutes() {
  const priceCache = createStaleReadCache({ ttlMs: HARDWARE_PRICE_CACHE_TTL_MS, refreshLeadMs: 10_000 });
  return [
    {method:'GET',path:'/api/v1/hardware-prices',async handler({request,response,services,url,identity}) {
      const raw=Object.fromEntries(url.searchParams.entries());
      const refresh=raw.refresh==='1' || raw.refresh==='true';
      delete raw.refresh;
      const query=parseContract(HardwarePriceListQuerySchema,raw);
      const workspaceId=workspace(identity);
      const hot=!query.category && !query.snapshotId && query.limit===500 && !refresh;
      const snapshot=hot ? services.runtimeSnapshots?.readSnapshotBody?.(workspaceId, HARDWARE_PRICE_SNAPSHOT_KEY) : null;
      const snapshotFresh=snapshot && Date.now()-snapshot.generatedAt < HARDWARE_PRICE_SNAPSHOT_TTL_MS;
      const key=snapshotFresh ? `snap|${workspaceId}|${snapshot.generatedAt}` : `${workspaceId}|${JSON.stringify(query)}`;
      const prepared=await priceCache.get(key, async () => {
        if (snapshotFresh) return prepareJsonText(snapshot.body);
        const leave=labelEventLoop('hardware-prices.list');
        try { return prepareJsonBody({ok:true,...services.hardwarePrices.list(workspaceId, query)}); }
        finally { leave(); }
      }, { refresh });
      const headers={ ETag: prepared.etag, 'Cache-Control': 'no-store' };
      if (!refresh && ifNoneMatch(request, prepared.etag)) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      sendPreparedJson(request, response, 200, prepared, headers);
    }},
    {method:'GET',path:/^\/api\/v1\/hardware-prices\/series\/([a-f0-9]{64})$/,handler({response,services,params,identity}) {
      const detail=services.hardwarePrices.detail(workspace(identity),params.values[0]);
      json(response,detail?200:404,detail?{ok:true,detail}:{ok:false,error:'报价不存在'});
    }},
    {method:'GET',path:/^\/api\/v1\/hardware-prices\/snapshots\/([a-f0-9-]{36})$/,handler({response,services,params,identity}) {
      const snapshot=services.hardwarePrices.snapshot(workspace(identity),params.values[0]);
      json(response,snapshot?200:404,snapshot?{ok:true,snapshot}:{ok:false,error:'价表快照不存在'});
    }},
    {method:'POST',path:'/api/v1/feed/trendforce/migrate',access:'desktop',handler({response,services,identity}) {
      const job=services.runtime.requestTrendforceMigration({workspaceId:workspace(identity)});json(response,202,{ok:true,jobId:job.id});
    }},
  ];
}
