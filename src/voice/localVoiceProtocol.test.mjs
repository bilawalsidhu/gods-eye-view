import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLocalFrame,
  localSessionEvents,
  statusForFrame,
  isTerminalErrorFrame,
  LOCAL_VOICE_STATUS,
} from './localVoiceProtocol.js';

test('frames classify as binary audio, JSON, or noise', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(parseLocalFrame(bytes.buffer).kind, 'binary');
  assert.equal(parseLocalFrame(bytes).bytes.byteLength, 3);
  assert.deepEqual(parseLocalFrame('{"type":"ready","tts":"piper"}'), {
    kind: 'json',
    frame: { type: 'ready', tts: 'piper' },
  });
  assert.equal(parseLocalFrame('not json'), null);
  assert.equal(parseLocalFrame('{"noType":1}'), null);
  assert.equal(parseLocalFrame(null), null);
});

test('transcript and text frames become common session events', () => {
  assert.deepEqual(
    localSessionEvents({ type: 'transcript', text: ' Fly to Tokyo. ' }),
    [{ type: 'transcript', role: 'user', text: 'Fly to Tokyo.', final: true }],
  );
  assert.deepEqual(localSessionEvents({ type: 'transcript', text: '' }), []);
  assert.deepEqual(localSessionEvents({ type: 'text', text: 'On my way.' }), [
    { type: 'transcript', role: 'assistant', text: 'On my way.', final: true },
    { type: 'completion', status: 'completed' },
  ]);
  assert.deepEqual(localSessionEvents({ type: 'tool_call' }), []);
});

test('status mapping keeps the mic listening on soft failures', () => {
  assert.deepEqual(statusForFrame({ type: 'transcript', text: 'hi' }), {
    state: 'executing',
    detail: 'HEARD: hi',
  });
  assert.equal(
    statusForFrame({ type: 'transcript', text: 'hi', speaker: { name: 'Anthony', score: 0.8 } }).detail,
    'HEARD (Anthony): hi',
  );
  assert.equal(statusForFrame({ type: 'transcript', text: 'hi', speaker: null }).detail, 'HEARD: hi');
  assert.deepEqual(statusForFrame({ type: 'transcript', text: '' }), {
    state: 'listening',
    detail: LOCAL_VOICE_STATUS.nothingHeard,
  });
  assert.equal(
    statusForFrame({ type: 'transcript', text: 'x'.repeat(80) }).detail.length,
    'HEARD: '.length + 60,
  );
  assert.equal(statusForFrame({ type: 'tool_call' }).state, 'executing');
  assert.equal(statusForFrame({ type: 'text', text: 'ok' }).state, 'listening');
  assert.equal(
    statusForFrame({ type: 'error', error: 'timed out', terminal: false })
      .state,
    'listening',
  );
  assert.equal(statusForFrame({ type: 'error', error: 'dead' }).state, 'error');
  assert.equal(statusForFrame({ type: 'ready' }), null);
  assert.equal(isTerminalErrorFrame({ type: 'error' }), true);
  assert.equal(isTerminalErrorFrame({ type: 'error', terminal: false }), false);
  assert.equal(isTerminalErrorFrame({ type: 'text' }), false);
});
