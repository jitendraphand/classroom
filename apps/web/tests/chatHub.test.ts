import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { subscribeChat, chatHubStats } from '../src/lib/chatHub';

test('chat hub shares one subscriber and unsubscribes the last listener', async () => {
  let dups = 0;
  const subs: string[] = [];
  const unsubs: string[] = [];
  const sub = Object.assign(new EventEmitter(), {
    status: 'ready',
    subscribe: async (c: string) => void subs.push(c),
    unsubscribe: async (c: string) => void unsubs.push(c),
  });
  const base = async () => ({ duplicate: () => (dups++, sub) }) as never;
  const got: string[] = [];
  const a = await subscribeChat(base, 'ch1', (m) => got.push('a' + m));
  const b = await subscribeChat(base, 'ch1', (m) => got.push('b' + m));
  sub.emit('message', 'ch1', 'x');
  assert.deepEqual(got, ['ax', 'bx']);
  assert.equal(dups, 1);
  assert.deepEqual(subs, ['ch1']);
  a();
  a();
  assert.deepEqual(unsubs, []);
  b();
  assert.deepEqual(unsubs, ['ch1']);
  assert.deepEqual(chatHubStats(), { channels: 0, listeners: 0 });
});
