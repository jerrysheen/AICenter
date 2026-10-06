import { parseContract } from '../../../../packages/contracts/src/index.js';
import { HardwarePriceListQuerySchema } from '../../../../packages/contracts/src/hardware-prices.js';
import { json } from '../http/response.js';
const workspace = identity => identity?.device?.workspaceId || 'local';
export function createHardwarePriceRoutes() {
  return [
    {method:'GET',path:'/api/v1/hardware-prices',handler({response,services,url,identity}) {
      const query=parseContract(HardwarePriceListQuerySchema,Object.fromEntries(url.searchParams.entries()));
      json(response,200,{ok:true,...services.hardwarePrices.list(workspace(identity),query)});
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
