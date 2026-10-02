import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalRadioHandoff, pendingRadioPlayback } from './localRadio.js';
import {
  createSilentOutput,
  createSystemOutput,
  pickOnDeviceVoice,
} from './speechOutput.js';

function fakeRadio({ plays = true, delay = 0 } = {}) {
  const calls = [];
  return {
    calls,
    setVoiceDucked: (ducked) => calls.push(['ducked', ducked]),
    pause: (options) => {
      calls.push(['pause', options.origin]);
      return true;
    },
    playForVoice: async ({ attemptId }) => {
      calls.push(['play', attemptId]);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return plays;
    },
    stopPlayback: ({ attemptId }) => calls.push(['stop', attemptId]),
  };
}

const prepared = {
  ok: true,
  action: 'control_radio',
  radioPlaybackRequested: true,
};

test('a prepared station plays muted, then voice stops and releases it', async () => {
  const radio = fakeRadio();
  const handoff = createLocalRadioHandoff({ radioLayer: radio });
  let stopped = 0;
  const outcome = await handoff.start(prepared, {
    stopVoice: () => {
      stopped++;
      handoff.release();
    },
  });
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.result.audioState, 'playing');
  assert.equal(stopped, 1);
  assert.deepEqual(radio.calls, [
    ['ducked', true],
    ['play', 'voice-local-radio-1'],
    ['ducked', false],
  ]);
});

test('a newer turn cancels the handoff and stops only its attempt', async () => {
  const radio = fakeRadio({ delay: 20 });
  const handoff = createLocalRadioHandoff({ radioLayer: radio });
  let stopped = 0;
  const pending = handoff.start(prepared, { stopVoice: () => stopped++ });
  assert.equal(handoff.inFlight, true);
  assert.equal(handoff.silenceForVoice(), false, 'voice does not pause it');
  handoff.cancel();
  const outcome = await pending;
  assert.equal(outcome.cancelled, true);
  assert.equal(stopped, 0);
  assert.deepEqual(
    radio.calls.filter(([name]) => name === 'stop'),
    [
      ['stop', 'voice-local-radio-1'],
      ['stop', 'voice-local-radio-1'],
    ],
  );
});

test('a station that fails to start keeps voice on and reports the error', async () => {
  const radio = fakeRadio({ plays: false });
  const handoff = createLocalRadioHandoff({ radioLayer: radio });
  let stopped = 0;
  const outcome = await handoff.start(prepared, {
    isCurrent: () => true,
    stopVoice: () => stopped++,
  });
  assert.equal(stopped, 0);
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.audioState, 'error');
});

test('voice speech silences Radio when no handoff is running', () => {
  const radio = fakeRadio();
  const handoff = createLocalRadioHandoff({ radioLayer: radio });
  assert.equal(handoff.silenceForVoice(), true);
  assert.deepEqual(radio.calls, [
    ['ducked', true],
    ['pause', 'voice-duck'],
  ]);
  assert.equal(pendingRadioPlayback([{ result: { ok: true } }]), null);
  assert.equal(
    pendingRadioPlayback([
      { result: { ok: false, radioPlaybackRequested: true } },
      { result: prepared },
    ]),
    prepared,
  );
});

test('the system voice uses only on-device voices', async () => {
  assert.equal(
    pickOnDeviceVoice([{ lang: 'en-US', localService: false }]),
    null,
  );
  const local = { lang: 'en-GB', localService: true };
  assert.equal(pickOnDeviceVoice([local]), local);
  const spoken = [];
  let cancelled = 0;
  const synthesis = {
    speak: (utterance) => spoken.push(utterance),
    cancel: () => cancelled++,
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const output = createSystemOutput({ synthesis, Utterance, voice: local });
  await output.speak('One.');
  await output.speak('Two.');
  assert.deepEqual(
    spoken.map((utterance) => [utterance.text, utterance.voice]),
    [
      ['One.', local],
      ['Two.', local],
    ],
  );
  let idle = false;
  const waiting = output.idle().then(() => {
    idle = true;
  });
  spoken[0].onend();
  await Promise.resolve();
  assert.equal(idle, false);
  spoken[1].onend();
  await waiting;
  output.stop();
  assert.equal(cancelled, 1);
  const silent = createSilentOutput();
  assert.equal(await silent.speak('x'), null);
});
