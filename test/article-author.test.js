import test from 'node:test';
import assert from 'node:assert/strict';
import { articleAuthorTarget, feedSearchPath, feedSearchQueryReady, linkAbortSignal } from '../apps/web/public/feed-search.js';

test('article author click opens the stored author id', () => {
  assert.deepEqual(
    articleAuthorTarget({ platform: 'x', author: 'Miles Cranmer', authorId: 'x:382008009', handle: 'MilesCranmer' }),
    { kind: 'author', id: 'x:382008009' },
  );
  assert.deepEqual(
    articleAuthorTarget({ platform: 'x', author: 'Miles Cranmer', authorId: '', handle: 'MilesCranmer' }),
    { kind: 'author', id: 'x:@MilesCranmer' },
  );
  assert.deepEqual(
    articleAuthorTarget({ platform: 'official', author: '美联储', authorId: '' }),
    { kind: 'source', id: 'policy.美联储' },
  );
  assert.equal(feedSearchPath({ platform: 'all', query: 'Cranmer' }), '/api/v1/feed/search?q=Cranmer');
  assert.equal(feedSearchPath({ platform: 'x', query: 'Cranmer' }), '/api/v1/feed/search?q=Cranmer&platform=x');
  assert.equal(feedSearchQueryReady(''), false);
  assert.equal(feedSearchQueryReady('C'), false);
  assert.equal(feedSearchQueryReady(' Cr '), true);
  const previous = new AbortController();
  const next = new AbortController();
  const unlink = linkAbortSignal(next, previous.signal);
  previous.abort();
  assert.equal(next.signal.aborted, true);
  unlink();
});
