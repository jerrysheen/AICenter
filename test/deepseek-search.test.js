import test from 'node:test';
import assert from 'node:assert/strict';
import {
  citationSnippetsFromBlocks,
  createDeepSeekSearchProvider,
  mapDeepSeekSearchResponse,
} from '../packages/connectors/src/deepseek-search.js';
import { WebSearchUnavailableError } from '../packages/connectors/src/searxng.js';

const SAMPLE_BLOCKS = [
  {
    type: 'web_search_tool_result',
    content: [
      {
        type: 'web_search_result',
        url: 'https://example.com/a',
        title: 'Alpha',
        page_age: '2026-09-16T18:00:00Z',
      },
      {
        type: 'web_search_result',
        url: 'https://example.com/b',
        title: 'Beta',
        page_age: '3 days ago',
      },
      {
        type: 'web_search_result',
        url: 'https://example.com/a',
        title: 'Alpha again',
      },
    ],
  },
  {
    type: 'text',
    text: 'DeepSeek should not leak this generated answer into search results.',
    citations: [
      { url: 'https://example.com/a', cited_text: 'alpha snippet' },
      { url: 'https://example.com/b', cited_text: 'beta snippet' },
    ],
  },
];

test('deepseek mapper keeps structured sources and drops generated text', () => {
  const mapped = mapDeepSeekSearchResponse({ content: SAMPLE_BLOCKS }, {
    query: 'HBM',
    limit: 8,
    observedAt: 9,
  });
  assert.equal(mapped.query, 'HBM');
  assert.equal(mapped.available, true);
  assert.equal(mapped.note, '');
  assert.equal(mapped.results.length, 2);
  assert.deepEqual(mapped.results[0], {
    title: 'Alpha',
    url: 'https://example.com/a',
    snippet: 'alpha snippet',
    engine: '',
    publishedAt: '2026-09-16T18:00:00.000Z',
  });
  assert.equal(mapped.results[1].title, 'Beta');
  assert.equal(mapped.results[1].snippet, 'beta snippet');
  assert.equal(mapped.results[1].publishedAt, null);
  assert.equal(JSON.stringify(mapped).includes('should not leak'), false);

  const snippets = citationSnippetsFromBlocks(SAMPLE_BLOCKS);
  assert.equal(snippets.get('https://example.com/a/'), undefined);
  assert.equal(snippets.get('https://example.com/a'), 'alpha snippet');
});

test('deepseek mapper treats missing search blocks as unavailable', () => {
  assert.throws(
    () => mapDeepSeekSearchResponse({
      content: [{ type: 'text', text: 'I looked it up and found nothing structured.' }],
    }, { query: 'test' }),
    (error) => {
      assert.equal(error.name, 'WebSearchUnavailableError');
      assert.match(error.message, /web_search_tool_result/);
      return true;
    },
  );
});

test('deepseek provider requires a key and maps a successful messages response', async () => {
  assert.throws(() => createDeepSeekSearchProvider({ env: {} }), /DEEPSEEK_API_KEY/);

  let request;
  const provider = createDeepSeekSearchProvider({
    apiKey: 'test-key',
    now: () => 42,
    fetchImpl: async (url, init) => {
      request = { url: String(url), ...init, headers: init.headers };
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: SAMPLE_BLOCKS }),
      };
    },
  });
  assert.equal(provider.id, 'deepseek');
  const data = await provider.search({ query: 'nvda', limit: 1 });
  assert.equal(data.available, true);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].url, 'https://example.com/a');
  assert.equal(data.observedAt, 42);

  const body = JSON.parse(request.body);
  assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-api-key'], 'test-key');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.tools[0].type, 'web_search_20250305');
  assert.equal(body.tools[0].max_uses, 5);
  assert.match(body.messages[0].content[0].text, /nvda/);
});

test('deepseek provider marks auth and empty native-search responses unavailable', async () => {
  const forbidden = createDeepSeekSearchProvider({
    apiKey: 'bad',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'no search entitlement' } }),
    }),
  });
  await assert.rejects(() => forbidden.search({ query: 'test' }), (error) => {
    assert.equal(error.name, 'WebSearchUnavailableError');
    assert.match(error.message, /403/);
    assert.match(error.message, /no search entitlement/);
    return true;
  });

  const proseOnly = createDeepSeekSearchProvider({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'no tool result' }] }),
    }),
  });
  await assert.rejects(() => proseOnly.search({ query: 'test' }), WebSearchUnavailableError);

  const down = createDeepSeekSearchProvider({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('fetch failed'); },
  });
  await assert.rejects(() => down.search({ query: 'test' }), (error) => {
    assert.equal(error.name, 'WebSearchUnavailableError');
    return true;
  });
});
