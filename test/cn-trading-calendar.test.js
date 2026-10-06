import test from 'node:test';
import assert from 'node:assert/strict';
import {cnTradingCalendarAt} from '../packages/domain/src/cn-trading-calendar.js';
import {CnTradingCalendarSchema} from '../packages/contracts/src/common.js';
import {quoteFromXueqiuItem} from '../packages/connectors/src/xueqiu-quotes.js';
import {createMarketService} from '../packages/source/src/market/service.js';
import {buildCnMarketBoard} from '../packages/source/src/market/boards.js';

const at=text=>Date.parse(`${text}+08:00`);

test('CN exchange holidays include A/B shares and exclude makeup weekends',()=>{
  for(const date of ['2026-01-02','2026-02-23','2026-04-06','2026-05-05','2026-06-19','2026-09-25','2026-10-05','2026-10-07']) {
    const calendar=cnTradingCalendarAt(at(`${date}T10:00:00`));
    assert.equal(calendar.tradingDay,false,date);assert.equal(calendar.session,'closed');
    CnTradingCalendarSchema.parse(calendar);
  }
  const holiday=cnTradingCalendarAt(at('2026-10-05T10:00:00'));
  assert.equal(holiday.nextOpenAt,at('2026-10-08T09:30:00'));
  assert.match(holiday.reason,/国庆/);
  assert.equal(cnTradingCalendarAt(at('2026-10-10T10:00:00')).tradingDay,false);
  assert.equal(cnTradingCalendarAt(at('2027-01-04T10:00:00')).session,'unknown');
  assert.equal(cnTradingCalendarAt(at('2027-01-04T10:00:00')).nextOpenAt,null);
});

test('CN session boundaries distinguish auction, lunch and close in Shanghai time',()=>{
  for(const [clock,session] of [['09:14','pre'],['09:15','pre'],['09:25','pre'],['09:30','regular'],['11:29','regular'],['11:30','break'],['12:59','break'],['13:00','regular'],['14:57','regular'],['15:00','closed']]) {
    assert.equal(cnTradingCalendarAt(at(`2026-10-08T${clock}:00`)).session,session,clock);
  }
  assert.equal(cnTradingCalendarAt(at('2026-10-08T12:00:00')).nextOpenAt,at('2026-10-08T13:00:00'));
});

test('real quote time survives connectors, quote service and board, never replaced by fetch time',async()=>{
  const quotedAt=at('2026-09-30T15:00:00'),fetchedAt=at('2026-10-05T10:00:00');
  const symbols=['600519.SS','900901.SS','200012.SZ'];
  const quotes=symbols.map(symbol=>quoteFromXueqiuItem({market:{status:'交易中'},quote:{current:2,last_close:1.9,timestamp:quotedAt}},symbol));
  const service=createMarketService({now:()=>fetchedAt,yahoo:{fetchQuotes:async()=>({quotes:[]})},
    xueqiuQuotes:{fetchQuotes:async()=>quotes},cnQuotes:{fetchQuotes:async()=>[]},sinaFutures:null,tushare:null});
  const result=await service.fetchQuotes(symbols);
  assert.equal(result.length,3);
  for(const q of result) {assert.equal(q.asOf,quotedAt);assert.equal(q.session,'closed');}
  const catalog={cn:{indices:[],watchlist:symbols.map(symbol=>({symbol,name:symbol,group:'test'})),groups:['test']}};
  const board=buildCnMarketBoard({quotes:result,fetchedAt,marketCatalog:catalog});
  assert.equal(board.calendar.tradingDay,false);
  for(const q of board.watchlist) assert.equal(q.asOf,quotedAt);
  const missing=buildCnMarketBoard({quotes:[{symbol:symbols[0],lastPrice:2}],fetchedAt,marketCatalog:catalog});
  assert.equal(missing.watchlist[0].asOf,null);
});

test('Yahoo fallback preserves its quote time for A/B shares and foreign quotes',async()=>{
  const asOf=at('2026-09-30T15:00:00');
  const service=createMarketService({now:()=>at('2026-10-05T10:00:00'),xueqiuQuotes:null,cnQuotes:{fetchQuotes:async()=>[]},sinaFutures:null,tushare:null,
    yahoo:{fetchQuotes:async symbols=>({quotes:symbols.map(symbol=>({symbol,lastPrice:1,prevClose:1,marketTime:asOf/1000,session:'regular'}))})}});
  const quotes=await service.fetchQuotes(['900901.SS','USDCNY=X']);
  assert.equal(quotes.length,2);assert.ok(quotes.every(q=>q.asOf===asOf));
  assert.equal(quotes[0].session,'closed');assert.equal(quotes[1].session,'regular');
});
