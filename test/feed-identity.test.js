import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFeedIdentityHash, feedItemIdentityHash } from '../packages/domain/src/feed-identity.js';

test('feed identity hash is stable for author plus tweet text', () => {
  const left = computeFeedIdentityHash({
    provider: 'x',
    authorHandle: '@Alice',
    authorName: 'Alice',
    text: 'Hello  World\nhttps://x.com/a',
  });
  const right = computeFeedIdentityHash({
    provider: 'x',
    authorHandle: 'alice',
    text: 'hello world\nhttps://x.com/a',
  });
  assert.equal(left, right);
  assert.equal(left.length, 64);
  assert.notEqual(computeFeedIdentityHash({
    provider: 'x',
    authorHandle: 'bob',
    text: 'hello world\nhttps://x.com/a',
  }), left);
  assert.notEqual(computeFeedIdentityHash({
    provider: 'x',
    authorHandle: 'alice',
    text: 'hello world again',
  }), left);
});

test('empty tweet text falls back to the platform id so media posts do not collide', () => {
  const first = computeFeedIdentityHash({
    provider: 'x',
    authorHandle: 'alice',
    text: '   ',
    externalId: 'tweet-1',
  });
  const second = computeFeedIdentityHash({
    provider: 'x',
    authorHandle: 'alice',
    text: '',
    externalId: 'tweet-2',
  });
  assert.notEqual(first, second);
  assert.equal(feedItemIdentityHash('x', {
    authorHandle: '@alice',
    body: '',
    externalId: 'tweet-1',
  }), first);
});
