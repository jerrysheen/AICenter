import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaggingRoutes } from '../apps/web/src/routes/tagging-routes.js';
import { createRouter } from '../apps/web/src/http/router.js';
import { createFeedTaggingLoader, planFeedTaggingRequests } from '../apps/web/public/feed-tagging.js';

function responseCapture() {
  return {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

function jsonRequest(body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

const identity = { kind: 'device', device: { workspaceId: 'local' } };

test('tagging ids are batched into POST bodies and not repeated inside the fresh window', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const loader = createFeedTaggingLoader({
    post: async (body) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(body.resourceIds);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      assert.equal(body.resourceType, 'content-item');
      return { items: body.resourceIds.map((resourceId) => ({ resourceId, tags: ['macro'] })) };
    },
    gapMs: 0,
    freshMs: 60_000,
    batch: 40,
    now: () => 1_000,
  });
  const ids = Array.from({ length: 90 }, (_, index) => `item-${index}`);
  const rows = await loader.load(ids);
  assert.equal(rows.length, 90);
  assert.deepEqual(calls.map((batch) => batch.length), [40, 40, 10]);
  assert.equal(maxActive, 1);
  assert.equal(calls.some((batch) => batch.join('&').includes('resourceId=')), false);
  const again = await loader.load(ids);
  assert.deepEqual(again, []);
  assert.equal(calls.length, 3);
  assert.deepEqual(planFeedTaggingRequests(['a', 'a', 'b'], { known: ['b'], batch: 40 }), [['a']]);
});

test('tagging query accepts a POST body and rejects a long GET query', async () => {
  const seen = [];
  const services = {
    tagging: {
      listTaggings(_workspaceId, _type, ids) {
        seen.push(ids);
        return ids.map((resourceId) => ({ resourceId, tags: ['ai'] }));
      },
      getTagging(_workspaceId, _type, resourceId) {
        return { resourceId, tags: ['ai'] };
      },
    },
  };
  const router = createRouter(createTaggingRoutes());
  const posted = responseCapture();
  const ids = Array.from({ length: 50 }, (_, index) => `id-${index}`);
  const found = await router.dispatch({
    request: jsonRequest({ resourceType: 'content-item', resourceIds: ids }),
    response: posted,
    services,
    identity,
    url: new URL('http://localhost/api/v1/tagging/query'),
  });
  assert.equal(found, true);
  assert.equal(posted.status, 200);
  assert.equal(posted.body.items.length, 50);
  assert.equal(seen[0].length, 50);
  assert.equal(String(posted.body).includes('resourceId='), false);

  const query = new URL('http://localhost/api/v1/tagging');
  for (let index = 0; index < 30; index += 1) query.searchParams.append('resourceId', `id-${index}`);
  const rejected = responseCapture();
  await router.dispatch({
    request: { method: 'GET' },
    response: rejected,
    services,
    identity,
    url: query,
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /POST/);
});
