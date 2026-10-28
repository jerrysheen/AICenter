import test from 'node:test';
import assert from 'node:assert/strict';
import { briefDate, briefDayWindow, briefTreeMode, informationSignature, distinctMaterialCount } from '../apps/web/public/brief-page.js';
import { HourlyDigestIndexQuerySchema, HourlyDigestIndexSchema, DailyBriefWindowQuerySchema } from '../packages/contracts/src/report.js';

test('opening the brief without an hour stays on hourly, and an explicit daily mode does not', () => {
  assert.equal(briefTreeMode({}), 'hourly');
  assert.equal(briefTreeMode({ hour: 20 }), 'hourly');
  assert.equal(briefTreeMode({ mode: 'daily' }), 'daily');
  assert.equal(briefTreeMode({ mode: 'discussion' }), 'discussion');
  assert.equal(briefTreeMode({ date: '2026-10-28' }), 'daily');
  assert.equal(briefTreeMode({ date: '2026-10-28', hour: 7 }), 'hourly');
  assert.equal(briefTreeMode({ history: true }), 'daily');
});

test('brief calendar uses Instance timezone and respects DST instead of the browser timezone',()=>{
  assert.equal(briefDate(Date.parse('2026-10-04T17:00:00Z'),'Asia/Shanghai'),'2026-10-05');
  assert.deepEqual(briefDayWindow('2026-10-05','Asia/Shanghai'),{startAt:Date.parse('2026-10-04T16:00:00Z'),endAt:Date.parse('2026-10-05T16:00:00Z')});
  const dst=briefDayWindow('2026-03-08','America/New_York');
  assert.equal(dst.endAt-dst.startAt,23*3600000);
});

test('read identity survives snapshot and item ID replacement but changes for corrected sentence or evidence',()=>{
  const item={id:'old',sentence:'作者自报，尚未验证。',evidence:[{snapshotId:'old',materialId:'m',paragraphId:'p',materialHash:'a',materialVersion:'1'}]};
  const updated={...item,id:'new',evidence:[{...item.evidence[0],snapshotId:'new'}]};
  assert.equal(informationSignature(item),informationSignature(updated));
  assert.notEqual(informationSignature(item),informationSignature({...updated,sentence:'已验证。'}));
  assert.notEqual(informationSignature(item),informationSignature({...updated,evidence:[{...updated.evidence[0],materialVersion:'2'}]}));
  assert.equal(distinctMaterialCount([...item.evidence,{...item.evidence[0],paragraphId:'other'}]),1);
});

test('brief metadata contracts reject malformed ranges, authority fields and invalid counts',()=>{
  assert.equal(HourlyDigestIndexQuerySchema.safeParse({startAt:0,endAt:0}).success,false);
  assert.equal(HourlyDigestIndexQuerySchema.safeParse({startAt:0,endAt:8*86400000}).success,false);
  assert.equal(HourlyDigestIndexQuerySchema.safeParse({startAt:0,endAt:3600000,command:'generate'}).success,false);
  assert.equal(DailyBriefWindowQuerySchema.safeParse({date:'2026-10-05',revision:NaN}).success,false);
  assert.equal(HourlyDigestIndexSchema.safeParse({timezone:'Asia/Shanghai',hours:[{hourStart:0,id:null,generatedAt:null,itemCount:-1,status:'failed',updatedAt:1,unread:0,failed:0}]}).success,false);
});
