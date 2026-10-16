import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { FeedTranslationJobInputSchema, parseTranslateBatchInput } from '../packages/contracts/src/index.js';
import { parseDefillamaStablecoins } from '../packages/connectors/src/market-native.js';
import { createTranslateService } from '../packages/connectors/src/translate/index.js';
import { gemmaLockedModels } from '../packages/connectors/src/translate/gemma.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { collectLocalizationUnits } from '../packages/domain/src/localize-texts.js';
import { evaluatePolymarketAlerts, localizePolymarketAlertLabels } from '../packages/domain/src/polymarket-alerts.js';
import {
  POLYMARKET_OUTCOME_GLOSSARY,
  POLYMARKET_OUTCOME_MODEL,
  polymarketOutcomeText,
  translatePolymarketOutcome,
  translateUncoveredPolymarketOutcomes,
} from '../packages/domain/src/polymarket-outcome-zh.js';
import {
  localizeOfficialAuthority,
  localizeOfficialBoard,
  simplifyOfficialTitle,
} from '../packages/domain/src/official-source-zh.js';
import {
  createOfficialSourceDetailDefinition,
  createStaticSignalSourceDefinitions,
} from '../packages/source/src/static/definitions.js';
import { captureStaticSignalBoard } from '../packages/runtime/src/web-snapshot-jobs.js';
import { createSourceRoutes } from '../apps/web/src/routes/source-routes.js';
import { createFeedRoutes } from '../apps/web/src/routes/feed-routes.js';

const NOW = Date.parse('2026-10-16T04:00:00Z');

function temporaryStore(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function element(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    children: [],
    style: {},
    append(...nodes) { this.children.push(...nodes); },
    addEventListener() {},
  };
}

function textOf(node) {
  return [node.textContent, ...(node.children || []).map(textOf)].filter(Boolean).join(' ');
}

function functionSource(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function jsonResponse() {
  return {
    statusCode: 0,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.body = JSON.parse(String(payload)); },
  };
}

test('outcome rules cover Yes/No, bps, percents, ranges and dates, and leave the rest', () => {
  const cases = [
    ['Yes', '是'],
    ['YES', '是'],
    ['No', '否'],
    ['No change', '不变'],
    ['25 bps increase', '上升 25 个基点'],
    ['25 bps decrease', '下降 25 个基点'],
    ['50+ bps decrease', '下降 50 个基点以上'],
    ['50+ bps increase', '上升 50 个基点以上'],
    ['Above 2.5%', '高于 2.5%'],
    ['Below 3%', '低于 3%'],
    ['Over 2%', '高于 2%'],
    ['Under 1%', '低于 1%'],
    ['2%-3%', '2%–3%'],
    ['Between 2% and 3%', '2%–3%'],
    ['October 16', '10月16日'],
    ['October 16, 2026', '2026年10月16日'],
    ['by October 16', '10月16日前'],
    ['end of November 2026', '2026年11月底'],
    ['100k-110k', '10万–11万'],
  ];
  for (const [label, text] of cases) {
    const ruled = translatePolymarketOutcome(label);
    assert.equal(ruled.covered, true, label);
    assert.equal(ruled.text, text, label);
    assert.equal(polymarketOutcomeText(label), text, label);
  }
  for (const label of ['140k', 'Ceasefire holds', '100 bps hike']) {
    const ruled = translatePolymarketOutcome(label);
    assert.equal(ruled.covered, false, label);
    assert.equal(polymarketOutcomeText(label), label, label);
  }
});

test('uncovered outcome labels use one glossary and only Gemma 26B', async () => {
  assert.throws(() => gemmaLockedModels('gemma-4-31b-it'), /Gemma 26B/);
  assert.deepEqual(gemmaLockedModels(POLYMARKET_OUTCOME_MODEL), [POLYMARKET_OUTCOME_MODEL]);
  const calls = [];
  const service = createTranslateService({
    router: {
      batch: false,
      async generate({ system, prompt, model }) {
        calls.push({ system, prompt, model });
        return { text: String(prompt).includes('140k') ? '14万' : '停火维持', engine: 'fake-gemma' };
      },
    },
  });
  const translated = await translateUncoveredPolymarketOutcomes(
    ['Yes', '140k', 'Ceasefire holds', '不变'],
    (input) => service.translateMany(input),
  );
  assert.equal(translated.get('Yes'), '是');
  assert.equal(translated.get('不变'), '不变');
  assert.equal(translated.get('140k'), '14万');
  assert.equal(translated.get('Ceasefire holds'), '停火维持');
  assert.deepEqual(calls.map((call) => call.prompt), ['140k', 'Ceasefire holds']);
  assert.ok(calls.every((call) => call.model === POLYMARKET_OUTCOME_MODEL));
  assert.ok(calls.every((call) => call.system.includes('Yes=是') && call.system.includes('No change=不变')));
  const quiet = createTranslateService({
    router: { batch: false, async generate() { throw new Error('短标签不应原样返回'); } },
  });
  const passed = await quiet.translate({ text: '140k', targetLang: 'zh' });
  assert.equal(passed.engine, 'passthrough');
  assert.equal(passed.translatedText, '140k');
});

test('lead alerts use the same outcome rules, and only uncovered labels call the model', async () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const config = {
    alerts: {
      illiquidLiquidityUsd: 3000,
      cooldownMinutes: 60,
      profiles: { multi: { leadChange: true } },
    },
  };
  function row(overrides) {
    return {
      eventId: '9', marketId: 'cut', outcomeKey: 'cut', watched: true, lifecycle: 'open',
      outcomeLabel: '25 bps decrease', liquidity: '9000', probability: '0.42', alertProfile: 'multi',
      ...overrides,
    };
  }
  const seen = evaluatePolymarketAlerts({
    outcomes: [row(), row({ marketId: 'yes', outcomeKey: 'yes', outcomeLabel: 'Yes', probability: '0.20' })],
    config,
    now,
  });
  const flipped = evaluatePolymarketAlerts({
    outcomes: [
      row({ probability: '0.18' }),
      row({ marketId: 'yes', outcomeKey: 'yes', outcomeLabel: 'Yes', probability: '0.61' }),
    ],
    states: seen.states,
    config,
    now,
  });
  assert.equal(flipped.alerts.find((alert) => alert.alertType === 'lead_change').message, '领先结果变为 是');
  const ruled = [{ alertType: 'lead_change', message: '领先结果变为 下降 25 个基点' }];
  let called = false;
  await localizePolymarketAlertLabels(ruled, async () => { called = true; return { translations: [] }; });
  assert.equal(called, false);
  const uncovered = [{ alertType: 'lead_change', message: '领先结果变为 Ceasefire holds' }];
  await localizePolymarketAlertLabels(uncovered, async (input) => {
    assert.equal(input.model, POLYMARKET_OUTCOME_MODEL);
    assert.equal(input.glossary, POLYMARKET_OUTCOME_GLOSSARY);
    assert.deepEqual(input.items.map((item) => item.text), ['Ceasefire holds']);
    return { translations: [{ id: '1', translatedText: '停火维持' }] };
  });
  assert.equal(uncovered[0].message, '领先结果变为 停火维持');
});

test('quote.outcome is collected when rules do not cover it, and short labels still need translation', async () => {
  const units = collectLocalizationUnits({
    predictionMarkets: [{
      quoteId: 'q1',
      marketQuestion: 'Will the committee change policy this month?',
      outcome: 'Ceasefire holds',
      outcomes: [
        { label: '是' },
        { label: '不变' },
        { label: 'No change' },
        { label: '140k' },
        { label: 'Ceasefire holds' },
      ],
    }],
  });
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  assert.equal(byId.get('q1').kind, undefined);
  assert.equal(byId.get('q1:outcome').kind, 'outcome');
  assert.equal(byId.get('q1:outcome').text, 'Ceasefire holds');
  assert.equal(byId.get('q1:140k').text, '140k');
  assert.equal(byId.has('q1:是'), false);
  assert.equal(byId.has('q1:不变'), false);
  assert.equal(byId.has('q1:No change'), false);
  const temporary = temporaryStore('ai-center-outcome-localize-');
  try {
    const service = createFeedService({
      legacyRepository: temporary.store,
      feedRepository: temporary.store.repositories.feed,
      sourcePort: {},
      translationPort: { translateMany: async () => { throw new Error('wait false'); } },
    });
    const result = await service.localizeTexts([
      { id: 'q:outcome', text: '140k', kind: 'outcome' },
      { id: 'covered', text: 'No change', kind: 'outcome' },
      { id: 'short', text: '140k' },
    ], { workspaceId: 'local' }, { wait: false });
    assert.equal(result.localizations['q:outcome'].pending, true);
    assert.equal(result.localizations['q:outcome'].kind, 'outcome');
    assert.equal(result.localizations.covered.pending, false);
    assert.equal(result.localizations.covered.status, 'ready');
    assert.equal(result.localizations.short.pending, false);
    assert.equal(result.pendingIds.includes('q:outcome'), true);
    assert.equal(result.pendingIds.includes('covered'), false);
  } finally {
    temporary.close();
  }
});

test('outcome labels are enqueued past the 60 item cap with the shared glossary', async () => {
  const events = Array.from({ length: 61 }, (_, index) => ({
    eventId: `event-${index}`,
    title: `Federal Reserve meeting number ${index} discusses policy`,
  }));
  const calls = [];
  const route = createSourceRoutes().find((entry) => entry.path === '/api/v1/market-native/board');
  const response = jsonResponse();
  await route.handler({
    response,
    identity: { device: { workspaceId: 'local' } },
    url: new URL('http://127.0.0.1/api/v1/market-native/board'),
    services: {
      marketNativeBoard: {
        read: async () => ({
          board: {
            upcoming: events,
            predictionMarkets: [{
              quoteId: 'q1',
              marketQuestion: 'Will the committee change policy this month?',
              outcome: 'Ceasefire holds',
              outcomes: [{ label: 'No change' }, { label: '140k' }],
            }],
          },
          pending: false,
        }),
      },
      feed: {
        localizeTexts: async (units) => ({
          pendingIds: units.map((unit) => unit.id),
          localizations: {},
        }),
      },
      runtime: {
        requestTranslation(input) {
          calls.push(input);
          return { id: 'job', priority: 10 };
        },
      },
    },
  });
  assert.equal(response.statusCode, 200);
  const ordinary = calls.filter((call) => !call.glossary);
  const outcomes = calls.filter((call) => call.glossary);
  const ordinaryIds = ordinary.flatMap((call) => call.items.map((item) => item.id));
  const outcomeIds = outcomes.flatMap((call) => call.items.map((item) => item.id));
  assert.equal(ordinaryIds.length, 60);
  assert.equal(ordinaryIds.includes('event-60'), false);
  assert.equal(outcomeIds.includes('event-60'), false);
  assert.deepEqual(outcomeIds.sort(), ['q1:140k', 'q1:outcome']);
  assert.ok(outcomes.every((call) => call.model === POLYMARKET_OUTCOME_MODEL && call.glossary.includes('Yes=是')));
  assert.ok(ordinary.every((call) => call.model === undefined));
  assert.throws(() => FeedTranslationJobInputSchema.parse({
    targetLang: 'zh',
    model: 'gemma-4-31b-it',
    items: [{ id: 'q1:outcome', text: 'Ceasefire holds' }],
  }));
  const parsed = parseTranslateBatchInput({
    targetLang: 'zh',
    glossary: 'polymarket-outcome',
    items: [{ id: 'q1:outcome', text: 'Ceasefire holds' }],
  });
  assert.equal(parsed.outcomeGlossary, true);
  assert.equal('glossary' in parsed, false);
});

test('browser outcome batch expands to the glossary and Gemma 26B', async () => {
  const route = createFeedRoutes().find((entry) => entry.path === '/api/v1/translate/batch');
  const calls = [];
  const request = (async function* requestBody() {
    yield Buffer.from(JSON.stringify({
      targetLang: 'zh',
      glossary: 'polymarket-outcome',
      items: [{ id: 'q1:outcome', text: 'Ceasefire holds' }],
    }));
  })();
  const response = jsonResponse();
  await route.handler({
    request,
    response,
    identity: { device: { workspaceId: 'local' } },
    events: { flush() {} },
    services: {
      runtime: {
        requestTranslation(input) {
          calls.push(input);
          return { id: 'job-outcome' };
        },
      },
    },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(calls[0].model, POLYMARKET_OUTCOME_MODEL);
  assert.equal(calls[0].glossary, POLYMARKET_OUTCOME_GLOSSARY);
  assert.equal(calls[0].items[0].text, 'Ceasefire holds');
});

test('amounts under 1000 round, changes use percentage points, and derivative labels are Chinese', () => {
  const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    document: { createElement: (tag) => element(tag) },
    attachGuardedOpen() {},
    openExternalHttpUrl() {},
  });
  vm.runInContext([
    'predictionShare', 'marketNativeAmount', 'formatPrice', 'formatPct', 'appendDerivativeQuote', 'predictionDayChange',
  ].map((name) => functionSource(appSource, name)).join('\n'), context);
  assert.equal(context.marketNativeAmount(79.9889), '$80');
  assert.equal(context.marketNativeAmount(79.4), '$79');
  assert.equal(context.marketNativeAmount(1500), '$1.5K');
  assert.equal(context.marketNativeAmount(80.2, { currency: false }), '80');
  assert.equal(context.predictionDayChange('0.62', '0.50').text, '较昨日 +12.0 个百分点');
  const root = element('div');
  context.appendDerivativeQuote(root, {
    symbol: 'BTC',
    markPrice: '67234.5',
    previousDayPrice: '66000',
    fundingRate: '0.0001',
    openInterest: '80.2',
    volume24h: '79.9889',
    sourceUrl: 'https://app.hyperliquid.xyz/trade',
  });
  const text = textOf(root);
  assert.match(text, /标记价 /);
  assert.match(text, /资金费率 0\.0100%/);
  assert.match(text, /持仓量 80 BTC/);
  assert.match(text, /24h \$80/);
  assert.equal(text.includes('Mark'), false);
  assert.equal(text.includes('Funding'), false);
  assert.equal(text.includes('OI'), false);
  const stable = parseDefillamaStablecoins({ peggedAssets: [] }, NOW, { assets: [], chains: [] });
  assert.equal(stable.total.label, '稳定币总供应');
});

test('official authorities and traditional titles are localized when sources are read and snapshotted', async () => {
  assert.equal(localizeOfficialAuthority('Treasury Department'), '美国财政部');
  assert.equal(localizeOfficialAuthority('Treasury Department; Federal Reserve Board'), '美国财政部；美联储理事会');
  assert.equal(localizeOfficialAuthority('美国财政部；美联储理事会'), '美国财政部；美联储理事会');
  assert.equal(localizeOfficialAuthority('Unknown Desk'), 'Unknown Desk');
  assert.equal(simplifyOfficialTitle('臺灣半導體出口創新高'), '台湾半导体出口创新高');
  assert.equal(simplifyOfficialTitle('國務院新聞辦公室'), '国务院新闻办公室');
  assert.equal(simplifyOfficialTitle('Consumer Price Index'), 'Consumer Price Index');
  assert.equal(simplifyOfficialTitle('国务院新闻办公室'), '国务院新闻办公室');

  const definitions = createStaticSignalSourceDefinitions({
    urls: { bls: 'https://www.bls.gov/schedule/news_release/bls.ics' },
    async bls() {
      return {
        available: true,
        observedAt: NOW,
        sourceUrl: this.urls.bls,
        note: '',
        events: [{
          eventId: 'bls:treasury',
          country: 'US',
          authority: 'Treasury Department',
          eventType: 'economic-release',
          title: '臺灣半導體出口創新高',
          scheduledAt: NOW,
          scheduledEndAt: null,
          referencePeriod: null,
          status: 'scheduled',
          scheduleBasis: 'official-calendar',
          timePrecision: 'exact',
          sourceUrl: this.urls.bls,
          observedAt: NOW,
        }],
      };
    },
  }, { now: () => NOW });
  const calendar = await definitions.find((definition) => definition.manifest.id === 'calendar.us.bls').read({});
  assert.equal(calendar.events[0].authority, '美国财政部');
  assert.equal(calendar.events[0].title, '台湾半导体出口创新高');
  const detail = createOfficialSourceDetailDefinition({
    async detail() {
      return {
        available: true,
        sourceUrl: 'https://www.gov.cn/a',
        title: '國務院新聞辦公室',
        officialSummary: '',
        bodyText: '',
        publishedAt: null,
        observedAt: NOW,
        truncated: false,
        note: '',
      };
    },
  }, { now: () => NOW });
  assert.equal((await detail.read({ sourceUrl: 'https://www.gov.cn/a' })).title, '国务院新闻办公室');

  const temporary = temporaryStore('ai-center-official-zh-');
  try {
    await captureStaticSignalBoard({
      sourcePort: {
        list() {
          return [
            { id: 'calendar.us.bls', title: 'BLS', category: 'calendar', viewKind: 'calendar' },
            { id: 'policy.us.white-house', title: 'White House', category: 'policy', viewKind: 'official-release' },
          ];
        },
        async read(sourceId) {
          if (sourceId === 'calendar.us.bls') {
            return {
              sourceId, providerId: 'provider', observedAt: NOW, status: 'ready', warnings: [],
              data: {
                available: true, observedAt: NOW, sourceUrl: 'https://www.bls.gov/schedule', note: '',
                events: [
                  {
                    eventId: 'treasury', country: 'US', authority: 'Treasury Department', eventType: 'economic-release',
                    title: '臺灣半導體出口創新高', scheduledAt: NOW, scheduledEndAt: null, referencePeriod: null,
                    status: 'scheduled', scheduleBasis: 'official-calendar', timePrecision: 'exact',
                    sourceUrl: 'https://www.bls.gov/schedule', observedAt: NOW,
                  },
                  {
                    eventId: 'cpi', country: 'US', authority: 'The White House', eventType: 'economic-release',
                    title: 'Consumer Price Index', scheduledAt: NOW, scheduledEndAt: null, referencePeriod: null,
                    status: 'scheduled', scheduleBasis: 'official-calendar', timePrecision: 'exact',
                    sourceUrl: 'https://www.whitehouse.gov/cpi', observedAt: NOW,
                  },
                ],
              },
            };
          }
          return {
            sourceId, providerId: 'provider', observedAt: NOW, status: 'ready', warnings: [],
            data: {
              available: true, observedAt: NOW, sourceUrl: 'https://www.whitehouse.gov/', note: '',
              releases: [{
                releaseId: 'wh-1', country: 'US', authority: 'Treasury Department; Federal Reserve Board',
                documentType: 'press-release', title: '國務院新聞辦公室', publishedAt: NOW, timePrecision: 'exact',
                effectiveAt: null, documentNumber: null, sourceUrl: 'https://www.whitehouse.gov/release', observedAt: NOW,
              }],
            },
          };
        },
      },
      repository: temporary.store.repositories.runtimeSnapshots,
      now: () => NOW,
    });
    const stored = temporary.store.repositories.runtimeSnapshots.readSnapshot('local', 'static-signal-board');
    const treasury = stored.payload.upcoming.find((item) => item.eventId === 'treasury');
    const cpi = stored.payload.upcoming.find((item) => item.eventId === 'cpi');
    assert.equal(treasury.authority, '美国财政部');
    assert.equal(treasury.title, '台湾半导体出口创新高');
    assert.equal(cpi.authority, '白宫');
    assert.equal(cpi.title, 'Consumer Price Index');
    assert.equal(stored.payload.releases[0].authority, '美国财政部；美联储理事会');
    assert.equal(stored.payload.releases[0].title, '国务院新闻办公室');
    const again = localizeOfficialBoard(stored.payload);
    assert.equal(again.upcoming.find((item) => item.eventId === 'treasury').title, treasury.title);
    assert.equal(again.releases[0].authority, stored.payload.releases[0].authority);
  } finally {
    temporary.close();
  }
});
