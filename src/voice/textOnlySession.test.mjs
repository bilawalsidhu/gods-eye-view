import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicSession } from './anthropicSession.js';
import { createVertexSession } from './vertexSession.js';
import { createBedrockSession } from './bedrockSession.js';
import { t } from '../i18n/index.js';

// Each chat-only provider: its session factory, route, reply and messages.
const providers = {
  anthropic: {
    create: createAnthropicSession,
    endpoint: '/api/anthropic/chat',
    reply: {
      content: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      finishReason: 'end_turn',
    },
    refusal: () => t('Claude has no voice. Open CHAT to type instead.'),
    advisory: () =>
      t(
        'Claude answers in chat only; voice is not available for this provider.',
      ),
  },
  vertex: {
    create: createVertexSession,
    endpoint: '/api/vertex/chat',
    reply: {
      content: { role: 'model', parts: [{ text: 'Hi' }] },
      finishReason: 'STOP',
    },
    refusal: () => t('Vertex AI has no voice. Open CHAT to type instead.'),
    advisory: () =>
      t(
        'Vertex AI answers in chat only; voice is not available for this provider.',
      ),
  },
  bedrock: {
    create: createBedrockSession,
    endpoint: '/api/bedrock/chat',
    reply: {
      content: { role: 'assistant', content: [{ text: 'Hi' }] },
      finishReason: 'end_turn',
    },
    refusal: () => t('Amazon Bedrock has no voice. Open CHAT to type instead.'),
    advisory: () =>
      t(
        'Amazon Bedrock answers in chat only; voice is not available for this provider.',
      ),
  },
};

function adapter(provider) {
  const events = [];
  const requests = [];
  const session = provider.create({
    emit: (event) => events.push(event),
    runAction: async () => ({ ok: true }),
    fetchImpl: async (url) => {
      requests.push(url);
      return Response.json(provider.reply);
    },
  });
  return { session, events, requests };
}

for (const [name, provider] of Object.entries(providers)) {
  test(`${name}: a voice start reports there is no voice and leaves chat alone`, () => {
    const { session, events, requests } = adapter(provider);
    assert.equal(session.capabilities.textOnly, true);
    assert.equal(session.capabilities.pushToTalk, false);
    assert.equal(session.capabilities.costControls, false);
    assert.equal(session.capabilities.advisoryLimit, provider.advisory());
    assert.equal(session.start({ pushToTalk: false }), false);
    assert.equal(session.start(), false);
    const refusal = {
      type: 'state',
      state: 'error',
      detail: provider.refusal(),
    };
    assert.deepEqual(events, [refusal, refusal]);
    assert.deepEqual(session.getStartOptions(), { pushToTalk: false });
    assert.equal(session.sendText('Hello'), false);
    assert.equal(session.sendMapEvent({ type: 'moved' }), false);
    assert.equal(session.cancelTurn(), false);
    assert.equal(session.ignoreButtonClick(), false);
    assert.deepEqual(requests, []);
  });

  test(`${name}: a typed start runs chat until stop clears it`, async () => {
    const { session, events, requests } = adapter(provider);
    session.start({ textOnly: true, pushToTalk: true });
    assert.deepEqual(session.getStartOptions(), {
      pushToTalk: false,
      textOnly: true,
    });
    assert.equal(events.at(-1).state, 'listening');
    assert.equal(session.sendText('Hello'), true);
    for (let i = 0; i < 8; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, [provider.endpoint]);
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
}
