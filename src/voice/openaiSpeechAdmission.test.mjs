// Provider-item admission must precede every semantic speech-start consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GevRealtimeController } from './realtimeController.js';
import {
  readVoiceUserTurnText,
  readVoiceUserTurnProvenance,
  subscribeVoiceUserTurn,
} from './userTurnIntent.js';
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ pending = false, onEvent } = {}) {
  const events = [],
    sent = [],
    calls = [],
    releases = [];
  const effects = { narration: 0, radio: 0, pointer: 0, metrics: 0 };
  let c;
  c = new GevRealtimeController({
    runner: async (name, args, options) => {
      calls.push({ name, args, options });
      return pending
        ? new Promise((resolve) => releases.push(resolve))
        : { ok: true };
    },
    backend: {},
    debugSink: null,
    onSessionEvent: (event) => {
      events.push(event);
      onEvent?.(event, c);
    },
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: {},
      detail: {},
    },
  });
  const channel = () => ({
    readyState: 'open',
    send: (value) => sent.push(JSON.parse(value)),
    close() {
      this.readyState = 'closed';
    },
  });
  c.dc = channel();
  c.status = 'listening';
  const wrap = (object, name, key) => {
    const original = object[name].bind(object);
    object[name] = (...args) => {
      effects[key]++;
      return original(...args);
    };
  };
  wrap(c._turns.narration, 'cancel', 'narration');
  wrap(c, 'cancelRadioHandoff', 'radio');
  wrap(c, 'beginPointerTurn', 'pointer');
  wrap(c._metrics, 'serverEvent', 'metrics');
  const event = (payload, source = c.dc) =>
    c.handleRealtimeEvent({
      data: JSON.stringify(payload),
      currentTarget: source,
    });
  const start = (id) =>
    event({ type: 'input_audio_buffer.speech_started', item_id: id });
  const transcript = (id, text) =>
    event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      transcript: text,
    });
  const commit = (id) =>
    event({ type: 'input_audio_buffer.committed', item_id: id });
  const created = (id, metadata) =>
    event({
      type: 'response.created',
      response: { id, ...(metadata ? { metadata } : {}) },
    });
  const done = (id) =>
    event({
      type: 'response.done',
      response: { id, status: 'completed', output: [] },
    });
  const tool = (id, callId) =>
    event({
      type: 'response.function_call_arguments.done',
      response_id: id,
      call_id: callId,
      name: 'adjust_camera_zoom',
      arguments: '{"direction":"in","amount":"little"}',
    });
  const live = async (mode = 'completed') => {
    if (mode === 'disabled') c._turns.bindTranscriptionModel('off');
    await start('B');
    if (mode === 'completed') await transcript('B', 'zoom in a little');
    if (mode === 'failed')
      await event({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'B',
      });
    await commit('B');
    await created('B-response');
    const action = tool('B-response', 'pending-B');
    await tick();
    if (mode !== 'pending') assert.equal(calls.length, 1);
    return action;
  };
  const release = () =>
    releases.splice(0).forEach((resolve) => resolve({ ok: true }));
  const snapshot = () => ({
    effects: { ...effects },
    events: events.length,
    pendingTyped: c.pendingUserTextResponse,
    pendingInstructions: c.pendingResponseInstructions,
    pendingUser: c.userTurnPending,
    reservations: c._turns.userTurnIntent.reservationState(),
  });
  const output = () =>
    sent
      .filter((x) => x.item?.type === 'function_call_output')
      .map((x) => JSON.parse(x.item.output));
  const close = () => {
    release();
    c.stop();
  };
  return {
    c,
    events,
    sent,
    calls,
    event,
    start,
    transcript,
    commit,
    created,
    clientCreated: (id) =>
      created(
        id,
        sent.findLast(
          (e) =>
            e.type === 'response.create' &&
            e.response?.metadata?.gev !== 'progress',
        )?.response?.metadata,
      ),
    done,
    tool,
    live,
    release,
    snapshot,
    output,
    channel,
    close,
  };
}
for (const replay of ['current', 'older', 'evicted']) {
  test(`OpenAI ${replay} speech-start replay leaves token, running tool and every boundary consumer unchanged`, async () => {
    const f = fixture({ pending: true });
    let action;
    try {
      if (replay === 'older') await f.start('A');
      if (replay === 'evicted')
        for (let i = 0; i < 20; i++) await f.start(`mic-${i}`);
      // Keep this Promise unawaited while the actual dispatcher is executing.
      action = f.live();
      await tick();
      assert.equal(f.calls.length, 1);
      const { userTurn, signal } = f.calls[0].options;
      f.c.pendingResponseInstructions = 'Retain the legitimate follow-up';
      const before = f.snapshot();
      await f.start(
        replay === 'current' ? 'B' : replay === 'older' ? 'A' : 'mic-0',
      );
      assert.deepEqual(f.snapshot(), before);
      assert.equal(readVoiceUserTurnText(userTurn), 'zoom in a little');
      assert.equal(
        f.c._turns.userTurnIntent.forResponse('B-response'),
        userTurn,
      );
      assert.equal(signal.aborted, false);
      f.release();
      await action;
      assert.equal(f.output().at(-1).ok, true);
    } finally {
      f.release();
      if (action) await action;
      f.close();
    }
  });
}
for (const mode of ['disabled', 'failed']) {
  test(`OpenAI duplicate retains ${mode} transcription provenance for the actual runner`, async () => {
    const f = fixture({ pending: true });
    let action;
    try {
      action = f.live(mode);
      await tick();
      const token = f.calls[0].options.userTurn;
      const before = f.snapshot();
      await f.start('B');
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(readVoiceUserTurnProvenance(token), {
        inputKind: 'speech',
        transcriptionStatus: mode,
      });
      assert.equal(f.calls[0].options.signal.aborted, false);
      f.release();
      await action;
      assert.equal(f.output().at(-1).ok, true);
    } finally {
      f.release();
      if (action) await action;
      f.close();
    }
  });
}
test('OpenAI duplicate cannot replace a pending-transcription waiter', async () => {
  const f = fixture();
  let action;
  try {
    await f.start('B');
    await f.commit('B');
    await f.created('B-response');
    action = f.tool('B-response', 'waiter');
    await tick();
    assert.equal(f.calls.length, 0);
    await f.start('B');
    await f.transcript('B', 'zoom in a little');
    await action;
    assert.equal(f.calls.length, 1);
    assert.equal(
      readVoiceUserTurnText(f.calls[0].options.userTurn),
      'zoom in a little',
    );
    assert.equal(f.output().at(-1).ok, true);
  } finally {
    if (action) await action;
    f.close();
  }
});
test('OpenAI duplicate cannot drop queued typed intent or insert a response reservation', async () => {
  const f = fixture();
  try {
    await f.start('B');
    await f.transcript('B', 'first input');
    await f.commit('B');
    await f.created('B-response');
    f.c.sendTextCommand('zoom out typed');
    assert.equal(f.c.pendingUserTextResponse, true);
    const before = f.snapshot();
    await f.start('B');
    assert.deepEqual(f.snapshot(), before);
    await f.done('B-response');
    await f.clientCreated('typed-response');
    const token = f.c._turns.userTurnIntent.forResponse('typed-response');
    assert.equal(readVoiceUserTurnText(token), 'zoom out typed');
    await f.tool('typed-response', 'typed-current');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.userTurn, token);
  } finally {
    f.close();
  }
});
test('OpenAI a genuine unseen onset still aborts the old tool and admits the new request', async () => {
  const f = fixture({ pending: true });
  let action;
  try {
    action = f.live();
    await tick();
    const old = f.calls[0].options;
    const before = f.events.length;
    await f.start('C');
    assert.equal(readVoiceUserTurnText(old.userTurn), undefined);
    assert.equal(old.signal.aborted, true);
    assert.equal(
      f.events.slice(before).filter((e) => e.type === 'user-turn-start').length,
      1,
    );
    assert.equal(
      f.events.slice(before).filter((e) => e.type === 'interruption').length,
      1,
    );
    f.release();
    await action;
    assert.equal(f.output().at(-1).superseded, true);
    await f.done('B-response');
    await f.transcript('C', 'zoom out new input');
    await f.commit('C');
    await f.created('C-response');
    action = f.tool('C-response', 'C-tool');
    await tick();
    assert.equal(
      readVoiceUserTurnText(f.calls[1].options.userTurn),
      'zoom out new input',
    );
    f.release();
    await action;
  } finally {
    f.release();
    if (action) await action;
    f.close();
  }
});
test('OpenAI genuine onset still drops an unsent typed response, unlike a replay', async () => {
  const f = fixture();
  try {
    await f.start('B');
    await f.commit('B');
    await f.created('B-response');
    f.c.sendTextCommand('zoom in');
    assert.equal(f.c.pendingUserTextResponse, true);
    await f.start('C');
    assert.equal(f.c.pendingUserTextResponse, false);
    await f.done('B-response');
    assert.equal(f.sent.filter((x) => x.type === 'response.create').length, 0);
  } finally {
    f.close();
  }
});
for (const id of [undefined, null, '', 42, {}, []]) {
  test(`OpenAI missing or invalid provider identity is inert - ${JSON.stringify(id)}`, async () => {
    const f = fixture({ pending: true });
    let action;
    try {
      action = f.live();
      await tick();
      const before = f.snapshot();
      const token = f.calls[0].options.userTurn;
      await f.start(id);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(readVoiceUserTurnText(token), 'zoom in a little');
      assert.equal(f.calls[0].options.signal.aborted, false);
      f.release();
      await action;
    } finally {
      f.release();
      if (action) await action;
      f.close();
    }
  });
}
for (const kind of [
  'currentTarget',
  'target',
  'closed',
  'ending',
  'progress-id',
  'progress-tag',
]) {
  test(`OpenAI non-conversation onset is inert and does not consume its identity - ${kind}`, async () => {
    const f = fixture();
    try {
      await f.start('B');
      if (kind === 'closed') f.c.dc.readyState = 'closed';
      if (kind === 'ending') f.c.costCapStopped = true;
      if (kind === 'progress-id')
        f.c._turns.progressResponseIds.add('progress');
      const before = f.snapshot();
      const payload = {
        type: 'input_audio_buffer.speech_started',
        item_id: 'C',
        ...(kind === 'progress-id' ? { response_id: 'progress' } : {}),
        ...(kind === 'progress-tag'
          ? { response: { metadata: { gev: 'progress' } } }
          : {}),
      };
      if (kind === 'target')
        await f.c.handleRealtimeEvent({
          data: JSON.stringify(payload),
          target: f.channel(),
        });
      else
        await f.event(payload, kind === 'currentTarget' ? f.channel() : f.c.dc);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.c._turns.admittedSpeechItemIds.has('C'), false);
      f.c.dc.readyState = 'open';
      f.c.costCapStopped = false;
      await f.start('C');
      assert.equal(f.c._turns.admittedSpeechItemIds.has('C'), true);
    } finally {
      f.close();
    }
  });
}
test('OpenAI supports event fixtures without source metadata while production listeners enforce ownership', async () => {
  const f = fixture();
  try {
    await f.c.handleRealtimeEvent({
      data: JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        item_id: 'B',
      }),
    });
    await f.transcript('B', 'zoom in');
    await f.commit('B');
    await f.created('B-response');
    assert.equal(
      readVoiceUserTurnText(
        f.c._turns.userTurnIntent.forResponse('B-response'),
      ),
      'zoom in',
    );
  } finally {
    f.close();
  }
});
test('OpenAI Stop/new lifetime accepts the same ID once and excludes the obsolete channel', async () => {
  const f = fixture();
  try {
    await f.start('B');
    const oldChannel = f.c.dc;
    f.c.stop();
    assert.equal(f.c._turns.admittedSpeechItemIds.size, 0);
    f.c.dc = f.channel();
    f.c.status = 'listening';
    const before = f.snapshot();
    await f.event(
      { type: 'input_audio_buffer.speech_started', item_id: 'B' },
      oldChannel,
    );
    assert.deepEqual(f.snapshot(), before);
    await f.start('B');
    await f.transcript('B', 'new lifetime');
    await f.commit('B');
    await f.created('fresh-B');
    const token = f.c._turns.userTurnIntent.forResponse('fresh-B');
    await f.start('B');
    assert.equal(readVoiceUserTurnText(token), 'new lifetime');
  } finally {
    f.close();
  }
});
for (const boundary of ['user-turn-start', 'interruption']) {
  test(`OpenAI Stop from ${boundary} observer cannot continue stale admission`, async () => {
    let armed = false;
    const f = fixture({
      onEvent: (event, c) => {
        if (armed && event.type === boundary) c.stop();
      },
    });
    try {
      armed = true;
      await f.start('B');
      assert.equal(f.c.dc, null);
      assert.equal(f.c.userTurnPending, false);
      assert.equal(f.c.pendingUserTextResponse, false);
      assert.equal(f.c._turns.admittedSpeechItemIds.size, 0);
      assert.equal(f.snapshot().effects.radio, 0);
      assert.equal(f.snapshot().effects.pointer, 0);
      assert.equal(f.snapshot().effects.metrics, 0);
      const expected = boundary === 'user-turn-start' ? 1 : 2;
      assert.equal(
        f.events.filter((e) =>
          ['user-turn-start', 'interruption'].includes(e.type),
        ).length,
        expected,
      );
    } finally {
      f.close();
    }
  });
}
test('OpenAI a token observer Stop prevents tracker resurrection by the same onset', async () => {
  const f = fixture();
  try {
    await f.start('B');
    await f.transcript('B', 'zoom in');
    await f.commit('B');
    await f.created('B-response');
    const token = f.c._turns.userTurnIntent.forResponse('B-response');
    subscribeVoiceUserTurn(token, (value) => {
      if (!readVoiceUserTurnText(value)) f.c.stop();
    });
    await f.start('C');
    assert.equal(f.c.dc, null);
    assert.equal(
      f.c._turns.userTurnIntent.transcript('C', 'late input'),
      false,
    );
    assert.equal(f.c.userTurnPending, false);
    assert.equal(f.c._turns.admittedSpeechItemIds.size, 0);
  } finally {
    f.close();
  }
});
test('OpenAI opaque provider IDs are compared exactly without guessed ordering or arbitrary length rules', async () => {
  const f = fixture();
  try {
    for (const id of [
      'z-last-looking',
      'a-first-looking',
      'opaque-' + 'x'.repeat(4096),
    ]) {
      await f.start(id);
      await f.transcript(id, id);
      await f.commit(id);
      await f.created('reply-' + id.length);
      assert.equal(
        readVoiceUserTurnText(
          f.c._turns.userTurnIntent.forResponse('reply-' + id.length),
        ),
        id,
      );
      await f.done('reply-' + id.length);
    }
  } finally {
    f.close();
  }
});
test('OpenAI late original commits keep their response slots; rejecting a repeated start does not reorder them', async () => {
  const f = fixture();
  try {
    await f.start('A');
    await f.start('B');
    await f.start('A');
    await f.commit('A');
    await f.transcript('B', 'current B');
    await f.commit('B');
    await f.created('old-A');
    assert.equal(f.c._turns.isSupersededResponse('old-A'), true);
    await f.created('current-B');
    assert.equal(
      readVoiceUserTurnText(f.c._turns.userTurnIntent.forResponse('current-B')),
      'current B',
    );
  } finally {
    f.close();
  }
});

for (const via of ['boundary', 'token']) {
  test(`OpenAI a newer typed request from a ${via} observer owns the next real response`, async () => {
    let armed = false;
    const f = fixture({
      onEvent: (event, c) => {
        if (armed && via === 'boundary' && event.type === 'user-turn-start') {
          armed = false;
          c.sendTextCommand('newer typed request');
        }
      },
    });
    try {
      await f.start('B');
      await f.transcript('B', 'old B');
      await f.commit('B');
      await f.created('R0');
      if (via === 'token')
        subscribeVoiceUserTurn(
          f.c._turns.userTurnIntent.forResponse('R0'),
          (token) => {
            if (armed && !readVoiceUserTurnText(token)) {
              armed = false;
              f.c.sendTextCommand('newer typed request');
            }
          },
        );
      armed = true;
      await f.start('C');
      await f.transcript('C', 'older C request');
      await f.done('R0');
      await f.clientCreated('typed-response');
      await f.tool('typed-response', 'newest');
      assert.equal(f.calls.length, 1);
      assert.equal(
        readVoiceUserTurnText(f.calls[0].options.userTurn),
        'newer typed request',
      );
      assert.equal(
        readVoiceUserTurnProvenance(f.calls[0].options.userTurn).inputKind,
        'typed',
      );
    } finally {
      f.close();
    }
  });
}
test('OpenAI reentrant replacement during onset cannot mutate the replacement lifetime', async () => {
  let armed = false;
  let f;
  f = fixture({
    onEvent: (event, c) => {
      if (armed && event.type === 'user-turn-start') {
        armed = false;
        c.stop();
        c.dc = f.channel();
        c.status = 'listening';
      }
    },
  });
  try {
    const oldChannel = f.c.dc;
    armed = true;
    await f.start('B');
    assert.notEqual(f.c.dc, oldChannel);
    assert.equal(f.c.userTurnPending, false);
    assert.equal(f.c._turns.admittedSpeechItemIds.size, 0);
    assert.equal(f.events.filter((e) => e.type === 'interruption').length, 0);
    await f.start('B');
    await f.transcript('B', 'replacement request');
    await f.commit('B');
    await f.created('replacement');
    assert.equal(
      readVoiceUserTurnText(
        f.c._turns.userTurnIntent.forResponse('replacement'),
      ),
      'replacement request',
    );
  } finally {
    f.close();
  }
});
test('OpenAI local push-to-talk interruption does not forget already admitted provider IDs', async () => {
  const f = fixture();
  try {
    await f.start('B');
    await f.transcript('B', 'old speech');
    await f.commit('B');
    await f.created('B-response');
    assert.equal(f.c._turns.bargeIn(), true);
    const before = f.snapshot();
    await f.start('B');
    assert.deepEqual(f.snapshot(), before);
    await f.start('C');
    await f.transcript('C', 'new speech');
    await f.commit('C');
    await f.created('C-response');
    assert.equal(
      readVoiceUserTurnText(
        f.c._turns.userTurnIntent.forResponse('C-response'),
      ),
      'new speech',
    );
  } finally {
    f.close();
  }
});

for (const via of ['boundary', 'token']) {
  test(`OpenAI late committed onset superseded by a ${via} typed observer keeps stale and typed FIFO slots distinct`, async () => {
    let armed = false;
    const f = fixture({
      onEvent: (event, c) => {
        if (armed && via === 'boundary' && event.type === 'user-turn-start') {
          armed = false;
          c.sendTextCommand('newer typed request');
        }
      },
    });
    try {
      await f.start('B');
      await f.transcript('B', 'old B');
      await f.commit('B');
      await f.created('R0');
      if (via === 'token')
        subscribeVoiceUserTurn(
          f.c._turns.userTurnIntent.forResponse('R0'),
          (token) => {
            if (armed && !readVoiceUserTurnText(token)) {
              armed = false;
              f.c.sendTextCommand('newer typed request');
            }
          },
        );
      armed = true;
      await f.start('C');
      assert.deepEqual(f.c._turns.userTurnIntent.reservationState(), {
        pending: 0,
        overflowed: false,
      });
      assert.equal(f.c.pendingUserTextResponse, true);
      await f.transcript('C', 'older C request');
      await f.commit('C');
      assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 1);
      await f.done('R0');
      assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 2);
      const beforeCreates = f.sent.filter(
        (e) => e.type === 'response.create',
      ).length;
      await f.created('C-response');
      assert.equal(f.c._turns.isSupersededResponse('C-response'), true);
      assert.equal(
        f.sent.some(
          (e) => e.type === 'response.cancel' && e.response_id === 'C-response',
        ),
        true,
      );
      await f.tool('C-response', 'stale-C');
      assert.equal(f.output().at(-1).superseded, true);
      assert.equal(f.calls.length, 0);
      assert.equal(f.c.pendingResponseInstructions, null);
      assert.equal(
        f.sent.filter((e) => e.type === 'response.create').length,
        beforeCreates,
      );
      await f.done('C-response');
      await f.clientCreated('typed-response');
      const typed = f.c._turns.userTurnIntent.forResponse('typed-response');
      assert.equal(readVoiceUserTurnText(typed), 'newer typed request');
      await f.tool('typed-response', 'typed-T');
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].options.userTurn, typed);
      assert.equal(readVoiceUserTurnText(typed), 'newer typed request');
      await f.event({
        type: 'response.done',
        response: {
          id: 'typed-response',
          status: 'completed',
          output: [{ type: 'function_call' }],
        },
      });
      await f.clientCreated('typed-followup');
      assert.equal(
        f.c._turns.userTurnIntent.forResponse('typed-followup'),
        typed,
      );
      await f.done('typed-followup');
      await f.start('D');
      await f.transcript('D', 'genuine next speech');
      await f.commit('D');
      await f.start('C');
      await f.created('D-response');
      await f.tool('D-response', 'genuine-D');
      assert.equal(f.calls.length, 2);
      assert.equal(
        readVoiceUserTurnText(f.calls[1].options.userTurn),
        'genuine next speech',
      );
      assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
    } finally {
      f.close();
    }
  });
}
