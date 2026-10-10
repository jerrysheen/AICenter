import test from 'node:test';
import assert from 'node:assert/strict';
import {createReportRoutes} from '../apps/web/src/routes/report-routes.js';
import {formatYmd, zonedParts} from '../packages/domain/src/zoned-time.js';
import {gunzipSync} from 'node:zlib';

function callBrief(path, services) {
  const route = createReportRoutes().find((item) => item.path === path.split('?')[0]);
  let status = 0;
  let body = '';
  const response = { writeHead(code) { status = code; }, end(value = '') { body = value; } };
  route.handler({ response, services, url: new URL(`http://127.0.0.1${path}`) });
  return { status, body: JSON.parse(body) };
}

function dailyEdition(id, endAt, nodes) {
  return {
    id,
    layer: 'daily',
    status: 'ready',
    timezone: 'Asia/Shanghai',
    window: { startAt: endAt - 86_400_000, endAt },
    generatedAt: endAt + 1_000,
    roots: nodes.map((node) => node.id),
  };
}
test('tree routes delegate scoped read-only operations and reject oversized windows',()=>{
  const routes=createReportRoutes().filter(r=>r.path.startsWith('/api/v1/reports/tree')),calls=[];
  const services={informationTree:{list:(workspace,input)=>{calls.push({workspace,input});return {hours:[],days:[]};},edition:(workspace,id)=>{calls.push({workspace,id});return null;},node:(workspace,id)=>{calls.push({workspace,id});return null;},children:(workspace,id)=>{calls.push({workspace,id});return null;}}};
  const response={writeHead(){},end(){}};
  const identity={device:{workspaceId:'other'}};
  for(const r of routes)r.handler({response,services,identity,url:new URL(`http://localhost${r.path}?startAt=1&endAt=3600001&id=missing`)});
  assert.equal(calls.length,4);assert.ok(calls.every(c=>c.workspace==='other'));assert.ok(routes.every(r=>r.method==='GET'));
  assert.throws(()=>routes[0].handler({response,services,identity,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=9999999999999')}));
});

test('reading manifest negotiates gzip without allowing public response caching',()=>{
  const route=createReportRoutes().find(r=>r.path==='/api/v1/reports/tree');let headers,body,input;
  const response={req:{headers:{'accept-encoding':'gzip'}},writeHead(status,value){assert.equal(status,200);headers=value;},end(value){body=value;}};
  route.handler({response,identity:{device:{workspaceId:'phone'}},url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=reading'),services:{informationTree:{list(workspace,value){assert.equal(workspace,'phone');input=value;return {hours:[],information:Array.from({length:200},(_,i)=>({id:`node:${i}`}))};}}}});
  assert.equal(input.view,'reading');assert.equal(input.information,undefined);assert.equal(headers['Content-Encoding'],'gzip');assert.equal(headers['Cache-Control'],'no-store');
  assert.equal(JSON.parse(gunzipSync(body)).information.length,200);
  assert.throws(()=>route.handler({response,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=unknown')}));
  assert.throws(()=>route.handler({response,url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=index&information=2')}));
  route.handler({response,identity:{device:{workspaceId:'phone'}},url:new URL('http://localhost/api/v1/reports/tree?startAt=1&endAt=3600001&view=index&information=1'),services:{informationTree:{list(workspace,value){assert.equal(workspace,'phone');input=value;return {hours:[],days:[],information:[]};}}}});
  assert.equal(input.view,'index');assert.equal(input.information,'1');
});

test('tree-v3 daily brief routes read the latest published tree edition', () => {
  const now = Date.now();
  const latestEnd = now - 60 * 60 * 1000;
  const olderEnd = latestEnd - 2 * 86_400_000;
  const latestDate = formatYmd(zonedParts(latestEnd, 'Asia/Shanghai'));
  const olderDate = formatYmd(zonedParts(olderEnd, 'Asia/Shanghai'));
  const legacyDate = '2020-01-01';
  const latest = dailyEdition('edition:latest', latestEnd, [
    { id: 'd:compute', title: '算力', text: '厂商上调资本开支。' },
    { id: 'd:memory', title: '存储', text: '合约价继续上涨。' },
  ]);
  const older = dailyEdition('edition:older', olderEnd, [
    { id: 'd:old', title: '旧题', text: '旧正文。' },
  ]);
  const calls = [];
  const services = {
    report: {
      getLatestDailyBrief: () => ({ id: 'brief-old', reportDate: legacyDate, overview: '旧概览', generatedAt: 1 }),
      getDailyBrief: (_workspace, date) => (date === legacyDate ? { id: 'brief-old', reportDate: legacyDate, overview: '旧概览' } : null),
      listDailyBriefs: () => [{ reportDate: legacyDate, overview: '旧概览', itemCount: 1, generatedAt: 1 }],
    },
    informationTree: {
      list(workspace, window) {
        calls.push({ workspace, window, pipeline: services.informationTree.pipeline });
        assert.equal(workspace, 'local');
        assert.equal(window.endAt - window.startAt, 7 * 86_400_000);
        return {
          pipeline: services.informationTree.pipeline,
          timezone: 'Asia/Shanghai',
          days: [
            { edition: null, attempt: { id: 'edition:failed', status: 'failed', window: { startAt: latestEnd, endAt: latestEnd + 86_400_000 } } },
            { edition: older },
            { edition: latest },
          ],
        };
      },
      edition(_workspace, id) {
        if (id === latest.id) return { edition: latest, nodes: [
          { id: 'd:compute', title: '算力', text: '厂商上调资本开支。' },
          { id: 'd:memory', title: '存储', text: '合约价继续上涨。' },
        ] };
        if (id === older.id) return { edition: older, nodes: [{ id: 'd:old', title: '旧题', text: '旧正文。' }] };
        return null;
      },
      pipeline: 'tree-v3',
    },
  };
  const latestBrief = callBrief('/api/v1/reports/daily/latest/brief', services);
  assert.equal(latestBrief.status, 200);
  assert.equal(latestBrief.body.brief.reportDate, latestDate);
  assert.equal(latestBrief.body.brief.overview, '');
  assert.deepEqual(latestBrief.body.brief.informationItems, [
    { id: 'd:compute', sentence: '算力：厂商上调资本开支。' },
    { id: 'd:memory', sentence: '存储：合约价继续上涨。' },
  ]);
  assert.equal(latestBrief.body.brief.reportDate > legacyDate, true);

  const byDate = callBrief(`/api/v1/reports/daily/brief?date=${latestDate}`, services);
  assert.equal(byDate.body.brief.informationItems[0].sentence, '算力：厂商上调资本开支。');
  const legacyDay = callBrief(`/api/v1/reports/daily/brief?date=${legacyDate}`, services);
  assert.equal(legacyDay.body.brief.overview, '旧概览');

  const index = callBrief('/api/v1/reports/daily/briefs?limit=60', services);
  assert.equal(index.body.briefs[0].reportDate, latestDate);
  assert.equal(index.body.briefs[0].itemCount, 2);
  assert.equal(index.body.briefs.at(-1).reportDate, legacyDate);
  assert.ok(index.body.briefs.some((item) => item.reportDate === olderDate));

  services.informationTree.pipeline = 'legacy';
  const newerThanLegacy = callBrief('/api/v1/reports/daily/latest/brief', services);
  assert.equal(newerThanLegacy.body.brief.reportDate, latestDate);

  services.informationTree.list = () => ({ pipeline: 'legacy', days: [{ edition: older }] });
  services.report.getLatestDailyBrief = () => ({ id: 'brief-new', reportDate: latestDate, overview: 'legacy 更新' });
  const legacyWins = callBrief('/api/v1/reports/daily/latest/brief', services);
  assert.equal(legacyWins.body.brief.overview, 'legacy 更新');

  services.informationTree.pipeline = 'tree-v3';
  services.informationTree.list = () => ({ pipeline: 'tree-v3', days: [] });
  const empty = callBrief('/api/v1/reports/daily/latest/brief', services);
  assert.equal(empty.body.brief, null);
});
