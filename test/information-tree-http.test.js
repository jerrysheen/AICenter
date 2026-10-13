import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createReportRoutes} from '../apps/web/src/routes/report-routes.js';
import {createPreparedSlotStore, packPreparedJson} from '../apps/web/src/http/prepared-slots.js';
import {reportPreparedWindows, REPORT_TREE_INDEX_KEY} from '../packages/runtime/src/web-snapshot-jobs.js';

test('tree routes keep node reads and reject oversized windows without listing on the request',async()=>{
  const routes=createReportRoutes().filter(r=>r.path.startsWith('/api/v1/reports/tree')),calls=[];
  const services={informationTree:{list:(workspace,input)=>{calls.push({workspace,input});return {hours:[],days:[]};},edition:(workspace,id)=>{calls.push({workspace,id});return null;},node:(workspace,id)=>{calls.push({workspace,id});return null;},children:(workspace,id)=>{calls.push({workspace,id});return null;}}};
  const response={writeHead(){},end(){}};
  const identity={device:{workspaceId:'other'}};
  for(const r of routes)await r.handler({request:{headers:{}},response,services,identity,url:new URL(`http://localhost${r.path}?startAt=1&endAt=3600001&id=missing`)});
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.workspace==='other' && c.id==='missing'));assert.ok(routes.every(r=>r.method==='GET'));
  assert.throws(()=>routes[0].handler({response,services,identity,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=9999999999999')}));
});

test('reading manifest serves a prepared gzip buffer and does not list on a miss',async()=>{
  const slots=createPreparedSlotStore();
  const payload={ok:true,hours:[],information:Array.from({length:200},(_,i)=>({id:`node:${i}`}))};
  const raw=Buffer.from(JSON.stringify(payload));
  const prepared=packPreparedJson(raw);
  prepared.gzipped=gzipSync(raw);
  slots.publish(REPORT_TREE_INDEX_KEY, prepared);
  const route=createReportRoutes({slots}).find(r=>r.path==='/api/v1/reports/tree');
  let headers,body,listed=0;
  const response={req:{headers:{'accept-encoding':'gzip'}},writeHead(status,value){assert.equal(status,200);headers=value;},end(value){body=value;}};
  const windows=reportPreparedWindows();
  const services={informationTree:{list(){listed+=1;return {hours:[],information:[]};}}};
  await route.handler({request:{headers:{'accept-encoding':'gzip'}},response,services,url:new URL(`http://localhost/api/v1/reports/tree?view=index&startAt=${windows.week.startAt}&endAt=${windows.week.endAt}`)});
  assert.equal(listed,0);assert.equal(headers['Content-Encoding'],'gzip');assert.equal(headers['Cache-Control'],'no-store');
  assert.equal(JSON.parse(gunzipSync(body)).information.length,200);
  assert.throws(()=>route.handler({response,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=unknown')}));
  assert.throws(()=>route.handler({response,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=index&information=2')}));
  let missed;
  const missResponse={writeHead(_status,value){missed=value;},end(value){body=value;}};
  await route.handler({request:{headers:{}},response:missResponse,services,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=index&information=1')});
  assert.equal(listed,0);assert.equal(missed['Cache-Control'],'no-store');assert.equal(JSON.parse(Buffer.from(body).toString('utf8')).pending,true);
});
