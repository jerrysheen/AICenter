import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSinaFuturesClient,
  isSinaFutureSymbol,
  quoteFromSinaLine,
  yahooToSinaFutureSymbol,
} from '../packages/connectors/src/sina-futures.js';

test('sina future symbols map commodity and CFFEX continuous contracts', () => {
  assert.equal(isSinaFutureSymbol('LC00Y'), true);
  assert.equal(isSinaFutureSymbol('SI=F'), false);
  assert.equal(yahooToSinaFutureSymbol('AG00Y'), 'nf_AG0');
  assert.equal(yahooToSinaFutureSymbol('T00Y'), 'CFF_RE_T0');
  assert.equal(yahooToSinaFutureSymbol('TS00Y'), 'CFF_RE_TS0');
});

test('sina commodity line maps last price and previous settlement', () => {
  const quote = quoteFromSinaLine(
    'var hq_str_nf_LC0="碳酸锂连续,150056,132000.000,132200.000,125220.000,127160.000,127160.000,127180.000,127160.000,0.000,130120.000,1,2,1,1,日,碳酸锂,2026-09-18,1";',
    'LC00Y',
  );
  assert.equal(quote.symbol, 'LC00Y');
  assert.equal(quote.name, '碳酸锂连续');
  assert.equal(quote.lastPrice, 127160);
  assert.equal(quote.prevClose, 130120);
  assert.equal(quote.currency, 'CNY');
});

test('sina CFFEX line uses the first field as last price', () => {
  const quote = quoteFromSinaLine(
    'var hq_str_CFF_RE_TS0="102.600,102.612,102.590,102.610,31282,1,1,102.610,0.000,103.110,102.086,0.000,0.000,102.596,102.598,1,102.610,19,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-09-18,15:15:00,200,1,,,,,,,,,102.605,2年期国债期货连续";',
    'TS00Y',
  );
  assert.equal(quote.symbol, 'TS00Y');
  assert.equal(quote.lastPrice, 102.6);
  assert.equal(quote.prevClose, 102.61);
  assert.equal(quote.name, '2年期国债期货连续');
});

test('sina futures client requests mapped codes and returns requested symbols', async () => {
  const requested = [];
  const client = createSinaFuturesClient({
    fetchImpl: async (url) => {
      requested.push(String(url));
      const body = [
        'var hq_str_nf_M0="豆粕连续,230000,3393.000,3403.000,3374.000,0.000,3378.000,3379.000,3378.000,0.000,3429.000,1,2,1,1,日,豆粕,2026-09-18,1";',
        'var hq_str_CFF_RE_T0="109.465,109.545,109.440,109.535,1,1,1,109.535,0.000,1,1,0,0,109.465,109.460,1,109.530,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-09-18,15:15:00,200,1,,,,,,,,,109.499,10年期国债期货连续";',
      ].join('');
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return Buffer.from(body, 'utf8');
        },
      };
    },
  });
  const quotes = await client.fetchQuotes(['M00Y', 'T00Y', 'AAPL']);
  assert.equal(requested[0].includes('nf_M0'), true);
  assert.equal(requested[0].includes('CFF_RE_T0'), true);
  assert.equal(requested[0].includes('AAPL'), false);
  assert.equal(quotes.find((item) => item.symbol === 'M00Y').lastPrice, 3378);
  assert.equal(quotes.find((item) => item.symbol === 'T00Y').lastPrice, 109.465);
});
