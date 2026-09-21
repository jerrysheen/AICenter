import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createElucidWebSearchProvider,
  mapElucidSearchResponse,
  resolveHarnessWebSearchProvider,
  searchElucidWeb,
} from '../packages/harness/src/web-search-elucid.js';
import { HARNESS_ELUCID_PROVIDER, HARNESS_PROVIDER } from '../packages/harness/src/constants.js';

function elucidPayload() {
  return {
    output: [
      {
        type: 'web_search_call',
        action: {
          sources: [
            { url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm', title: 'FOMC' },
            { url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm', title: 'dup' },
          ],
        },
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'The FOMC raised the target range.',
            annotations: [{
              type: 'url_citation',
              url: 'https://www.federalreserve.gov/monetarypolicy/files/monetary20260916a1.pdf',
              title: 'Statement PDF',
            }],
          },
        ],
      },
    ],
  };
}

test('Elucid search maps web_search_call sources into the official seam shape', () => {
  const mapped = mapElucidSearchResponse(elucidPayload(), { maxResults: 8 });
  assert.equal(mapped.content, 'The FOMC raised the target range.');
  assert.deepEqual(mapped.sources.map((item) => item.url), [
    'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm',
    'https://www.federalreserve.gov/monetarypolicy/files/monetary20260916a1.pdf',
  ]);
  assert.equal(mapped.truncated, false);
});

test('Elucid search fails closed when the native tool did not run', () => {
  assert.throws(
    () => mapElucidSearchResponse({ output: [{ type: 'message', content: [] }] }),
    /web_search_call/,
  );
});

test('search provider follows the same Harness LLM switch', () => {
  assert.equal(resolveHarnessWebSearchProvider({
    AI_CENTER_HARNESS_PROVIDER: 'elucid-grok',
  }), HARNESS_ELUCID_PROVIDER);
  assert.equal(resolveHarnessWebSearchProvider({
    AI_CENTER_HARNESS_PROVIDER: 'deepseek-official',
    ELUCID_GROK_API_KEY: 'elucid-key',
  }), HARNESS_PROVIDER);
  const elucid = createElucidWebSearchProvider({
    env: { AI_CENTER_HARNESS_PROVIDER: 'elucid-grok', ELUCID_GROK_API_KEY: 'elucid-key' },
  });
  assert.equal(elucid.id, HARNESS_ELUCID_PROVIDER);
  assert.equal(elucid.available(), true);
  const parked = createElucidWebSearchProvider({
    env: { AI_CENTER_HARNESS_PROVIDER: 'deepseek-official', ELUCID_GROK_API_KEY: 'elucid-key' },
  });
  assert.equal(parked.available(), false);
});

test('Elucid search posts Responses web_search and retries without include on 400', async () => {
  const calls = [];
  const result = await searchElucidWeb({ query: 'FOMC', maxResults: 1 }, {
    env: { AI_CENTER_HARNESS_PROVIDER: 'elucid-grok', ELUCID_GROK_API_KEY: 'elucid-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 400,
          async json() { return { error: { message: 'include not supported' } }; },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() { return elucidPayload(); },
      };
    },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/responses$/);
  assert.equal(calls[0].body.tool_choice, 'required');
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search' }]);
  assert.ok(calls[0].body.include);
  assert.equal(calls[1].body.include, undefined);
  assert.equal(result.sources[0].url, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm');
});
