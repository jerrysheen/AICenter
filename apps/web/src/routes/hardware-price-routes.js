import { parseContract } from '../../../../packages/contracts/src/index.js';
import { HardwarePriceListQuerySchema } from '../../../../packages/contracts/src/hardware-prices.js';
import { json } from '../http/response.js';
import { labelEventLoop } from '../http/event-loop-blocks.js';
import { createStaleReadCache, HARDWARE_PRICE_CACHE_TTL_MS } from '../http/stale-read-cache.js';
const workspace = identity => identity?.device?.workspaceId || 'local';
export function createHardwarePriceRoutes() {
  const priceCache = createStaleReadCache({ ttlMs: HARDWARE_PRICE_CACHE_TTL_MS });
  return [
    {method:'GET',path:'/api/v1/hardware-prices',async handler({response,services,url,identity}) {
      const raw=Object.fromEntries(url.searchParams.entries());
      const refresh=raw.refresh==='1' || raw.refresh==='true';
      delete raw.refresh;
      const query=parseContract(HardwarePriceListQuerySchema,raw);
      const workspaceId=workspace(identity);
      const key=`${workspaceId}|${JSON.stringify(query)}`;
      const view=await priceCache.get(key, () => {
        const leave=labelEventLoop('hardware-prices.list');
        try { return services.hardwarePrices.list(workspaceId, query); }
        finally { leave(); }
      }, { refresh });
      json(response,200,{ok:true,...view});
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
