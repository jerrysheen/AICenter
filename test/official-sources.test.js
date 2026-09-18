import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDolClaimsEvents,
  generateLprRuleEvents,
  createOfficialSourcesClient,
  extractOfficialSourceDetail,
  parseBeaCalendar,
  parseBlsIcs,
  parseCensusCalendar,
  parseCustomsCalendar,
  parseFederalRegister,
  parseGovCn,
  parseGovNews,
  parseNbsCalendar,
  parsePboc,
  parseScioCalendar,
  parseWhiteHouse,
} from '../packages/connectors/src/official-sources.js';
import { createStaticSignalSourceDefinitions } from '../packages/source/src/static/definitions.js';
import { CalendarSourceViewSchema, OfficialSourceDetailSchema } from '../packages/contracts/src/index.js';

const OBSERVED_AT = Date.parse('2026-09-17T12:00:00Z');

test('official calendar parsers normalize ICS and HTML without forecast or impact fields', () => {
  const bls = parseBlsIcs(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:bls-cpi-1\nDTSTART;TZID=America/New_York:20261014T083000\nSUMMARY:Consumer Price Index\nURL:https://www.bls.gov/news.release/cpi.nr0.htm\nEND:VEVENT\nEND:VCALENDAR`, OBSERVED_AT);
  assert.equal(bls.length, 1);
  assert.equal(bls[0].title, 'Consumer Price Index');
  assert.equal(bls[0].scheduledAt, Date.parse('2026-10-14T12:30:00Z'));
  assert.equal('forecast' in bls[0], false);
  assert.equal(bls[0].scheduleBasis, 'official-calendar');

  const bea = parseBeaCalendar(`
    <table><thead><tr><th>Year 2026</th></tr></thead><tbody>
      <tr class="scheduled-releases-type-press">
        <td><div class="release-date">September 30</div><small>8:30 AM</small></td>
        <td class="release-title">GDP (Third Estimate), 2nd Quarter 2026</td>
      </tr>
    </tbody></table>`, OBSERVED_AT);
  assert.equal(bea[0].authority, 'U.S. Bureau of Economic Analysis');
  assert.equal(bea[0].scheduledAt, Date.parse('2026-09-30T12:30:00Z'));

  const census = parseCensusCalendar(`
    <table><tr><td><a href="/retail/">Advance Monthly Sales</a></td>
      <td>October 15, 2026</td><td>8:30 AM</td><td>September 2026</td></tr></table>`, OBSERVED_AT);
  assert.equal(census[0].referencePeriod, 'September 2026');
  assert.equal(census[0].sourceUrl, 'https://www.census.gov/retail/');
});

test('BEA TBA and Census suspended rows remain visible without invented timestamps', () => {
  const bea = parseBeaCalendar(`
    <table><thead><tr><th>Year 2026</th></tr></thead><tbody>
      <tr class="scheduled-releases"><td class="scheduled-date"><small>To Be Announced<br>2026</small></td>
      <td class="release-title">Outdoor Recreation Economic Statistics</td></tr>
    </tbody></table>`, OBSERVED_AT);
  assert.equal(bea.length, 1);
  assert.equal(bea[0].status, 'tba');
  assert.equal(bea[0].scheduledAt, null);
  assert.equal(bea[0].timePrecision, 'unknown');

  const census = parseCensusCalendar(`<table><tr>
    <td><a href="/foreign-trade/">Preliminary U.S. Imports</a></td>
    <td>Suspended</td><td></td><td>August 2026</td>
  </tr></table>`, OBSERVED_AT);
  assert.equal(census.length, 1);
  assert.equal(census[0].status, 'suspended');
  assert.equal(census[0].scheduledAt, null);
});

test('NBS rowspans become exact monthly scheduled events', () => {
  const html = `
    <h1>2026年国家统计局主要统计信息发布日程表</h1>
    <table>
      <tr><th>序号</th><th>内容</th><th>1月</th><th>2月</th></tr>
      <tr><td rowspan="2">1</td><td rowspan="2">居民消费价格指数月度报告</td><td>9/五</td><td>11/三</td></tr>
      <tr><td>9:30</td><td>9:30</td></tr>
    </table>`;
  const events = parseNbsCalendar(html, OBSERVED_AT);
  assert.equal(events.length, 2);
  assert.equal(events[0].country, 'CN');
  assert.equal(events[0].scheduledAt, Date.parse('2026-01-09T01:30:00Z'));
});

test('NBS pairs every date and time when one month cell contains two releases', () => {
  const html = `
    <h1>2026年国家统计局主要统计信息发布日程表</h1>
    <table>
      <tr><th>序号</th><th>内容</th><th>3月</th></tr>
      <tr><td rowspan="2">1</td><td rowspan="2">采购经理指数月度报告</td><td>4日 注5 31日</td></tr>
      <tr><td>9:30 9:30</td></tr>
    </table>`;
  const events = parseNbsCalendar(html, OBSERVED_AT, 'https://www.stats.gov.cn/2026-calendar.html');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((item) => item.scheduledAt), [
    Date.parse('2026-03-04T01:30:00Z'),
    Date.parse('2026-03-31T01:30:00Z'),
  ]);
  assert.equal(events.every((item) => item.sourceUrl.endsWith('2026-calendar.html')), true);
});

test('Customs date-only rows use midnight canonical values and never invent 10:00', () => {
  const events = parseCustomsCalendar(`
    <h1>Release Calendar of 2026</h1><table>
      <tr><td>September</td><td>8</td><td></td><td></td></tr>
    </table>`, OBSERVED_AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].timePrecision, 'date');
  assert.equal(events[0].scheduledAt, Date.parse('2026-09-07T16:00:00Z'));
});

test('Customs client reports current-year calendar absence instead of extrapolating', async () => {
  const client = createOfficialSourcesClient({
    now: () => OBSERVED_AT,
    async fetch() {
      return new Response('<a href="/calendar-2025.html">Release Calendar of 2025</a>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    },
  });
  const view = await client.customs({
    from: Date.parse('2026-09-01T00:00:00Z'), to: Date.parse('2026-12-31T23:59:59Z'), limit: 100,
  });
  assert.equal(view.available, false);
  assert.equal(view.events.length, 0);
  assert.match(view.note, /尚未提供 2026 年/);
});

test('rule-generated schedules stay explicitly tentative', () => {
  const input = { from: Date.parse('2026-09-01T00:00:00Z'), to: Date.parse('2026-10-31T23:59:59Z') };
  const claims = generateDolClaimsEvents(input, OBSERVED_AT);
  const lpr = generateLprRuleEvents(input, OBSERVED_AT);
  assert.ok(claims.length >= 8);
  assert.equal(claims.every((item) => item.status === 'tentative' && item.scheduleBasis === 'official-rule'), true);
  assert.equal(lpr.length, 2);
  assert.equal(lpr.every((item) => item.title.includes('遇节假日顺延')), true);
});

test('calendar contract rejects interpretation-layer fields and non-http links', () => {
  const base = {
    available: true, observedAt: OBSERVED_AT, sourceUrl: 'https://example.com/calendar', note: '',
    events: [{
      eventId: 'event-1', country: 'US', authority: 'Authority', eventType: 'economic-release',
      title: 'Release', scheduledAt: OBSERVED_AT, scheduledEndAt: null, referencePeriod: null,
      status: 'scheduled', scheduleBasis: 'official-calendar', timePrecision: 'exact',
      sourceUrl: 'https://example.com/release', observedAt: OBSERVED_AT,
    }],
  };
  assert.equal(CalendarSourceViewSchema.safeParse(base).success, true);
  assert.equal(CalendarSourceViewSchema.safeParse({
    ...base, events: [{ ...base.events[0], forecast: '3.1%' }],
  }).success, false);
  assert.equal(CalendarSourceViewSchema.safeParse({
    ...base, events: [{ ...base.events[0], sourceUrl: 'file:///secret' }],
  }).success, false);
});

test('official release parsers keep document facts and source URLs', () => {
  const register = parseFederalRegister({ results: [{
    document_number: '2026-12345', title: 'Example Final Rule', type: 'Rule',
    publication_date: '2026-09-17', effective_on: '2026-10-01',
    html_url: 'https://www.federalregister.gov/d/2026-12345', agencies: [{ name: 'Example Agency' }],
  }] }, OBSERVED_AT);
  assert.equal(register[0].documentType, 'rule');
  assert.equal(register[0].documentNumber, '2026-12345');

  const whiteHouse = parseWhiteHouse(`<ul><li class="wp-block-post post-1">
    <h2 class="wp-block-post-title"><a href="https://www.whitehouse.gov/presidential-actions/2026/09/example/">Example Order</a></h2>
    <div class="taxonomy-category"><a>Presidential Actions</a></div>
    <time datetime="2026-09-17T08:00:00-04:00">September 17, 2026</time>
  </li></ul>`, OBSERVED_AT);
  assert.equal(whiteHouse[0].documentType, 'presidential-document');

  const gov = parseGovCn({ searchVO: { catMap: { gongwen: { listVO: [{
    id: '1', title: '国务院办公厅关于示例事项的通知', puborg: '国务院办公厅',
    pubtime: OBSERVED_AT, pcode: '国办发〔2026〕1号', url: 'https://www.gov.cn/example.htm',
  }] }, bumenfile: { listVO: [] } } } }, OBSERVED_AT);
  assert.equal(gov[0].documentType, 'policy-document');
  assert.equal(gov[0].authority, '国务院办公厅');

  const pboc = parsePboc(`<table><tr><td><a href="/goutongjiaoliu/113456/113469/example/index.html" title="2026年8月金融统计数据报告">报告</a><span class="hui12">2026-09-14</span></td></tr></table>`, OBSERVED_AT);
  assert.equal(pboc[0].authority, '中国人民银行');
  assert.equal(pboc[0].publishedAt, Date.parse('2026-09-13T16:00:00Z'));
});

test('SCIO notices and government meeting news become factual calendar and release records', () => {
  const scio = parseScioCalendar(`<ul><li><a href="/pressroom/2026-09/16/content_118698428.html">
    Notice of SCIO press conference on Sept. 18 (10 a.m.)</a></li></ul>`, OBSERVED_AT);
  assert.equal(scio.length, 1);
  assert.equal(scio[0].scheduledAt, Date.parse('2026-09-18T02:00:00Z'));
  assert.equal(scio[0].authority, '国务院新闻办公室');
  assert.equal(scio[0].eventType, 'government-meeting');

  const news = parseGovNews([
    { TITLE: '李强主持召开国务院常务会议 对加强安全生产工作作出进一步部署', URL: 'https://www.gov.cn/yaowen/liebiao/202609/content_1.htm', DOCRELPUBTIME: '2026-09-11' },
    { TITLE: '【视频】李强主持召开国务院常务会议', URL: 'https://tv.cctv.com/example.shtml', DOCRELPUBTIME: '2026-09-11' },
    { TITLE: '中共中央政治局召开会议 分析研究当前经济形势和经济工作', URL: 'https://www.gov.cn/yaowen/liebiao/202608/content_2.htm', DOCRELPUBTIME: '2026-08-28' },
  ], OBSERVED_AT);
  assert.equal(news.length, 2);
  assert.deepEqual(news.map((item) => item.authority), ['国务院', '中共中央政治局']);
});

test('official detail extraction keeps the SCIO subject and body as official text', () => {
  const detail = extractOfficialSourceDetail(`
    <html><head>
      <meta property="og:title" content="Notice of SCIO press conference on July 28 (10 a.m.)">
      <meta name="publishdate" content="2026-07-25">
      <meta name="description" content="SCIO will hold a press conference on tax reform and development in the 15th Five-Year Plan period.">
    </head><body><div id="article-content">
      <p>All journalists attending are kindly requested to bring their press cards.</p>
      <p>Contact the SCIO press room for attendance information.</p>
    </div></body></html>
  `, 'http://english.scio.gov.cn/pressroom/2026-07/25/content_118617731.html', OBSERVED_AT);
  assert.equal(detail.available, true);
  assert.match(detail.officialSummary, /tax reform/);
  assert.match(detail.bodyText, /press cards/);
  assert.equal(detail.publishedAt, Date.parse('2026-07-25T00:00:00.000Z'));
  assert.equal('impact' in detail, false);
  assert.equal(OfficialSourceDetailSchema.safeParse(detail).success, true);
  assert.equal(OfficialSourceDetailSchema.safeParse({ ...detail, impact: 'bullish' }).success, false);
});

test('official detail reader rejects arbitrary hosts and keeps the SCIO HTTP exception scoped', async () => {
  let calls = 0;
  const client = createOfficialSourcesClient({
    now: () => OBSERVED_AT,
    async fetch() { calls += 1; return new Response('<h1>unexpected</h1>'); },
  });
  await assert.rejects(() => client.detail({ sourceUrl: 'https://example.com/article' }), /已登记的官方/);
  await assert.rejects(() => client.detail({ sourceUrl: 'http://www.gov.cn/article' }), /已登记的官方/);
  assert.equal(calls, 0);
});

test('Federal Register detail uses the official API and raw text instead of an access-block page', async () => {
  const requested = [];
  const client = createOfficialSourcesClient({
    now: () => OBSERVED_AT,
    async fetch(url) {
      requested.push(String(url));
      if (String(url).includes('/api/v1/documents/2026-19094.json')) {
        return Response.json({
          title: 'Airworthiness Directives; Example Engines',
          abstract: 'The agency proposes inspections and replacement requirements.',
          publication_date: '2026-09-17',
          raw_text_url: 'https://www.federalregister.gov/documents/full_text/text/2026/09/17/2026-19094.txt',
        });
      }
      return new Response('AGENCY: Example Agency. ACTION: Proposed rule. SUMMARY: Full official document text.');
    },
  });
  const detail = await client.detail({
    sourceUrl: 'https://www.federalregister.gov/documents/2026/09/17/2026-19094/example-engines',
  });
  assert.match(detail.officialSummary, /inspections/);
  assert.match(detail.bodyText, /Full official document text/);
  assert.equal(detail.title, 'Airworthiness Directives; Example Engines');
  assert.equal(requested.length, 2);
});

test('static signal definitions normalize connector failures as unavailable snapshots', async () => {
  const definitions = createStaticSignalSourceDefinitions({
    urls: { bls: 'https://www.bls.gov/schedule/news_release/bls.ics' },
    async bls() { throw new Error('offline'); },
  }, { now: () => OBSERVED_AT });
  const source = definitions.find((item) => item.manifest.id === 'calendar.us.bls');
  const view = await source.read({ limit: 10 });
  assert.equal(view.available, false);
  assert.equal(view.events.length, 0);
  assert.match(view.note, /offline/);
});
