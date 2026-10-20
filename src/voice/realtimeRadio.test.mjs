import test from 'node:test';
import assert from 'node:assert/strict';
import { GevRealtimeController } from './realtimeController.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const playback = (id) => ({
  ok: true,
  action: 'control_radio',
  radioAction: 'play',
  radioPlaybackRequested: true,
  id,
});

function fixture(t) {
  const attempts = [],
    stopped = [],
    corrections = [],
    states = [];
  const controller = new GevRealtimeController({
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
        remove() {},
      },
      status: {},
      detail: {},
      errorDetail: {},
    },
    runner: async () => ({ ok: false }),
    debugSink: null,
    onSessionEvent: (event) => states.push(event),
    radioLayer: {
      setVoiceDucked() {},
      playForVoice: ({ attemptId }) =>
        new Promise((resolve, reject) =>
          attempts.push({ attemptId, resolve, reject }),
        ),
      stopPlayback: (options) => stopped.push(options),
    },
  });
  controller.queueResponseCreate = (message) => corrections.push(message);
  controller.dc = { readyState: 'open', send() {}, close() {} };
  t.after(() => controller.stop({ removeUi: true }));
  return { controller, attempts, stopped, corrections, states };
}

test('default OpenAI reservation silences rejected frozen preflight and resumes retained result after failure', async (t) => {
  const h = fixture(t),
    c = h.controller;
  const a = playback('A');
  c.pendingRadioPlaybackResult = a;
  const pending = c.startPendingRadioHandoff();
  const reservation = c.reserveRadioToolHandoff();
  assert.equal(c.pendingRadioPlaybackResult, a);
  assert.equal(c.radioHandoffInFlight, false);
  h.attempts[0].reject(new Error('obsolete frozen preflight'));
  await pending;
  assert.deepEqual(h.corrections, []);
  assert.equal(
    h.states.some((event) => event.detail === 'Radio did not start'),
    false,
  );
  c.settleRadioToolHandoffReservation(reservation, { commit: false });
  await tick();
  assert.equal(h.attempts.length, 2);
  assert.equal(c.radioHandoffInFlightResult, a);
  assert.notEqual(h.attempts[0].attemptId, h.attempts[1].attemptId);
  h.attempts[1].reject(new Error('current preflight failed'));
  await tick();
  assert.equal(h.corrections.length, 1);
  assert.equal(c.status, 'listening');
});

test('default OpenAI group cancellation silences rejected preflight without blocking the next failure correction', async (t) => {
  const h = fixture(t),
    c = h.controller;
  c.pendingRadioPlaybackResult = playback('A');
  const old = c.startPendingRadioHandoff();
  c.cancelRadioHandoff();
  h.attempts[0].reject(new Error('cancelled preflight'));
  await old;
  assert.deepEqual(h.corrections, []);
  c.pendingRadioPlaybackResult = playback('B');
  const current = c.startPendingRadioHandoff();
  h.attempts[1].resolve(false);
  await current;
  assert.equal(h.corrections.length, 1);
});

test('per-result cancellation retains sibling result and epoch and ignores late failure or duplicate cancellation', async (t) => {
  const h = fixture(t),
    c = h.controller;
  const a = playback('A'),
    b = playback('B');
  c.pendingRadioPlaybackResult = a;
  const old = c.startPendingRadioHandoff();
  const siblingEpoch = c.radioHandoffEpoch;
  c.pendingRadioPlaybackResult = b;
  c._radio.cancelPlaybackResult(a);
  c._radio.cancelPlaybackResult(a);
  c._radio.cancelPlaybackResult(playback('unknown'));
  assert.equal(c.radioHandoffEpoch, siblingEpoch);
  assert.equal(c.pendingRadioPlaybackResult, b);
  assert.equal(h.stopped.length, 1);
  h.attempts[0].reject(new Error('late cancelled preflight'));
  await old;
  assert.deepEqual(h.corrections, []);
  const current = c.startPendingRadioHandoff();
  const reservation = c.reserveRadioToolHandoff();
  c._radio.cancelPlaybackResult(b);
  assert.equal(c._radio.radioToolHandoffReservations.has(reservation), true);
  h.attempts[1].resolve(false);
  await current;
  assert.deepEqual(h.corrections, []);
  c.settleRadioToolHandoffReservation(reservation, { commit: false });
  await tick();
  assert.equal(h.attempts.length, 2, 'a cancelled result cannot be resumed');
});
