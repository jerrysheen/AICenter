import test from 'node:test';
import assert from 'node:assert/strict';
import {createReportRoutes} from '../apps/web/src/routes/report-routes.js';
test('tree routes delegate scoped read-only operations and reject oversized windows',()=>{
  const routes=createReportRoutes().filter(r=>r.path.startsWith('/api/v1/reports/tree')),calls=[];
  const services={informationTree:{list:(workspace,input)=>{calls.push({workspace,input});return {hours:[],days:[]};},node:(workspace,id)=>{calls.push({workspace,id});return null;},children:(workspace,id)=>{calls.push({workspace,id});return null;}}};
  const response={writeHead(){},end(){}};
  const identity={device:{workspaceId:'other'}};
  for(const r of routes)r.handler({response,services,identity,url:new URL(`http://localhost${r.path}?startAt=1&endAt=3600001&id=missing`)});
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.workspace==='other'));assert.ok(routes.every(r=>r.method==='GET'));
  assert.throws(()=>routes[0].handler({response,services,identity,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=9999999999999')}));
});
