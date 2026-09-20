import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoubaoAskQueue } from '../packages/connectors/src/doubao/ask-queue.js';

test('Doubao ask queue runs one message at a time and returns each reply', async () => {
  const started = [];
  const order = [];
  let current = 0;
  const queue = createDoubaoAskQueue({
    now: () => 1,
    async ask(question) {
      started.push(question);
      current += 1;
      assert.equal(current, 1);
      await Promise.resolve();
      current -= 1;
      order.push(question);
      return { status: 'ok', reply_text: `答 ${question}`, sent_message: question };
    },
  });

  const first = queue.enqueue({ question: 'one', purpose: 'web-search' });
  const second = queue.enqueue({ question: 'two', purpose: 'web-search' });
  const results = await Promise.all([first, second]);

  assert.deepEqual(started, ['one', 'two']);
  assert.deepEqual(order, ['one', 'two']);
  assert.equal(results[0].reply_text, '答 one');
  assert.equal(results[1].reply_text, '答 two');
  assert.equal(results[0].queue.purpose, 'web-search');
  assert.equal(results[1].queue.purpose, 'web-search');
  assert.equal(queue.snapshot().queued, 0);
  assert.equal(queue.snapshot().active, null);
});

test('Doubao ask queue still processes the next job after one ask throws', async () => {
  let count = 0;
  const queue = createDoubaoAskQueue({
    async ask() {
      count += 1;
      if (count === 1) throw new Error('boom');
      return { status: 'ok', reply_text: 'ok' };
    },
  });
  const first = queue.enqueue({ question: 'a', purpose: 'ask' });
  const second = queue.enqueue({ question: 'b', purpose: 'ask' });
  await assert.rejects(first, /boom/);
  assert.equal((await second).reply_text, 'ok');
});
