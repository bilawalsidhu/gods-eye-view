import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './realtimeController.js';
import { createGevActionRunner } from './gevActions.js';
import { PROGRESS_MAX_OUTPUT_TOKENS } from './realtimeTurns.js';
import {
  createVoiceUserTurnTracker,
  readVoiceUserTurnInputKind,
  readVoiceUserTurnProvenance,
  readVoiceUserTurnText,
} from './userTurnIntent.js';

function controllerFixture({
  runner = async () => ({ ok: true }),
  onSessionEvent,
} = {}) {
  const sent = [];
  const statuses = [];
  const usage = [];
  const controller = new GevRealtimeController({
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: { textContent: '' },
      detail: { textContent: '', title: '' },
      errorDetail: { textContent: '' },
    },
    runner,
    debugSink: null,
    onSessionEvent,
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
      error: {
        type: 'invalid_request_error',
        code,
        message: 'rejected',
        event_id: clientEventId,
      },
    });
  const progressLine = async (id = 'resp_p', line = 'Heading to Austin.') => {
    assert.equal(controller._turns.speakProgressLine(line), true);
    const request = sent.at(-1);
    await event({
      type: 'response.created',
      response: { id, metadata: { gev: 'progress' } },
    });
    return request;
  };
  return { controller, sent, statuses, usage, event, rejection, progressLine };
}

const types = (sent) => sent.map((message) => message.type);
const clientCreated = (f, id) =>
  f.event({
    type: 'response.created',
    response: {
      id,
      metadata: f.sent.findLast(
        (e) =>
          e.type === 'response.create' &&
          e.response?.metadata?.gev !== 'progress',
      )?.response?.metadata,
    },
  });

function speechFallbackFixture() {
  const calls = [];
  const timers = new Map();
  let sequence = 0;
  const fixture = controllerFixture({
    runner: async (name, args, options) => {
      calls.push({ name, args, options });
      return { ok: true, action: name };
    },
  });
  fixture.controller._turns.userTurnIntent = createVoiceUserTurnTracker({
    setTimer(callback) {
      const id = ++sequence;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  });
  return {
    ...fixture,
    calls,
    pendingTranscriptionWaits: () => timers.size,
    expireTranscriptionWait() {
      for (const callback of [...timers.values()]) callback();
    },
  };
}

for (const unavailable of ['disabled', 'failed']) {
  test(`OpenAI ${unavailable} captions preserve an authentic ordinary navigation turn`, async () => {
    const f = speechFallbackFixture();
    try {
      if (unavailable === 'disabled')
        await f.event({
          type: 'session.created',
          session: {
            type: 'realtime',
            audio: { input: { transcription: null } },
          },
        });
      await f.event({
        type: 'input_audio_buffer.speech_started',
        item_id: 'mic',
      });
      await f.event({ type: 'input_audio_buffer.committed', item_id: 'mic' });
      await f.event({
        type: 'response.created',
        response: { id: 'navigation' },
      });
      const action = f.event({
        type: 'response.function_call_arguments.done',
        response_id: 'navigation',
        name: 'fly_to_location',
        call_id: 'navigate',
        arguments: JSON.stringify({ query: 'Tokyo' }),
      });
      let settled = false;
      void action.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      if (unavailable === 'failed')
        await f.event({
          type: 'conversation.item.input_audio_transcription.failed',
          item_id: 'mic',
          content_index: 0,
          error: {
            type: 'server_error',
            code: 'transcription_failed',
            message: 'Unavailable',
          },
        });
      // A ready optional-transcription path must settle without advancing the
      // injected five-second timeout. One event-loop checkpoint drains async work.
      await new Promise(setImmediate);
      assert.equal(
        settled,
        true,
        'navigation must not wait for caption expiry',
      );
      assert.equal(f.pendingTranscriptionWaits(), 0);
      await action;
      assert.equal(
        f.calls.length,
        1,
        'optional captions do not disable navigation',
      );
      assert.equal(f.calls[0].name, 'fly_to_location');
      assert.equal(
        readVoiceUserTurnInputKind(f.calls[0].options.userTurn),
        'speech',
      );
      assert.equal(
        readVoiceUserTurnText(f.calls[0].options.userTurn),
        undefined,
      );
      await f.event({
        type: 'response.function_call_arguments.done',
        response_id: 'navigation',
        name: 'control_radio',
        call_id: 'radio-sibling',
        arguments: JSON.stringify({ action: 'volume', volumePct: 20 }),
      });
      assert.equal(
        f.calls.length,
        2,
        'same-response ordinary siblings keep the authentic input',
      );
      assert.equal(f.calls[1].options.userTurn, f.calls[0].options.userTurn);
    } finally {
      f.controller.stop();
    }
  });
}

for (const responseId of [undefined, 'untracked']) {
  test(`OpenAI ordinary calls refuse ${responseId || 'missing'} response identity`, async () => {
    const f = speechFallbackFixture();
    await f.event({
      type: 'response.function_call_arguments.done',
      response_id: responseId,
      name: 'fly_to_location',
      call_id: 'unknown',
      arguments: '{}',
    });
    assert.deepEqual(f.calls, []);
    const output = f.sent.find(
      (message) => message.item?.type === 'function_call_output',
    );
    assert.equal(JSON.parse(output.item.output).voiceIntentUnverified, true);
    f.controller.stop();
  });
}

for (const cause of [
  'pending',
  'wrong-failed-item',
  'partial-session',
  'empty',
]) {
  test(`OpenAI ${cause} captions do not grant ordinary fallback authority`, async () => {
    const f = speechFallbackFixture();
    await f.event({
      type: 'session.updated',
      session: { audio: { input: { turn_detection: {} } } },
    });
    await f.event({
      type: 'input_audio_buffer.speech_started',
      item_id: 'mic',
    });
    await f.event({ type: 'input_audio_buffer.committed', item_id: 'mic' });
    await f.event({ type: 'response.created', response: { id: 'response' } });
    const waiting = f.event({
      type: 'response.function_call_arguments.done',
      response_id: 'response',
      name: 'fly_to_location',
      call_id: 'navigate',
      arguments: '{}',
    });
    if (cause === 'wrong-failed-item')
      await f.event({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'other',
        error: {},
      });
    if (cause === 'empty')
      await f.event({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'mic',
        transcript: '',
      });
    assert.deepEqual(f.calls, []);
    f.expireTranscriptionWait();
    await waiting;
    assert.deepEqual(f.calls, []);
    const output = f.sent.find(
      (message) => message.item?.type === 'function_call_output',
    );
    assert.equal(JSON.parse(output.item.output).voiceIntentUnverified, true);
    f.controller.stop();
  });
}

test('Space barge-in cancels the reply and clears audio; WebRTC truncates, so no manual truncate', async () => {
  const { controller, sent, statuses, event, rejection } = controllerFixture();
  await event({ type: 'response.created', response: { id: 'resp_1' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_1' });
  controller.pendingResponseInstructions = 'queued follow-up';

  assert.equal(controller._turns.bargeIn(), true);
  assert.deepEqual(types(sent), [
    'response.cancel',
    'output_audio_buffer.clear',
  ]);
  assert.equal(sent[0].response_id, 'resp_1');
  assert.equal(
    controller.pendingResponseInstructions,
    null,
    'no queued follow-up talks over the user',
  );
  assert.equal(
    controller.isSupersededResponse('resp_1'),
    true,
    'late calls from the cut reply are refused',
  );

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
  await event({
    type: 'error',
    event_id: sent[0].event_id,
    error: { code: 'server_error', message: 'boom' },
  });
  assert.equal(
    statuses.includes('error'),
    true,
    'only error.event_id correlates a client event',
  );
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
  assert.equal(
    response.instructions.includes('Capitol'),
    false,
    'labels never enter instructions',
  );
  assert.equal(
    controller._turns.speakProgressLine('Another line.'),
    false,
    'one line at a time',
  );
});

test('a cancelled progress response never clears a pending Radio handoff', async () => {
  const { controller, sent, event, progressLine, usage } = controllerFixture();
  await progressLine('resp_p');
  // Radio prepared its playback while the line was generating.
  controller.pendingRadioPlaybackResult = {
    ok: true,
    radioPlaybackRequested: true,
  };
  controller.queueResponseCreate('Say "Turning on the radio."');
  controller._turns.retractProgressLine();
  await event({
    type: 'response.done',
    response: {
      id: 'resp_p',
      status: 'cancelled',
      metadata: { gev: 'progress' },
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  });
  assert.ok(controller.pendingRadioPlaybackResult, 'Radio stays pending');
  assert.equal(sent.at(-1).type, 'response.create');
  assert.match(
    sent.at(-1).response.instructions,
    /Turning on the radio/,
    'the confirmation is not stranded',
  );
  assert.equal(usage.length, 1, 'progress usage is still billed');
});

test('an old progress completion leaves the active in-band response alone', async () => {
  const { controller, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  // Server VAD starts a real reply while the line is still generating.
  await event({ type: 'response.created', response: { id: 'resp_real' } });
  await event({
    type: 'response.output_audio_transcript.done',
    response_id: 'resp_p',
    transcript: 'Heading to Austin.',
  });
  await event({
    type: 'response.done',
    response: {
      id: 'resp_p',
      status: 'completed',
      metadata: { gev: 'progress' },
    },
  });
  assert.equal(controller.activeResponseId, 'resp_real');
  assert.equal(controller.responseActive, true);
});

test('user speech stops an audible progress line: cancel and clear its audio', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  sent.length = 0;
  await event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'speech-during-progress',
  });
  assert.deepEqual(types(sent), [
    'response.cancel',
    'output_audio_buffer.clear',
  ]);
  assert.equal(sent[0].response_id, 'resp_p');
});

test('a typed command stops an audible progress line too', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  await event({
    type: 'response.done',
    response: {
      id: 'resp_p',
      status: 'completed',
      metadata: { gev: 'progress' },
    },
  });
  sent.length = 0;
  controller.sendTextCommand('go to Paris');
  assert.equal(
    types(sent)[0],
    'output_audio_buffer.clear',
    'playback still owned after generation ended',
  );
});

test('a finished tool lets a heard line finish, and playback ownership outlives response.done', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  controller._turns.retractProgressLine();
  assert.equal(
    types(sent).includes('response.cancel'),
    false,
    'audible lines are not cut',
  );
  controller.queueResponseCreate('Speak the say line.');
  assert.equal(
    types(sent).filter((t) => t === 'response.create').length,
    1,
    'follow-up waits for generation',
  );
  await event({
    type: 'response.done',
    response: {
      id: 'resp_p',
      status: 'completed',
      metadata: { gev: 'progress' },
    },
  });
  assert.equal(
    types(sent).filter((t) => t === 'response.create').length,
    2,
    'follow-up after the line',
  );
  assert.equal(
    controller._turns.canNarrate(),
    false,
    'still playing: no new line',
  );
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
  await event({
    type: 'response.done',
    response: { id: 'resp_r', status: 'completed' },
  });
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_r' });
  const radio = controller._radio;
  const phases = [
    () => {
      radio.pendingRadioPlaybackResult = { ok: true };
    },
    () => {
      radio.radioVisibilityOffPending = true;
    },
    () => {
      radio.radioHandoffInFlight = true;
    },
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
    usage: {
      type: 'tokens',
      input_tokens: 1000,
      input_token_details: { audio_tokens: 1000 },
      output_tokens: 10,
    },
  });
  const after = controller.costTracker.state().totalUsd;
  assert.ok(Math.abs(after - before - (1000 * 3 + 10 * 5) / 1_000_000) < 1e-12);
});

test('tools report start, progress and finish to narration; Radio stays silent', async () => {
  const calls = [];
  const { controller, event, sent } = controllerFixture({
    runner: async (name, args, options) => {
      options.progress?.({ step: 'resolve', label: 'Zilker Park' });
      return { ok: true, action: name };
    },
  });
  controller._turns.narration = {
    toolStarted: (id, info) =>
      calls.push(['start', id, info.name, info.narrate, info.label]),
    progress: (id, update) => calls.push(['progress', id, update.step]),
    toolFinished: (id) => calls.push(['finish', id]),
    preamble: () => calls.push(['preamble']),
    userTurnEnded() {},
    cancel() {},
    audible() {},
    quiet() {},
  };
  controller.sendTextCommand(
    'Mark Zilker Park and set Radio volume to 20 percent',
  );
  await event({
    type: 'response.created',
    response: {
      id: 'resp_t',
      metadata: sent.findLast((e) => e.type === 'response.create')?.response
        ?.metadata,
    },
  });
  await event({
    type: 'response.output_audio_transcript.delta',
    response_id: 'resp_t',
    delta: 'Finding ',
  });
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
    response_id: 'resp_t',
    call_id: 'call_2',
    name: 'control_radio',
    arguments: JSON.stringify({ action: 'volume', volumePct: 20 }),
  });
  assert.equal(calls.find((call) => call[0] === 'start')?.[3], false);
});

test('OpenAI dispatch binds first-party input across a tool follow-up and retires it at final generation', async () => {
  const observed = [];
  const calls = [];
  const f = controllerFixture({
    onSessionEvent: (event) => observed.push(event),
    runner: async (name, _args, options) => {
      calls.push({
        name,
        options,
        text: readVoiceUserTurnText(options.userTurn),
      });
      return {
        ok: true,
        action: name,
        pending: true,
        say: 'Current view ready.',
      };
    },
  });
  f.controller.sendTextCommand('What am I looking at?');
  await clientCreated(f, 'tools');
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'tools',
    name: 'get_current_view_state',
    call_id: 'switch',
    arguments: '{}',
  });
  await f.event({
    type: 'response.done',
    response: {
      id: 'tools',
      status: 'completed',
      output: [{ type: 'function_call' }],
    },
  });
  assert.equal(calls[0].text, 'What am I looking at?');
  assert.equal(calls[0].options.responseId, 'tools');
  const token = calls[0].options.userTurn;
  await clientCreated(f, 'ack');
  assert.equal(
    observed.find(
      (event) => event.type === 'response-start' && event.responseId === 'ack',
    ).userTurn,
    token,
  );
  await f.event({ type: 'output_audio_buffer.started', response_id: 'ack' });
  await f.event({
    type: 'response.output_audio_transcript.done',
    response_id: 'ack',
    transcript: 'Current view ready.',
  });
  await f.event({
    type: 'response.done',
    response: {
      id: 'ack',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'audio' }] }],
    },
  });
  assert.equal(
    readVoiceUserTurnText(token),
    undefined,
    'final generation retires transcript authority',
  );
  await f.event({ type: 'output_audio_buffer.stopped', response_id: 'ack' });
  assert.equal(f.controller._turns.assistantAudioPlaying, false);
});

test('OpenAI final native transcript is required and generated context cannot authorize settings', async () => {
  const calls = [];
  const f = controllerFixture({
    runner: async (_name, _args, options) => {
      calls.push(readVoiceUserTurnText(options.userTurn));
      return { ok: true };
    },
  });
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'speech',
  });
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'wrong-item',
    transcript: 'Switch to Gemini',
  });
  await f.event({ type: 'input_audio_buffer.committed', item_id: 'speech' });
  await f.event({ type: 'response.created', response: { id: 'r1' } });
  const early = f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'r1',
    name: 'get_current_view_state',
    call_id: 'early',
    arguments: '{}',
  });
  await Promise.resolve();
  assert.deepEqual(calls, []);
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'speech',
    transcript: 'Switch to Gemini',
  });
  await early;
  assert.equal(calls[0], 'Switch to Gemini');
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'r1',
    name: 'get_current_view_state',
    call_id: 'valid',
    arguments: '{}',
  });
  assert.equal(calls[1], 'Switch to Gemini');
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'speech',
    transcript: 'Switch to OpenAI',
  });
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'r1',
    name: 'get_current_view_state',
    call_id: 'immutable',
    arguments: '{}',
  });
  assert.equal(
    calls[2],
    'Switch to Gemini',
    'later transcript cannot replace the first final input',
  );
  f.controller.stop({ preserveStatus: true });
  assert.equal(f.controller._turns.userTurnIntent.forResponse('r1'), undefined);
});

test('OpenAI cleared audio and progress preserve their ordinary lifecycle events', async () => {
  const observed = [];
  const f = controllerFixture({
    onSessionEvent: (event) => observed.push(event),
  });
  f.controller.sendTextCommand('Switch to OpenAI');
  await f.event({ type: 'response.created', response: { id: 'r' } });
  await f.event({
    type: 'response.done',
    response: {
      id: 'r',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'audio' }] }],
    },
  });
  await f.event({ type: 'output_audio_buffer.cleared', response_id: 'r' });
  assert.equal(
    observed.some((event) => event.type === 'audio-cleared'),
    true,
  );
  await f.event({
    type: 'response.created',
    response: { id: 'progress', metadata: { gev: 'progress' } },
  });
  await f.event({
    type: 'response.done',
    response: {
      id: 'progress',
      status: 'completed',
      metadata: { gev: 'progress' },
      output: [{ type: 'message', content: [{ type: 'audio' }] }],
    },
  });
  await f.event({
    type: 'output_audio_buffer.stopped',
    response_id: 'progress',
  });
  assert.equal(
    observed.some(
      (event) =>
        event.type === 'response-start' && event.responseId === 'progress',
    ),
    false,
  );
});

test('OpenAI clears stale speech before a typed provider request reaches the model', async () => {
  const f = controllerFixture();
  await f.event({ type: 'response.created', response: { id: 'old' } });
  await f.event({ type: 'output_audio_buffer.started', response_id: 'old' });

  f.controller.sendTextCommand('Switch providers to Gemini');

  assert.deepEqual(
    f.sent
      .filter((message) =>
        [
          'response.cancel',
          'output_audio_buffer.clear',
          'conversation.item.create',
        ].includes(message.type),
      )
      .map((message) => message.type),
    [
      'response.cancel',
      'output_audio_buffer.clear',
      'conversation.item.create',
    ],
  );
  assert.equal(
    f.sent.find((message) => message.type === 'response.cancel').response_id,
    'old',
  );
});

test('OpenAI cancels a stale response reservation and keeps its successor current', async () => {
  const calls = [];
  const f = controllerFixture({
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  f.controller.sendTextCommand('old turn');
  f.controller.sendTextCommand('fresh turn');
  await clientCreated(f, 'stale');
  assert.equal(
    f.sent.findLast((message) => message.type === 'response.cancel')
      ?.response_id,
    'stale',
  );
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'stale',
    call_id: 'stale-tool',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  assert.deepEqual(calls, []);
  await f.event({
    type: 'response.done',
    response: { id: 'stale', status: 'cancelled' },
  });
  await clientCreated(f, 'fresh');
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'fresh',
    call_id: 'fresh-tool',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  assert.deepEqual(calls, ['get_current_view_state']);
});

test('OpenAI cancellation never publishes a stale resolved tool payload', async () => {
  let toolSignal;
  let resolveTool;
  const f = controllerFixture({
    runner: async (_name, _args, options) => {
      toolSignal = options.signal;
      return new Promise((resolve) => {
        resolveTool = resolve;
      });
    },
  });
  f.controller.sendTextCommand('What is in the current view?');
  await clientCreated(f, 'old');
  const pending = f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'old',
    call_id: 'old-tool',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  for (let index = 0; index < 3 && !toolSignal; index++)
    await Promise.resolve();
  assert.ok(toolSignal);
  f.controller.sendTextCommand('fresh turn');
  assert.equal(toolSignal.aborted, true);
  resolveTool({ ok: true, say: 'stale speech', data: { sentinel: 'stale' } });
  await pending;
  const output = f.sent.find(
    (message) =>
      message.type === 'conversation.item.create' &&
      message.item?.type === 'function_call_output' &&
      message.item.call_id === 'old-tool',
  );
  assert.ok(output);
  const result = JSON.parse(output.item.output);
  assert.equal(result.cancelled, true);
  assert.equal(result.superseded, true);
  assert.equal('say' in result, false);
  assert.equal('data' in result, false);
});

for (const [label, cancel] of [
  [
    'typed input',
    (fixture) => fixture.controller.sendTextCommand('fresh turn'),
  ],
  [
    'speech onset',
    (fixture) =>
      fixture.event({
        type: 'input_audio_buffer.speech_started',
        item_id: 'fresh-speech',
      }),
  ],
]) {
  test(`OpenAI ${label} cannot publish an aborted tool failure`, async () => {
    let toolSignal;
    const f = controllerFixture({
      runner: async (_name, _args, options) => {
        toolSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              const error = new Error('New user turn');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
    });
    f.controller.sendTextCommand('What is in the current view?');
    await clientCreated(f, 'old');
    const pending = f.event({
      type: 'response.function_call_arguments.done',
      response_id: 'old',
      call_id: 'old-tool',
      name: 'get_current_view_state',
      arguments: '{}',
    });
    for (let index = 0; index < 3 && !toolSignal; index++)
      await Promise.resolve();
    assert.ok(toolSignal);
    f.sent.length = 0;
    await cancel(f);
    assert.equal(toolSignal.aborted, true);
    await pending;
    const output = f.sent.find(
      (message) =>
        message.type === 'conversation.item.create' &&
        message.item?.type === 'function_call_output' &&
        message.item.call_id === 'old-tool',
    );
    assert.ok(output);
    assert.equal(JSON.parse(output.item.output).cancelled, true);
    assert.equal(JSON.parse(output.item.output).superseded, true);
    assert.equal(
      f.sent.some((message) => message.type === 'response.create'),
      false,
    );
  });
}

for (const restart of [false, true]) {
  test(`an OpenAI transcript waiter cannot revive or write after Stop${restart ? '/replacement' : ''}`, async () => {
    const calls = [];
    const f = controllerFixture({
      runner: async (name) => {
        calls.push(name);
        return { ok: true };
      },
    });
    await f.event({
      type: 'input_audio_buffer.speech_started',
      item_id: 'old-speech',
    });
    await f.event({
      type: 'input_audio_buffer.committed',
      item_id: 'old-speech',
    });
    await f.event({
      type: 'response.created',
      response: { id: 'old-response' },
    });
    const waiting = f.event({
      type: 'response.function_call_arguments.done',
      response_id: 'old-response',
      name: 'get_current_view_state',
      call_id: 'old-call',
      arguments: '{}',
    });
    await Promise.resolve();
    f.controller.stop();
    const before = f.statuses.length;
    const successor = [];
    if (restart)
      f.controller.dc = {
        readyState: 'open',
        send: (raw) => successor.push(JSON.parse(raw)),
        close() {},
      };
    await waiting;
    assert.deepEqual(f.statuses.slice(before), []);
    assert.deepEqual(successor, []);
    assert.deepEqual(calls, []);
    f.controller.stop();
  });
}

function realNavigationControllerFixture() {
  const cameraState = {
    height: 1000,
    renders: 0,
    provider: 'openai',
    providerWrites: 0,
  };
  const position = { x: 6379137, y: 0, z: 0 };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: {
      positionWC: position,
      positionCartographic: { height: cameraState.height },
      moveEnd: { addEventListener() {} },
      cancelFlight() {},
      zoomIn(metres) {
        position.x -= metres;
        cameraState.height -= metres;
        this.positionCartographic.height = cameraState.height;
      },
      zoomOut(metres) {
        position.x += metres;
        cameraState.height += metres;
        this.positionCartographic.height = cameraState.height;
      },
    },
    scene: {
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        addEventListener() {},
        removeEventListener() {},
      },
      requestRender() {
        cameraState.renders++;
      },
    },
  };
  const runner = createGevActionRunner({
    viewer,
    dataManager: { layers: new Map() },
    styleManager: {
      setVoiceProvider(provider) {
        cameraState.providerWrites++;
        cameraState.provider = provider;
      },
    },
  });
  const calls = [];
  const f = controllerFixture({
    runner: async (name, args, options) => {
      const result = await runner(name, args, options);
      calls.push({ name, args, options, result });
      return result;
    },
  });
  return { ...f, calls, cameraState };
}

test('OpenAI reservation overflow closes the ambiguous session and exposes explicit restart recovery', async () => {
  const f = realNavigationControllerFixture();
  const channel = f.controller.dc;
  const epoch = f.controller._connection.startEpoch;
  for (let index = 0; index < 17; index++) {
    const itemId = `unanswered-${index}`;
    await f.event({
      type: 'input_audio_buffer.speech_started',
      item_id: itemId,
    });
    await f.event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript: 'zoom in',
    });
    await f.event({ type: 'input_audio_buffer.committed', item_id: itemId });
  }
  // With the inherited overflow latch, a later genuine input and response
  // remain unable to execute any tool while the UI still looks connected.
  if (f.controller.dc === channel) {
    await f.event({
      type: 'input_audio_buffer.speech_started',
      item_id: 'authentic-next',
    });
    await f.event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'authentic-next',
      transcript: 'zoom in',
    });
    await f.event({
      type: 'input_audio_buffer.committed',
      item_id: 'authentic-next',
    });
    await f.event({
      type: 'response.created',
      response: { id: 'authentic-next-response' },
    });
    await f.event({
      type: 'response.function_call_arguments.done',
      response_id: 'authentic-next-response',
      call_id: 'next-zoom',
      name: 'adjust_camera_zoom',
      arguments: '{"direction":"in"}',
    });
    assert.equal(
      f.calls.length,
      0,
      'counterexample: overflow strands an authentic ordinary command',
    );
  }
  assert.equal(
    f.controller.dc,
    null,
    'overflow must stop the ambiguous conversation',
  );
  assert.ok(
    f.controller._connection.startEpoch > epoch,
    'old transport callbacks lose ownership',
  );
  assert.equal(f.controller.status, 'error');
  assert.match(f.controller.ui.errorDetail.textContent, /start voice again/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.pendingRadioPlaybackResult, null);
  assert.equal(f.controller.pendingResponseInstructions, null);
  f.controller.stop();
});

for (const requestKind of ['typed', 'tool-followup']) {
  test(`OpenAI ${requestKind} reservation overflow stops through its actual request site`, async () => {
    const f = realNavigationControllerFixture();
    if (requestKind === 'tool-followup') {
      f.controller.sendTextCommand('zoom in');
      await f.event({
        type: 'error',
        error: {
          code: 'server_error',
          message:
            'Synthetic response rejected without a correlated request id',
        },
      });
    }
    for (let index = 0; index < 17 && f.controller.dc; index++) {
      if (requestKind === 'typed') f.controller.sendTextCommand('zoom in');
      else f.controller.queueResponseCreate('Continue this user request.');
      if (f.controller.dc)
        await f.event({
          type: 'error',
          error: {
            code: 'server_error',
            message:
              'Synthetic response rejected without a correlated request id',
          },
        });
    }
    assert.equal(f.controller.dc, null);
    assert.equal(f.controller.status, 'error');
    assert.match(f.controller.ui.errorDetail.textContent, /start voice again/i);
    assert.equal(f.calls.length, 0);
    assert.equal(f.controller.pendingResponseInstructions, null);
    assert.equal(f.controller.pendingUserTextResponse, false);
    assert.equal(f.controller.responseCreatePending, false);
    f.controller.stop();
  });
}

test('an untracked tool refusal cannot erase restart-required state when its follow-up overflows reservations', async () => {
  const f = realNavigationControllerFixture();
  for (let index = 0; index < 16; index++) {
    f.controller.sendTextCommand('zoom in');
    await f.event({
      type: 'error',
      error: {
        code: 'server_error',
        message: 'Synthetic rejection without correlated request id',
      },
    });
  }
  assert.equal(
    f.controller._turns.userTurnIntent.reservationState().pending,
    16,
  );
  // No current input: an untracked refusal may speak neutral guidance, but
  // must not borrow a different live typed request just to fill the queue.
  f.controller._turns.userTurnIntent.invalidate();
  await f.event({
    type: 'response.function_call_arguments.done',
    call_id: 'untracked-overflow',
    name: 'adjust_camera_zoom',
    arguments: '{"direction":"in"}',
  });
  assert.equal(f.controller.dc, null);
  assert.equal(
    f.controller.status,
    'error',
    'refusal completion cannot overwrite overflow recovery',
  );
  assert.match(f.controller.ui.errorDetail.textContent, /start voice again/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cameraState.height, 1000);
  assert.equal(f.controller.pendingResponseInstructions, null);
  f.controller.stop();
});

test('an asynchronous transcript refusal cannot erase restart-required state after uncorrelated errors', async () => {
  const f = realNavigationControllerFixture();
  let expire;
  f.controller._turns.userTurnIntent = createVoiceUserTurnTracker({
    setTimer(callback) {
      expire = callback;
      return 1;
    },
    clearTimer() {},
  });
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'pending-input',
  });
  await f.event({
    type: 'input_audio_buffer.committed',
    item_id: 'pending-input',
  });
  await f.event({
    type: 'response.created',
    response: { id: 'pending-response' },
  });
  const waiting = f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'pending-response',
    call_id: 'pending-zoom',
    name: 'adjust_camera_zoom',
    arguments: '{"direction":"in"}',
  });
  for (let index = 0; index < 16; index++) {
    await f.event({
      type: 'error',
      error: {
        code: 'server_error',
        message: 'Synthetic rejection without correlated request id',
      },
    });
    f.controller.queueResponseCreate('Continue this user request.');
  }
  await f.event({
    type: 'error',
    error: {
      code: 'server_error',
      message: 'Synthetic rejection without correlated request id',
    },
  });
  assert.equal(
    f.controller._turns.userTurnIntent.reservationState().pending,
    16,
  );
  assert.equal(f.calls.length, 0);
  expire();
  await waiting;
  assert.equal(f.controller.dc, null);
  assert.equal(f.controller.status, 'error');
  assert.match(f.controller.ui.errorDetail.textContent, /start voice again/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cameraState.height, 1000);
  f.controller.stop();
});

for (const captions of ['disabled', 'failed', 'completed']) {
  test(`OpenAI ${captions} captions execute real camera navigation and refuse provider writes across the next turn`, async () => {
    const f = realNavigationControllerFixture();
    const beginTurn = async (itemId, responseId, transcript) => {
      await f.event({
        type: 'input_audio_buffer.speech_started',
        item_id: itemId,
      });
      await f.event({ type: 'input_audio_buffer.committed', item_id: itemId });
      await f.event({ type: 'response.created', response: { id: responseId } });
      if (captions === 'failed')
        await f.event({
          type: 'conversation.item.input_audio_transcription.failed',
          item_id: itemId,
          content_index: 0,
          error: {
            type: 'server_error',
            code: 'transcription_failed',
            message: 'Unavailable',
          },
        });
      if (captions === 'completed')
        await f.event({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: itemId,
          content_index: 0,
          transcript,
        });
    };
    const tool = (responseId, callId, name, args) =>
      f.event({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      });
    try {
      if (captions === 'disabled')
        await f.event({
          type: 'session.created',
          session: {
            type: 'realtime',
            audio: { input: { transcription: null } },
          },
        });
      await beginTurn('real-mic-one', 'real-navigation-one', 'zoom in');
      await tool('real-navigation-one', 'real-zoom-in', 'adjust_camera_zoom', {
        direction: 'in',
        amount: 'little',
      });
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].result.ok, true);
      assert.equal(f.calls[0].result.action, 'adjust_camera_zoom');
      assert.equal(
        f.cameraState.height,
        750,
        'the production runner must change camera position',
      );
      assert.equal(f.cameraState.renders, 1);
      const firstToken = f.calls[0].options.userTurn;
      assert.deepEqual(readVoiceUserTurnProvenance(firstToken), {
        inputKind: 'speech',
        transcriptionStatus: captions,
      });
      assert.equal(
        readVoiceUserTurnText(firstToken),
        captions === 'completed' ? 'zoom in' : undefined,
      );
      await tool(
        'real-navigation-one',
        'defensive-provider-one',
        'set_voice_provider',
        { provider: 'gemini' },
      );
      assert.equal(f.calls[1].options.userTurn, firstToken);
      assert.equal(f.calls[1].result.ok, false);
      assert.equal(f.calls[1].result.changed, false);
      assert.match(
        f.calls[1].result.error,
        /Provider selection is managed by this app/,
      );
      assert.equal(f.cameraState.provider, 'openai');
      assert.equal(f.cameraState.providerWrites, 0);
      assert.equal(f.cameraState.height, 750);
      const providerOutput = f.sent.findLast(
        (entry) => entry.item?.call_id === 'defensive-provider-one',
      );
      assert.equal(JSON.parse(providerOutput.item.output).changed, false);
      await beginTurn('real-mic-two', 'real-navigation-two', 'zoom out');
      await tool('real-navigation-two', 'real-zoom-out', 'adjust_camera_zoom', {
        direction: 'out',
        amount: 'little',
      });
      assert.equal(f.calls[2].result.ok, true);
      assert.equal(
        f.cameraState.height,
        937.5,
        'a new authentic turn must still navigate after the provider refusal',
      );
      assert.equal(f.cameraState.renders, 2);
      assert.notEqual(f.calls[2].options.userTurn, firstToken);
      assert.deepEqual(
        readVoiceUserTurnProvenance(f.calls[2].options.userTurn),
        { inputKind: 'speech', transcriptionStatus: captions },
      );
      assert.equal(readVoiceUserTurnProvenance(firstToken), undefined);
      await tool(
        'real-navigation-two',
        'defensive-provider-two',
        'set_voice_provider',
        { provider: 'gemini' },
      );
      assert.equal(f.calls[3].result.ok, false);
      assert.equal(f.calls[3].result.changed, false);
      assert.equal(f.cameraState.providerWrites, 0);
      assert.equal(f.cameraState.height, 937.5);
    } finally {
      f.controller.stop();
    }
  });
}
