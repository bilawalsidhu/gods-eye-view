import test from 'node:test';
import assert from 'node:assert/strict';
import { GevRealtimeController } from './realtimeController.js';
import {
  readVoiceUserTurnText,
  subscribeVoiceUserTurn,
} from './userTurnIntent.js';

function fixture({ onEvent, pending = false } = {}) {
  const sent = [],
    calls = [],
    events = [],
    releases = [];
  const effects = { metrics: 0, speech: 0, response: 0 };
  let c;
  c = new GevRealtimeController({
    runner: async (_name, _args, options) => {
      calls.push(options);
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
    send: (v) => sent.push(JSON.parse(v)),
    close() {
      this.readyState = 'closed';
    },
  });
  c.dc = channel();
  c.status = 'listening';
  c._turns.narration = null;
  for (const [owner, name, effect] of [
    [c._metrics, 'serverEvent', 'metrics'],
    [c._turns, 'observeSpeech', 'speech'],
    [c._turns, 'updateResponseState', 'response'],
  ]) {
    const original = owner[name].bind(owner);
    owner[name] = (...args) => {
      effects[effect]++;
      return original(...args);
    };
  }
  const event = (payload, source = c.dc) =>
    c.handleRealtimeEvent({
      data: JSON.stringify(payload),
      currentTarget: source,
    });
  const created = (id, metadata) =>
    event({ type: 'response.created', response: { id, metadata } });
  const done = (id, tool = false) =>
    event({
      type: 'response.done',
      response: {
        id,
        status: 'completed',
        output: tool ? [{ type: 'function_call' }] : [],
      },
    });
  const tool = (id, call) =>
    event({
      type: 'response.function_call_arguments.done',
      response_id: id,
      call_id: call,
      name: 'get_entity_context',
      arguments: '{}',
    });
  const speech = async (id, text) => {
    await event({ type: 'input_audio_buffer.speech_started', item_id: id });
    await event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      transcript: text,
    });
    await event({ type: 'input_audio_buffer.committed', item_id: id });
  };
  const request = () => sent.findLast((e) => e.type === 'response.create');
  const output = () =>
    sent
      .filter((e) => e.item?.type === 'function_call_output')
      .map((e) => JSON.parse(e.item.output));
  const snapshot = () => ({
    effects: { ...effects },
    events: events.length,
    pending: c._turns.userTurnIntent.reservationState(),
    active: c.activeResponseId,
    responseActive: c.responseActive,
    responsePending: c.responseCreatePending,
    typedPending: c.pendingUserTextResponse,
    instructions: c.pendingResponseInstructions,
  });
  const close = () => {
    releases.splice(0).forEach((r) => r({ ok: true }));
    c.stop();
  };
  return {
    c,
    sent,
    calls,
    events,
    effects,
    channel,
    event,
    created,
    done,
    tool,
    speech,
    request,
    output,
    snapshot,
    close,
  };
}

for (const code of [
  'conversation_already_has_active_response',
  'server_error',
]) {
  test(`OpenAI ${code} retirement cannot erase the token observer's newer typed request`, async () => {
    const f = fixture();
    try {
      f.c.sendTextCommand('original T0');
      await f.created('T0', f.request().response.metadata);
      const original = f.c._turns.userTurnIntent.forResponse('T0');
      await f.tool('T0', 'T0-tool');
      await f.done('T0', true);
      const rejected = f.request();
      let armed = true;
      subscribeVoiceUserTurn(original, (token) => {
        if (armed && !readVoiceUserTurnText(token)) {
          armed = false;
          f.c.sendTextCommand('observer T1');
        }
      });
      await f.event({
        type: 'error',
        error: {
          code,
          event_id: rejected.event_id,
          message: 'synthetic rejection',
        },
      });
      assert.equal(readVoiceUserTurnText(original), undefined);
      if (code === 'conversation_already_has_active_response') {
        assert.equal(f.c.pendingUserTextResponse, true);
        await f.done('other-active-response');
      }
      const successor = f.request();
      assert.notEqual(
        successor.event_id,
        rejected.event_id,
        'new input has its own response request',
      );
      await f.created('T1', successor.response.metadata);
      await f.tool('T1', 'T1-tool');
      assert.equal(
        readVoiceUserTurnText(f.calls.at(-1).userTurn),
        'observer T1',
      );
      assert.equal(
        f.sent.filter(
          (e) =>
            e.type === 'response.create' && e.event_id === rejected.event_id,
        ).length,
        1,
        'rejected request is not retried',
      );
    } finally {
      f.close();
    }
  });
}

for (const count of [1, 20]) {
  test(`OpenAI completed response replay after ${count} input records cannot borrow newer speech authority`, async () => {
    const f = fixture();
    try {
      for (let i = 0; i < count; i++) {
        await f.speech(`old-${i}`, `old speech ${i}`);
        await f.created(`old-response-${i}`);
        await f.done(`old-response-${i}`);
      }
      await f.speech('C', 'genuine C');
      const before = f.snapshot();
      await f.created('old-response-0');
      assert.deepEqual(
        f.snapshot(),
        before,
        'duplicate is rejected before every response semantic consumer',
      );
      await f.tool('old-response-0', 'replayed-tool');
      assert.equal(f.calls.length, 0);
      assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 1);
      await f.created('genuine-C');
      await f.tool('genuine-C', 'C-tool');
      assert.equal(readVoiceUserTurnText(f.calls[0].userTurn), 'genuine C');
      assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
    } finally {
      f.close();
    }
  });
}

for (const code of [
  'conversation_already_has_active_response',
  'server_error',
]) {
  test(`OpenAI ${code} cleanup preserves input submitted synchronously by tool cancellation`, async () => {
    const f = fixture({ pending: true });
    let action;
    try {
      f.c.sendTextCommand('original T0');
      await f.created('T0', f.request().response.metadata);
      action = f.tool('T0', 'pending-T0');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.calls.length, 1);
      await f.done('T0', true);
      f.c.queueResponseCreate('Continue original T0.');
      const rejected = f.request();
      f.calls[0].signal.addEventListener(
        'abort',
        () => f.c.sendTextCommand('cancel observer T1'),
        { once: true },
      );
      await f.event({
        type: 'error',
        error: {
          code,
          event_id: rejected.event_id,
          message: 'synthetic rejection',
        },
      });
      assert.equal(f.calls[0].signal.aborted, true);
      if (code === 'conversation_already_has_active_response') {
        assert.equal(f.c.pendingUserTextResponse, true);
        await f.done('other-active');
      }
      const next = f.request();
      assert.notEqual(next.event_id, rejected.event_id);
      await f.created('T1', next.response.metadata);
      assert.equal(
        readVoiceUserTurnText(f.c._turns.userTurnIntent.forResponse('T1')),
        'cancel observer T1',
      );
    } finally {
      f.close();
      if (action) await action;
    }
  });
}

for (const code of ['conversation_already_has_active_response', 'server_error'])
  for (const replace of [false, true]) {
    test(`OpenAI ${code} token retirement ${replace ? 'replacement' : 'Stop'} cannot resume old error cleanup`, async () => {
      const f = fixture();
      try {
        f.c.sendTextCommand('original T0');
        await f.created('T0', f.request().response.metadata);
        const token = f.c._turns.userTurnIntent.forResponse('T0');
        await f.tool('T0', 'T0-tool');
        await f.done('T0', true);
        const rejected = f.request();
        let armed = true;
        subscribeVoiceUserTurn(token, (value) => {
          if (armed && !readVoiceUserTurnText(value)) {
            armed = false;
            f.c.stop();
            if (replace) {
              f.c.dc = f.channel();
              f.c.status = 'listening';
              f.c.sendTextCommand('replacement T1');
            }
          }
        });
        await f.event({
          type: 'error',
          error: {
            code,
            event_id: rejected.event_id,
            message: 'synthetic rejection',
          },
        });
        if (replace) {
          const next = f.request();
          await f.created('replacement', next.response.metadata);
          await f.tool('replacement', 'replacement-tool');
          assert.equal(
            readVoiceUserTurnText(f.calls.at(-1).userTurn),
            'replacement T1',
          );
        } else {
          assert.equal(f.c.dc, null);
          assert.equal(f.c.status, 'idle');
          assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
        }
      } finally {
        f.close();
      }
    });
  }

for (const id of [undefined, null, '', 8, {}, []]) {
  test(`OpenAI malformed response-created ID ${JSON.stringify(id)} is inert`, async () => {
    const f = fixture();
    try {
      await f.speech('C', 'genuine C');
      const before = f.snapshot();
      await f.created(id);
      assert.deepEqual(f.snapshot(), before);
      await f.created('valid');
      await f.tool('valid', 'valid-tool');
      assert.equal(readVoiceUserTurnText(f.calls[0].userTurn), 'genuine C');
    } finally {
      f.close();
    }
  });
}

test('OpenAI duplicate current response-created preserves its running tool and distinct subsequent events', async () => {
  const f = fixture({ pending: true });
  let action;
  try {
    await f.speech('B', 'genuine B');
    await f.created('B-response');
    const token = f.c._turns.userTurnIntent.forResponse('B-response');
    action = f.tool('B-response', 'first-tool');
    await new Promise((resolve) => setImmediate(resolve));
    const before = f.snapshot();
    await f.created('B-response');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.calls[0].signal.aborted, false);
    assert.equal(readVoiceUserTurnText(token), 'genuine B');
    await f.event({
      type: 'response.output_audio_transcript.done',
      response_id: 'B-response',
      transcript: 'normal distinct transcript',
    });
    assert.ok(
      f.effects.speech > before.effects.speech,
      'later distinct response events are not deduplicated',
    );
  } finally {
    f.close();
    if (action) await action;
  }
});

test('OpenAI wrong or closed transport cannot admit/poison a response identity', async () => {
  const f = fixture();
  try {
    await f.speech('B', 'genuine B');
    const before = f.snapshot();
    await f.event(
      { type: 'response.created', response: { id: 'reusable' } },
      f.channel(),
    );
    assert.deepEqual(f.snapshot(), before);
    f.c.dc.readyState = 'closed';
    await f.created('reusable');
    assert.deepEqual(f.snapshot(), before);
    f.c.dc.readyState = 'open';
    await f.created('reusable');
    await f.tool('reusable', 'valid-tool');
    assert.equal(readVoiceUserTurnText(f.calls[0].userTurn), 'genuine B');
  } finally {
    f.close();
  }
});

for (const progress of [false, true]) {
  test(`OpenAI ${progress ? 'progress' : 'out-of-band'} response replay is rejected before consumers`, async () => {
    const f = fixture();
    try {
      const payload = {
        type: 'response.created',
        response: {
          id: 'outside',
          conversation_id: null,
          metadata: progress ? { gev: 'progress' } : { topic: 'other' },
        },
      };
      await f.event(payload);
      const before = f.snapshot();
      await f.event(payload);
      assert.deepEqual(f.snapshot(), before);
      await f.event({
        type: 'response.done',
        response: {
          id: 'outside',
          status: 'completed',
          metadata: payload.response.metadata,
          output: [],
        },
      });
      assert.ok(
        f.effects.metrics > before.effects.metrics,
        'distinct done is processed',
      );
    } finally {
      f.close();
    }
  });
}

test('OpenAI Stop/reset releases response history and legitimate new connection may reuse the same response ID', async () => {
  const f = fixture();
  try {
    await f.speech('B', 'old speech');
    await f.created('same-response');
    await f.done('same-response');
    const oldChannel = f.c.dc;
    const oldHistory = f.c._turns.admittedResponseIds;
    f.c.stop();
    assert.equal(oldHistory.size, 0);
    assert.notEqual(f.c._turns.admittedResponseIds, oldHistory);
    f.c.dc = f.channel();
    f.c.status = 'listening';
    await f.speech('B', 'new speech');
    const before = f.snapshot();
    await f.event(
      { type: 'response.created', response: { id: 'same-response' } },
      oldChannel,
    );
    assert.deepEqual(f.snapshot(), before);
    await f.created('same-response');
    await f.tool('same-response', 'new-tool');
    assert.equal(readVoiceUserTurnText(f.calls[0].userTurn), 'new speech');
  } finally {
    f.close();
  }
});

for (const via of ['boundary', 'metrics', 'speaker']) {
  test(`OpenAI accepted response callback ${via} Stop cannot resurrect old response state`, async () => {
    let armed = false;
    const f = fixture({
      onEvent: (event, c) => {
        if (armed && via === 'boundary' && event.type === 'response-start') {
          armed = false;
          c.stop();
        }
      },
    });
    try {
      if (via === 'metrics') {
        const original = f.c._metrics.serverEvent.bind(f.c._metrics);
        f.c._metrics.serverEvent = (payload) => {
          original(payload);
          if (armed && payload.type === 'response.created') {
            armed = false;
            f.c.stop();
          }
        };
      }
      if (via === 'speaker') {
        const original = f.c._turns.setVoiceSpeaker;
        f.c._turns.setVoiceSpeaker = (...args) => {
          original(...args);
          if (armed) {
            armed = false;
            f.c.stop();
          }
        };
      }
      await f.speech('B', 'old speech');
      armed = true;
      await f.created('old-response');
      assert.equal(f.c.dc, null);
      assert.equal(f.c.status, 'idle');
      assert.equal(f.c.responseActive, false);
      assert.equal(f.c.activeResponseId, null);
      assert.equal(f.c._turns.admittedResponseIds.size, 0);
    } finally {
      f.close();
    }
  });
}

test('OpenAI accepted response keeps distinct sibling tool calls after a duplicate creation', async () => {
  const f = fixture();
  try {
    await f.speech('B', 'genuine B');
    await f.created('B-response');
    const token = f.c._turns.userTurnIntent.forResponse('B-response');
    await f.tool('B-response', 'first');
    await f.created('B-response');
    await f.tool('B-response', 'second');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].userTurn, token);
    assert.equal(f.calls[1].userTurn, token);
  } finally {
    f.close();
  }
});

test('OpenAI nested replacement can reuse a response ID without the old accepted event resuming into it', async () => {
  let armed = false;
  let nested;
  let f;
  f = fixture({
    onEvent: (event, c) => {
      if (armed && event.type === 'response-start') {
        armed = false;
        c.stop();
        c.dc = f.channel();
        c.status = 'listening';
        c.sendTextCommand('replacement typed input');
        nested = f.created('shared-response', f.request().response.metadata);
      }
    },
  });
  try {
    await f.speech('B', 'old B');
    armed = true;
    await f.created('shared-response');
    await nested;
    assert.equal(f.c.responseActive, true);
    assert.equal(f.c.activeResponseId, 'shared-response');
    const token = f.c._turns.userTurnIntent.forResponse('shared-response');
    assert.equal(readVoiceUserTurnText(token), 'replacement typed input');
    await f.tool('shared-response', 'replacement-tool');
    assert.equal(f.calls[0].userTurn, token);
  } finally {
    f.close();
  }
});
