import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicSession } from './anthropicSession.js';
import { t } from '../i18n/index.js';

function adapter() {
  const events = [];
  const requests = [];
  const session = createAnthropicSession({
    emit: (event) => events.push(event),
    runAction: async () => ({ ok: true }),
    fetchImpl: async (url) => {
      requests.push(url);
      return Response.json({
        content: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        finishReason: 'end_turn',
      });
    },
  });
  return { session, events, requests };
}

test('a voice start reports that Claude has no voice and leaves chat alone', () => {
  const { session, events, requests } = adapter();
  assert.equal(session.capabilities.textOnly, true);
  assert.equal(session.capabilities.pushToTalk, false);
  assert.equal(session.start({ pushToTalk: false }), false);
  assert.equal(session.start(), false);
  assert.deepEqual(events, [
    {
      type: 'state',
      state: 'error',
      detail: t('Claude has no voice. Open CHAT to type instead.'),
    },
    {
      type: 'state',
      state: 'error',
      detail: t('Claude has no voice. Open CHAT to type instead.'),
    },
  ]);
  assert.deepEqual(session.getStartOptions(), { pushToTalk: false });
  assert.equal(session.sendText('Hello'), false);
  assert.equal(session.sendMapEvent({ type: 'moved' }), false);
  assert.equal(session.cancelTurn(), false);
  assert.equal(session.ignoreButtonClick(), false);
  assert.deepEqual(requests, []);
});

test('a typed start runs chat until stop clears it', async () => {
  const { session, events, requests } = adapter();
  session.start({ textOnly: true, pushToTalk: true });
  assert.deepEqual(session.getStartOptions(), {
    pushToTalk: false,
    textOnly: true,
  });
  assert.equal(events.at(-1).state, 'listening');
  assert.equal(session.sendText('Hello'), true);
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/anthropic/chat']);
  assert.ok(
    events.some(
      (event) => event.type === 'completion' && event.status === 'completed',
    ),
  );
  session.stop();
  assert.deepEqual(session.getStartOptions(), { pushToTalk: false });
  assert.equal(events.at(-1).state, 'idle');
  assert.equal(session.sendText('Again'), false);
});
