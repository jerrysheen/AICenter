import { parseContract } from '../../../../packages/contracts/src/index.js';
import { HardwarePriceListQuerySchema } from '../../../../packages/contracts/src/hardware-prices.js';
import { json } from '../http/response.js';
import { createPreparedSlotStore } from '../http/prepared-slots.js';
import { sendOffthreadJson } from '../http/offthread-json.js';
import { HARDWARE_PRICE_SNAPSHOT_KEY, hardwarePriceCategoryKey } from '../../../../packages/runtime/src/web-snapshot-jobs.js';
const workspace = identity => identity?.device?.workspaceId || 'local';

export function createHardwarePriceRoutes({ slots = createPreparedSlotStore(), offthread = null } = {}) {
  return [
    {method:'GET',path:'/api/v1/hardware-prices',handler({request,response,url,identity}) {
      const raw=Object.fromEntries(url.searchParams.entries());
      const refresh=raw.refresh==='1' || raw.refresh==='true';
      delete raw.refresh;
      const query=parseContract(HardwarePriceListQuerySchema,raw);
      if (query.snapshotId) {
        return sendOffthreadJson(offthread, request, response, {
          kind: 'hardware-list',
          workspace: workspace(identity),
          query: {
            snapshotId: query.snapshotId,
            limit: query.limit,
            ...(query.category ? { category: query.category } : {}),
          },
        }, { 'Cache-Control': 'no-store' });
      }
      if (query.category) {
        slots.send(request, response, hardwarePriceCategoryKey(query.category), {
          headers: { 'Cache-Control': 'no-store' },
          allow304: !refresh,
        });
        return;
      }
      slots.send(request, response, HARDWARE_PRICE_SNAPSHOT_KEY, {
        headers: { 'Cache-Control': 'no-store' },
        allow304: !refresh,
      });
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
