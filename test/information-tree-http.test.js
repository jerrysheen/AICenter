import test from 'node:test';
import assert from 'node:assert/strict';
import {createReportRoutes} from '../apps/web/src/routes/report-routes.js';
import {gunzipSync} from 'node:zlib';
test('tree routes delegate scoped read-only operations and reject oversized windows',async()=>{
  const routes=createReportRoutes().filter(r=>r.path.startsWith('/api/v1/reports/tree')),calls=[];
  const services={informationTree:{list:(workspace,input)=>{calls.push({workspace,input});return {hours:[],days:[]};},edition:(workspace,id)=>{calls.push({workspace,id});return null;},node:(workspace,id)=>{calls.push({workspace,id});return null;},children:(workspace,id)=>{calls.push({workspace,id});return null;}}};
  const response={writeHead(){},end(){}};
  const identity={device:{workspaceId:'other'}};
  for(const r of routes)await r.handler({response,services,identity,url:new URL(`http://localhost${r.path}?startAt=1&endAt=3600001&id=missing`)});
  assert.equal(calls.length,4);assert.ok(calls.every(c=>c.workspace==='other'));assert.ok(routes.every(r=>r.method==='GET'));
  assert.throws(()=>routes[0].handler({response,services,identity,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=9999999999999')}));
});

test('reading manifest negotiates gzip without allowing public response caching',async()=>{
  const route=createReportRoutes().find(r=>r.path==='/api/v1/reports/tree');let headers,body,input;
  const response={req:{headers:{'accept-encoding':'gzip'}},writeHead(status,value){assert.equal(status,200);headers=value;},end(value){body=value;}};
  await route.handler({response,identity:{device:{workspaceId:'phone'}},url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=reading'),services:{informationTree:{list(workspace,value){assert.equal(workspace,'phone');input=value;return {hours:[],information:Array.from({length:200},(_,i)=>({id:`node:${i}`}))};}}}});
  assert.equal(input.view,'reading');assert.equal(input.information,undefined);assert.equal(headers['Content-Encoding'],'gzip');assert.equal(headers['Cache-Control'],'no-store');
  assert.equal(JSON.parse(gunzipSync(body)).information.length,200);
  assert.throws(()=>route.handler({response,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=unknown')}));
  assert.throws(()=>route.handler({response,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=index&information=2')}));
  await route.handler({response,identity:{device:{workspaceId:'phone'}},url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=index&information=1'),services:{informationTree:{list(workspace,value){assert.equal(workspace,'phone');input=value;return {hours:[],days:[],information:[]};}}}});
  assert.equal(input.view,'index');assert.equal(input.information,'1');
});
