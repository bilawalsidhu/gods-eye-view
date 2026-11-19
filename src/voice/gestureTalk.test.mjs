// Hand-gesture microphone toggle: the same claim and release as holding Space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeInput } from './realtimeInput.js';
import {
  gestureTalkListening,
  registerGestureTalkInput,
  toggleGestureTalk,
  unregisterGestureTalkInput,
} from './gestureTalk.js';

function fakeInput({ active = false } = {}) {
  const calls = [];
  const track = { enabled: false };
  const root = {};
  const ui = {
    state: {},
    update: (key, value) => {
      if (key === 'root') Object.assign(root, value);
    },
  };
  let isActive = active;
  let status = 'listening';
  const input = new RealtimeInput({
    readUi: () => ui,
    readStream: () => ({ getAudioTracks: () => [track] }),
    readStatus: () => status,
    operations: {
      isActive: () => isActive,
      setStatus: (s, detail) => calls.push(['status', s, detail]),
      start: (settings) => {
        calls.push(['start', settings]);
        isActive = true;
        input.pushToTalkMode = settings.pushToTalk;
      },
      pauseRadioForVoice: () => calls.push(['pauseRadio']),
      bargeIn: () => calls.push(['bargeIn']),
      holdPointer: () => calls.push(['holdPointer']),
      releasePointerHold: () => calls.push(['releasePointer']),
      beginPointerTurn: (at) => calls.push(['turn', at]),
      mayClaimSpeaker: () => true,
    },
  });
  return { input, calls, track, root };
}

test('no voice registered: the gesture reports unavailable', () => {
  assert.equal(toggleGestureTalk(), 'unavailable');
  assert.equal(gestureTalkListening(), false);
});

test('first 🤙 starts a push-to-talk session, the second sends', () => {
  const { input, calls, track } = fakeInput();
  registerGestureTalkInput(input);
  try {
    assert.equal(toggleGestureTalk(), 'listening');
    assert.deepEqual(
      calls.find((c) => c[0] === 'start'),
      ['start', { pushToTalk: true }],
    );
    assert.ok(calls.some((c) => c[0] === 'pauseRadio'));
    assert.equal(gestureTalkListening(), true);
    assert.equal(toggleGestureTalk(), 'sent');
    assert.equal(gestureTalkListening(), false);
    assert.equal(track.enabled, false, 'microphone muted on send');
  } finally {
    unregisterGestureTalkInput(input);
  }
});

test('in a live push-to-talk session the gesture opens the mic and barges in', () => {
  const { input, calls, track, root } = fakeInput({ active: true });
  input.pushToTalkMode = true;
  registerGestureTalkInput(input);
  try {
    assert.equal(toggleGestureTalk(), 'listening');
    assert.equal(track.enabled, true);
    assert.equal(root.pushToTalk, 'held');
    assert.ok(calls.some((c) => c[0] === 'bargeIn'));
    assert.ok(calls.some((c) => c[0] === 'status' && /🤙/.test(c[2])));
    assert.equal(toggleGestureTalk(), 'sent');
    assert.equal(track.enabled, false);
  } finally {
    unregisterGestureTalkInput(input);
  }
});

test('a click-started open-mic session is left alone', () => {
  const { input, track } = fakeInput({ active: true });
  input.pushToTalkMode = false;
  registerGestureTalkInput(input);
  try {
    assert.equal(toggleGestureTalk(), 'open-mic');
    assert.equal(track.enabled, false);
  } finally {
    unregisterGestureTalkInput(input);
  }
});
