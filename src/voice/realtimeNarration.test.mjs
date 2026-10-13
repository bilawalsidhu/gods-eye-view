import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './realtimeController.js';
import { PROGRESS_MAX_OUTPUT_TOKENS } from './realtimeTurns.js';

function controllerFixture({ runner = async () => ({ ok: true }) } = {}) {
  const sent = [];
  const statuses = [];
  const usage = [];
  const controller = new GevRealtimeController({
    ui: {
      root: { dataset: {}, classList: { remove() {} }, querySelectorAll: () => [] },
      status: { textContent: '' },
      detail: { textContent: '', title: '' },
      errorDetail: { textContent: '' },
    },
    runner,
    debugSink: null,
  });
  const setStatus = controller.setStatus.bind(controller);
  controller.setStatus = (status, detail) => {
    statuses.push(status);
    return setStatus(status, detail);
  };
  const recordUsage = controller.recordUsage.bind(controller);
  controller.recordUsage = (value) => {
    if (value) usage.push(value);
    return recordUsage(value);
  };
  controller.dc = {
    readyState: 'open',
    send: (body) => sent.push(JSON.parse(body)),
    close() {},
  };
  const event = (payload) =>
    controller.handleRealtimeEvent({ data: JSON.stringify(payload) });
  // Server errors carry their own event_id; the client's id is in error.event_id.
  let serverSeq = 0;
  const rejection = (clientEventId, code = 'invalid_request_error') =>
    event({
      type: 'error',
      event_id: `event_server_${++serverSeq}`,
      error: { type: 'invalid_request_error', code, message: 'rejected', event_id: clientEventId },
    });
  const progressLine = async (id = 'resp_p', line = 'Heading to Austin.') => {
    assert.equal(controller._turns.speakProgressLine(line), true);
    const request = sent.at(-1);
    await event({ type: 'response.created', response: { id, metadata: { gev: 'progress' } } });
    return request;
  };
  return { controller, sent, statuses, usage, event, rejection, progressLine };
}

const types = (sent) => sent.map((message) => message.type);

test('Space barge-in cancels the reply and clears audio; WebRTC truncates, so no manual truncate', async () => {
  const { controller, sent, statuses, event, rejection } = controllerFixture();
  await event({ type: 'response.created', response: { id: 'resp_1' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_1' });
  controller.pendingResponseInstructions = 'queued follow-up';

  assert.equal(controller._turns.bargeIn(), true);
  assert.deepEqual(types(sent), ['response.cancel', 'output_audio_buffer.clear']);
  assert.equal(sent[0].response_id, 'resp_1');
  assert.equal(controller.pendingResponseInstructions, null, 'no queued follow-up talks over the user');
  assert.equal(controller.isSupersededResponse('resp_1'), true, 'late calls from the cut reply are refused');

  // The target may already have finished. The rejection names the client id
  // in error.event_id while the envelope has a different server id.
  await rejection(sent[0].event_id, 'response_cancel_not_active');
  await rejection(sent[1].event_id);
  assert.equal(statuses.includes('error'), false);
});

test('an unrelated server error with a colliding top-level id is still fatal', async () => {
  const { controller, sent, statuses, event } = controllerFixture();
  await event({ type: 'response.created', response: { id: 'resp_1' } });
  controller._turns.bargeIn();
  await event({ type: 'error', event_id: sent[0].event_id, error: { code: 'server_error', message: 'boom' } });
  assert.equal(statuses.includes('error'), true, 'only error.event_id correlates a client event');
});

test('a rejected progress line releases the waiting reply without an error state', async () => {
  const { controller, sent, statuses, rejection } = controllerFixture();
  controller._turns.speakProgressLine('Heading to Austin.');
  controller.queueResponseCreate('Speak the say line.');
  assert.equal(sent.length, 1, 'the follow-up waits behind the line');
  await rejection(sent[0].event_id);
  assert.equal(statuses.includes('error'), false);
  assert.equal(sent.at(-1).type, 'response.create');
  assert.equal(sent.at(-1).response.instructions, 'Speak the say line.');
});

test('progress requests are out of band, bounded, and carry the line only as data', async () => {
  const { controller, sent } = controllerFixture();
  const line = 'Finding Texas State Capitol on the map.';
  assert.equal(controller._turns.speakProgressLine(line), true);
  const { response } = sent[0];
  assert.equal(response.conversation, 'none');
  assert.equal(response.tool_choice, 'none');
  assert.equal(response.max_output_tokens, PROGRESS_MAX_OUTPUT_TOKENS);
  assert.ok(PROGRESS_MAX_OUTPUT_TOKENS <= 100);
  assert.deepEqual(response.metadata, { gev: 'progress' });
  assert.equal(response.input[0].content[0].text, line);
  assert.equal(response.instructions.includes('Capitol'), false, 'labels never enter instructions');
  assert.equal(controller._turns.speakProgressLine('Another line.'), false, 'one line at a time');
});

test('a cancelled progress response never clears a pending Radio handoff', async () => {
  const { controller, sent, event, progressLine, usage } = controllerFixture();
  await progressLine('resp_p');
  // Radio prepared its playback while the line was generating.
  controller.pendingRadioPlaybackResult = { ok: true, radioPlaybackRequested: true };
  controller.queueResponseCreate('Say "Turning on the radio."');
  controller._turns.retractProgressLine();
  await event({
    type: 'response.done',
    response: { id: 'resp_p', status: 'cancelled', metadata: { gev: 'progress' }, usage: { input_tokens: 5, output_tokens: 3 } },
  });
  assert.ok(controller.pendingRadioPlaybackResult, 'Radio stays pending');
  assert.equal(sent.at(-1).type, 'response.create');
  assert.match(sent.at(-1).response.instructions, /Turning on the radio/, 'the confirmation is not stranded');
  assert.equal(usage.length, 1, 'progress usage is still billed');
});

test('an old progress completion leaves the active in-band response alone', async () => {
  const { controller, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  // Server VAD starts a real reply while the line is still generating.
  await event({ type: 'response.created', response: { id: 'resp_real' } });
  await event({ type: 'response.output_audio_transcript.done', response_id: 'resp_p', transcript: 'Heading to Austin.' });
  await event({ type: 'response.done', response: { id: 'resp_p', status: 'completed', metadata: { gev: 'progress' } } });
  assert.equal(controller.activeResponseId, 'resp_real');
  assert.equal(controller.responseActive, true);
});

test('user speech stops an audible progress line: cancel and clear its audio', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  sent.length = 0;
  await event({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual(types(sent), ['response.cancel', 'output_audio_buffer.clear']);
  assert.equal(sent[0].response_id, 'resp_p');
});

test('a typed command stops an audible progress line too', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  await event({ type: 'response.done', response: { id: 'resp_p', status: 'completed', metadata: { gev: 'progress' } } });
  sent.length = 0;
  controller.sendTextCommand('go to Paris');
  assert.equal(types(sent)[0], 'output_audio_buffer.clear', 'playback still owned after generation ended');
});

test('a finished tool lets a heard line finish, and playback ownership outlives response.done', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  controller._turns.retractProgressLine();
  assert.equal(types(sent).includes('response.cancel'), false, 'audible lines are not cut');
  controller.queueResponseCreate('Speak the say line.');
  assert.equal(types(sent).filter((t) => t === 'response.create').length, 1, 'follow-up waits for generation');
  await event({ type: 'response.done', response: { id: 'resp_p', status: 'completed', metadata: { gev: 'progress' } } });
  assert.equal(types(sent).filter((t) => t === 'response.create').length, 2, 'follow-up after the line');
  assert.equal(controller._turns.canNarrate(), false, 'still playing: no new line');
  await event({ type: 'output_audio_buffer.stopped', response_id: 'resp_p' });
  assert.equal(controller._turns.progressResponse, null);
});

test('an unheard line is cancelled when its tool finishes', async () => {
  const { controller, sent, progressLine } = controllerFixture();
  await progressLine('resp_p');
  controller._turns.retractProgressLine();
  assert.equal(sent.at(-1).type, 'response.cancel');
  assert.equal(sent.at(-1).response_id, 'resp_p');
});

test('Radio handoff phases block barge-in and narration: prepared, reserved and starting playback', async () => {
  const { controller, sent, event } = controllerFixture();
  await event({ type: 'response.created', response: { id: 'resp_r' } });
  await event({ type: 'response.done', response: { id: 'resp_r', status: 'completed' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_r' });
  const radio = controller._radio;
  const phases = [
    () => { radio.pendingRadioPlaybackResult = { ok: true }; },
    () => { radio.radioVisibilityOffPending = true; },
    () => { radio.radioHandoffInFlight = true; },
  ];
  for (const enter of phases) {
    radio.pendingRadioPlaybackResult = null;
    radio.radioVisibilityOffPending = false;
    radio.radioHandoffInFlight = false;
    enter();
    assert.equal(radio.mayVoiceClaimSpeaker(), false);
    assert.equal(controller._turns.bargeIn(), false);
    assert.equal(controller._turns.canNarrate(), false);
  }
  assert.deepEqual(sent, []);
});

test('caption transcription is metered with the served transcription model', async () => {
  const { controller, event } = controllerFixture();
  controller._cost.bindTranscriptionModel('gpt-4o-mini-transcribe');
  const before = controller.costTracker.state().totalUsd;
  await event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_u',
    transcript: 'take me to Tokyo',
    usage: { type: 'tokens', input_tokens: 1000, input_token_details: { audio_tokens: 1000 }, output_tokens: 10 },
  });
  const after = controller.costTracker.state().totalUsd;
  assert.ok(Math.abs(after - before - (1000 * 3 + 10 * 5) / 1_000_000) < 1e-12);
});

test('tools report start, progress and finish to narration; Radio stays silent', async () => {
  const calls = [];
  const { controller, event } = controllerFixture({
    runner: async (name, args, options) => {
      options.progress?.({ step: 'resolve', label: 'Zilker Park' });
      return { ok: true, action: name };
    },
  });
  controller._turns.narration = {
    toolStarted: (id, info) => calls.push(['start', id, info.name, info.narrate, info.label]),
    progress: (id, update) => calls.push(['progress', id, update.step]),
    toolFinished: (id) => calls.push(['finish', id]),
    preamble: () => calls.push(['preamble']),
    userTurnEnded() {},
    cancel() {},
    audible() {},
    quiet() {},
  };
  await event({ type: 'response.output_audio_transcript.delta', response_id: 'resp_t', delta: 'Finding ' });
  await event({
    type: 'response.function_call_arguments.done',
    response_id: 'resp_t',
    call_id: 'call_1',
    name: 'annotate_map',
    arguments: JSON.stringify({ annotations: [{ target: 'Zilker Park' }] }),
  });
  assert.deepEqual(calls, [
    ['preamble'],
    ['start', 'call_1', 'annotate_map', true, 'Zilker Park'],
    ['progress', 'call_1', 'resolve'],
    ['finish', 'call_1'],
  ]);
  calls.length = 0;
  await event({
    type: 'response.function_call_arguments.done',
    response_id: 'resp_r',
    call_id: 'call_2',
    name: 'control_radio',
    arguments: JSON.stringify({ action: 'volume', volumePct: 20 }),
  });
  assert.equal(calls.find((call) => call[0] === 'start')?.[3], false);
});
