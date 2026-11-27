// src/voice/realtimePresentation.test.mjs — the dock's assistant phase follows
// resolveVoicePresentationState() through the real Realtime controller: the
// voice card's response/audio events, Space barge-in, and the phase line the
// typed-chat owner renders.
import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindChatControl } from './chatControl.js';
import { GevRealtimeController } from './realtimeController.js';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';

// A voice (not typed) session that relays the controller's events.
function voiceSession() {
  const listeners = new Set();
  const session = {
    state: 'idle',
    adapter: { getStartOptions: () => ({ textOnly: false }) },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      if (event.type === 'state') session.state = event.state;
      for (const fn of [...listeners]) fn(event);
    },
    isActive: () => !['idle', 'error'].includes(session.state),
    stop() {},
  };
  return session;
}

function fixture(t) {
  const session = voiceSession();
  const ui = createTestVoiceUi({ panel: true });
  const chat = bindChatControl({ ui, session });
  t.after(() => chat.destroy());
  const states = [];
  const controller = new GevRealtimeController({
    ui,
    runner: async () => ({ ok: true }),
    debugSink: null,
    onSessionEvent: (event) => {
      if (event.type === 'presentation') states.push(event.state);
      session.emit(event);
    },
  });
  const sent = [];
  controller.dc = {
    readyState: 'open',
    send: (body) => sent.push(JSON.parse(body)),
    close() {},
  };
  const event = (payload) =>
    controller.handleRealtimeEvent({ data: JSON.stringify(payload) });
  controller.setStatus('listening', 'Ask or command');
  const phase = () => ui.state.phase.text;
  return { controller, ui, sent, states, event, phase };
}

test('a reply is WORKING until its audio starts, and SPEAKING while it drains', async (t) => {
  const { states, event, phase } = fixture(t);
  assert.equal(phase(), 'READY');
  await event({ type: 'response.created', response: { id: 'resp_1' } });
  assert.equal(phase(), 'WORKING', 'response.created is not audible proof');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_1' });
  assert.equal(phase(), 'SPEAKING');
  await event({
    type: 'response.done',
    response: { id: 'resp_1', status: 'completed', output: [] },
  });
  assert.equal(phase(), 'SPEAKING', 'audio drains after response.done');
  await event({ type: 'output_audio_buffer.stopped', response_id: 'resp_1' });
  assert.equal(phase(), 'READY');
  assert.deepEqual(states, ['ready', 'working', 'speaking', 'ready']);
});

test('an accepted Space barge-in interrupts, then the user turn shows LISTENING', async (t) => {
  const { controller, sent, states, event, phase } = fixture(t);
  await event({ type: 'response.created', response: { id: 'resp_1' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_1' });
  // The path RealtimeInput takes on a claimed Space hold.
  assert.equal(controller._input.bargeIn(), true);
  assert.deepEqual(
    sent.map((message) => message.type),
    ['response.cancel', 'output_audio_buffer.clear'],
  );
  assert.equal(states.at(-1), 'interrupted');
  assert.equal(phase(), 'LISTENING');
  await event({ type: 'input_audio_buffer.speech_started' });
  assert.equal(states.at(-1), 'listening');
  assert.equal(phase(), 'LISTENING');
});

test('a Space press refused while Radio owns the speaker stays SPEAKING', async (t) => {
  const { controller, sent, states, event, phase } = fixture(t);
  await event({ type: 'response.created', response: { id: 'resp_1' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_1' });
  controller._radio.mayVoiceClaimSpeaker = () => false;
  assert.equal(controller._input.bargeIn(), false);
  assert.deepEqual(sent, []);
  assert.equal(states.includes('interrupted'), false);
  assert.equal(phase(), 'SPEAKING');
});

test('a running tool shows EXECUTING beside the card, and stop clears the phase', async (t) => {
  const { controller, states, phase } = fixture(t);
  controller.setStatus('executing', 'Running command');
  assert.equal(phase(), 'EXECUTING');
  controller.setStatus('idle', 'Voice off');
  assert.equal(states.at(-1), 'idle');
  assert.equal(phase(), '');
});

test('a provider without a projection keeps the LISTENING phase', (t) => {
  const session = voiceSession();
  const ui = createTestVoiceUi({ panel: true });
  const chat = bindChatControl({ ui, session });
  t.after(() => chat.destroy());
  session.emit({ type: 'state', state: 'listening' });
  assert.equal(ui.state.phase.text, 'LISTENING');
});
