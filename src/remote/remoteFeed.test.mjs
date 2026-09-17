import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICK_ACTIONS,
  REMOTE_STATUS,
  createRemoteState,
  describeToolCall,
  micSupported,
  reconnectDelay,
  reduceHubMessage,
  remoteSocketUrl,
} from './remoteFeed.js';

test('hub messages become transcript lines and status hints', () => {
  const state = createRemoteState();
  const first = reduceHubMessage(state, { type: 'sessions', active: [] });
  assert.deepEqual(first.lines, [], 'the first roster is not announced');
  assert.equal(first.status, REMOTE_STATUS.noSession);
  const started = reduceHubMessage(state, { type: 'sessions', active: ['a'] });
  assert.deepEqual(started.lines, [
    { role: 'system', text: 'Globe voice session started' },
  ]);
  assert.equal(started.status, REMOTE_STATUS.active);
  assert.deepEqual(state.active, ['a']);
  const session = (frame) =>
    reduceHubMessage(state, { type: 'session', sessionId: 'a', frame });
  assert.deepEqual(
    session({ type: 'ready', model: 'qwen3:8b', tts: 'piper' }).lines,
    [{ role: 'system', text: 'Globe voice ready · qwen3:8b' }],
  );
  const heard = session({
    type: 'transcript',
    text: ' show flights ',
    source: 'remote',
  });
  assert.deepEqual(heard.lines, [
    { role: 'user', text: 'show flights', source: 'remote' },
  ]);
  assert.equal(heard.status, REMOTE_STATUS.thinking);
  const spoken = session({ type: 'transcript', text: 'zoom out' });
  assert.equal(spoken.lines[0].source, 'globe');
  const silence = session({ type: 'transcript', text: '', noSpeech: true });
  assert.deepEqual(silence.lines, []);
  assert.equal(silence.status, REMOTE_STATUS.nothingHeard);
  assert.equal(session({ type: 'thinking' }).status, REMOTE_STATUS.thinking);
  const call = session({
    type: 'tool_call',
    callId: 'c1',
    name: 'set_layer_visibility',
    arguments: { layer: 'flights', visible: true },
  });
  assert.deepEqual(call.lines, [
    { role: 'tool', text: 'set_layer_visibility layer=flights visible=true' },
  ]);
  assert.equal(call.status, REMOTE_STATUS.running);
  const reply = session({ type: 'text', text: 'Flights are on.' });
  assert.deepEqual(reply.lines, [
    { role: 'assistant', text: 'Flights are on.', source: 'globe' },
  ]);
  assert.equal(reply.status, REMOTE_STATUS.active);
  assert.equal(session({ type: 'audio_end' }).status, REMOTE_STATUS.active);
  assert.deepEqual(session({ type: 'audio_chunk', pcm16: 'x' }).lines, []);
  const soft = session({ type: 'error', error: 'Tool loop', terminal: false });
  assert.deepEqual(soft.lines, [{ role: 'error', text: 'Tool loop' }]);
  assert.equal(soft.status, REMOTE_STATUS.active);
  assert.equal(
    session({ type: 'error', error: 'Worker died', terminal: true }).status,
    REMOTE_STATUS.noSession,
  );
  assert.deepEqual(
    reduceHubMessage(state, { type: 'error', error: 'No voice session' })
      .lines,
    [{ role: 'error', text: 'No voice session' }],
  );
  assert.deepEqual(reduceHubMessage(state, { type: 'ack', command: 'text' }), {
    lines: [],
    status: null,
  });
  assert.deepEqual(reduceHubMessage(state, null), { lines: [], status: null });
  const ended = reduceHubMessage(state, { type: 'sessions', active: [] });
  assert.deepEqual(ended.lines, [
    { role: 'system', text: 'Globe voice session ended' },
  ]);
  assert.equal(ended.status, REMOTE_STATUS.noSession);
});

test('tool call summaries stay short and tolerate odd frames', () => {
  assert.equal(describeToolCall({ name: 'reset_view' }), 'reset_view');
  assert.equal(describeToolCall(null), 'tool');
  const long = describeToolCall({
    name: 'fly_to',
    arguments: { note: 'x'.repeat(200) },
  });
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('...'));
});

test('socket URL, backoff and mic availability follow the page context', () => {
  assert.equal(
    remoteSocketUrl({ protocol: 'http:', host: '192.168.1.50:4173' }),
    'ws://192.168.1.50:4173/api/voice/remote',
  );
  assert.equal(
    remoteSocketUrl({ protocol: 'https:', host: 'gev.local' }, '/ws'),
    'wss://gev.local/ws',
  );
  assert.equal(remoteSocketUrl(undefined, 'wss://x/y'), 'wss://x/y');
  assert.deepEqual(
    [0, 1, 2, 3, 4, 9].map((attempt) => reconnectDelay(attempt)),
    [1000, 2000, 4000, 8000, 15000, 15000],
  );
  assert.equal(reconnectDelay(-2), 1000);
  const mediaDevices = { getUserMedia() {} };
  assert.equal(micSupported({ mediaDevices, isSecureContext: true }), true);
  assert.equal(micSupported({ mediaDevices, isSecureContext: false }), false);
  assert.equal(micSupported({ isSecureContext: true }), false);
  assert.equal(micSupported(), false);
  assert.equal(QUICK_ACTIONS.length, 8);
  assert.ok(Object.isFrozen(QUICK_ACTIONS));
});
