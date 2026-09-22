import test from 'node:test';
import assert from 'node:assert/strict';
import { createNvidiaSession, selectVoiceForText } from './nvidiaSession.js';
import { formatNvidiaTools } from '../../server/providers/nvidia.js';

test('formatNvidiaTools formats tools to OpenAI/NVIDIA function schema', () => {
  const dummyTools = [
    {
      name: 'fly_to_location',
      description: 'Fly the camera to a named city',
      parameters: {
        type: 'object',
        properties: {
          locationId: { type: 'string' },
        },
      },
    },
  ];

  const formatted = formatNvidiaTools(dummyTools);
  assert.equal(formatted.length, 1);
  assert.equal(formatted[0].type, 'function');
  assert.equal(formatted[0].function.name, 'fly_to_location');
  assert.equal(formatted[0].function.description, 'Fly the camera to a named city');
  assert.deepEqual(formatted[0].function.parameters, dummyTools[0].parameters);
});

test('createNvidiaSession creates an adapter with capabilities and methods', () => {
  const events = [];
  const session = createNvidiaSession({
    emit: (event) => events.push(event),
    runAction: async (name, args) => ({ ok: true, name, args }),
  });

  assert.equal(session.capabilities.costControls, false);
  assert.equal(session.capabilities.pushToTalk, true);
  assert.equal(typeof session.start, 'function');
  assert.equal(typeof session.stop, 'function');
  assert.equal(typeof session.sendText, 'function');
  assert.equal(typeof session.sendMapEvent, 'function');
  assert.equal(typeof session.bindControls, 'function');

  session.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'state');
  assert.equal(events[0].state, 'idle');
});

test('selectVoiceForText returns null without window speechSynthesis', () => {
  assert.equal(selectVoiceForText('hello'), null);
  assert.equal(selectVoiceForText('नमस्ते'), null);
  assert.equal(selectVoiceForText('', 'friday'), null);
});

test('createNvidiaSession start/stop lifecycle emits expected state events', () => {
  const events = [];
  const session = createNvidiaSession({
    emit: (event) => events.push(event),
    runAction: async (name, args) => ({ ok: true, name, args }),
  });
  // start() will try to use SpeechRecognition which is absent in Node —
  // it should emit a connecting state and then an error state, never throw.
  assert.doesNotThrow(() => session.start());
  session.stop();
  const states = events.map((e) => e.state);
  assert.ok(states.includes('idle'));
  assert.ok(states.includes('connecting') || states.includes('error'));
});

test('createNvidiaSession sendText is a no-op without active session', () => {
  const events = [];
  const session = createNvidiaSession({
    emit: (event) => events.push(event),
    runAction: async () => ({ ok: true }),
  });
  assert.doesNotThrow(() => session.sendText('hello'));
  session.stop();
});

test('createNvidiaSession ignoreButtonClick returns false when space not held', () => {
  const session = createNvidiaSession({
    emit: () => {},
    runAction: async () => ({ ok: true }),
  });
  assert.equal(session.ignoreButtonClick(), false);
  session.stop();
});
