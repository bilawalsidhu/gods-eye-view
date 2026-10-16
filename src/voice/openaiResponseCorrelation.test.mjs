import test from 'node:test';
import assert from 'node:assert/strict';
import { GevRealtimeController } from './realtimeController.js';
import {
  readVoiceUserTurnText,
  subscribeVoiceUserTurn,
} from './userTurnIntent.js';

function fixture({ via, onEvent, send } = {}) {
  const sent = [],
    calls = [],
    events = [];
  let armed = false;
  const c = new GevRealtimeController({
    runner: async (_name, _args, options) => {
      calls.push(options.userTurn);
      return { ok: true };
    },
    backend: {},
    debugSink: null,
    onSessionEvent: (event) => {
      events.push(event);
      if (armed && via === 'boundary' && event.type === 'user-turn-start') {
        armed = false;
        c.sendTextCommand('newer typed request');
      }
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
    send: (value) => {
      const payload = JSON.parse(value);
      sent.push(payload);
      send?.(payload, c);
    },
    close() {
      this.readyState = 'closed';
    },
  });
  c.dc = channel();
  c.status = 'listening';
  c._turns.narration = null;
  const event = (payload) =>
    c.handleRealtimeEvent({
      data: JSON.stringify(payload),
      currentTarget: c.dc,
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
      response: { id, ...(metadata === undefined ? {} : { metadata }) },
    });
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
  const request = () =>
    sent.findLast(
      (e) =>
        e.type === 'response.create' &&
        e.response?.metadata?.gev !== 'progress',
    );
  const output = () =>
    sent
      .filter((e) => e.item?.type === 'function_call_output')
      .map((e) => JSON.parse(e.item.output));
  const prepare = async () => {
    await start('B');
    await transcript('B', 'old B');
    await commit('B');
    await created('R0');
    if (via === 'token')
      subscribeVoiceUserTurn(
        c._turns.userTurnIntent.forResponse('R0'),
        (token) => {
          if (armed && !readVoiceUserTurnText(token)) {
            armed = false;
            c.sendTextCommand('newer typed request');
          }
        },
      );
    armed = true;
    await start('C');
    await transcript('C', 'older C speech');
  };
  return {
    c,
    sent,
    calls,
    events,
    channel,
    event,
    start,
    transcript,
    commit,
    created,
    done,
    tool,
    request,
    output,
    prepare,
    close: () => c.stop(),
  };
}

for (const via of ['boundary', 'token'])
  for (const commitFirst of [false, true])
    for (const typedFirst of [false, true]) {
      test(`OpenAI correlation ${via}: commit ${commitFirst ? 'before' : 'after'} old done, ${typedFirst ? 'typed' : 'speech'} response first`, async () => {
        const f = fixture({ via });
        try {
          await f.prepare();
          assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
          if (commitFirst) await f.commit('C');
          await f.done('R0');
          const request = f.request();
          if (!commitFirst) await f.commit('C');
          if (typedFirst) {
            await f.created('typed-T', request?.response?.metadata);
            await f.created('automatic-C');
          } else {
            await f.created('automatic-C');
            await f.created('typed-T', request?.response?.metadata);
          }
          const typed = f.c._turns.userTurnIntent.forResponse('typed-T');
          await f.tool('automatic-C', 'C-call');
          assert.equal(
            f.calls.length,
            0,
            'spoken C must never run with typed T authority',
          );
          assert.equal(f.output().at(-1).superseded, true);
          assert.equal(f.c.pendingResponseInstructions, null);
          assert.equal(readVoiceUserTurnText(typed), 'newer typed request');
          await f.tool('typed-T', 'T-call');
          assert.equal(f.calls.length, 1);
          assert.equal(f.calls[0], typed);
          assert.equal(
            readVoiceUserTurnText(f.calls[0]),
            'newer typed request',
          );
          assert.equal(
            request.response.metadata.gev_request_id,
            request.event_id,
          );
        } finally {
          f.close();
        }
      });
    }

for (const tag of ['unknown', '', 7, {}, [], null]) {
  test(`OpenAI unknown or malformed client correlation ${JSON.stringify(tag)} cannot consume speech or typed reservations`, async () => {
    const f = fixture();
    try {
      await f.start('B');
      await f.transcript('B', 'older speech');
      await f.commit('B');
      f.c.sendTextCommand('newer typed request');
      const request = f.request();
      assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 2);
      await f.created('foreign', { gev_request_id: tag });
      await f.tool('foreign', 'foreign-tool');
      assert.equal(f.calls.length, 0);
      assert.equal(f.output().at(-1).superseded, true);
      assert.equal(f.c.pendingResponseInstructions, null);
      assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 2);
      await f.created('automatic-B');
      assert.equal(f.c._turns.isSupersededResponse('automatic-B'), true);
      await f.created('typed-T', request.response.metadata);
      await f.tool('typed-T', 'typed-tool');
      assert.equal(readVoiceUserTurnText(f.calls[0]), 'newer typed request');
    } finally {
      f.close();
    }
  });
}

test('OpenAI absent client metadata cannot borrow typed authority or pass it through an unverified followup', async () => {
  const f = fixture();
  try {
    f.c.sendTextCommand('newer typed request');
    const request = f.request();
    await f.created('unrelated-automatic');
    await f.tool('unrelated-automatic', 'unverified-call');
    assert.equal(f.calls.length, 0);
    assert.equal(f.output().at(-1).voiceIntentUnverified, true);
    assert.equal(
      f.c.pendingResponseInstructions,
      null,
      'untracked response cannot queue a followup with current typed authority',
    );
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 1);
    await f.created('typed-T', request.response.metadata);
    await f.tool('typed-T', 'real-T');
    assert.equal(readVoiceUserTurnText(f.calls[0]), 'newer typed request');
  } finally {
    f.close();
  }
});

test('OpenAI tagged followup keeps the exact originating request and ignores out-of-band progress', async () => {
  const f = fixture();
  try {
    f.c.sendTextCommand('newer typed request');
    await f.created('typed-T', f.request().response.metadata);
    const token = f.c._turns.userTurnIntent.forResponse('typed-T');
    await f.tool('typed-T', 'T-tool');
    await f.done('typed-T', true);
    const followup = f.request();
    assert.ok(followup.response.instructions);
    assert.equal(followup.response.metadata.gev_request_id, followup.event_id);
    await f.created('progress', { gev: 'progress' });
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 1);
    await f.created('followup', followup.response.metadata);
    assert.equal(f.c._turns.userTurnIntent.forResponse('followup'), token);
    await f.done('followup');
    assert.equal(readVoiceUserTurnText(token), undefined);
  } finally {
    f.close();
  }
});

test('OpenAI duplicate tagged response events do not consume another request or speech slot', async () => {
  const f = fixture();
  try {
    f.c.sendTextCommand('newer typed request');
    const metadata = f.request().response.metadata;
    await f.created('typed-T', metadata);
    const token = f.c._turns.userTurnIntent.forResponse('typed-T');
    await f.created('typed-T', metadata);
    assert.equal(f.c._turns.userTurnIntent.forResponse('typed-T'), token);
    await f.start('C');
    await f.transcript('C', 'new speech');
    await f.commit('C');
    await f.created('duplicate-request-response', metadata);
    assert.equal(
      f.c._turns.isSupersededResponse('duplicate-request-response'),
      true,
    );
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 1);
    await f.created('C-response');
    await f.tool('C-response', 'C-tool');
    assert.equal(readVoiceUserTurnText(f.calls[0]), 'new speech');
  } finally {
    f.close();
  }
});

for (const lifecycle of ['stop', 'replace', 'new typed']) {
  test(`OpenAI synchronous ${lifecycle} during actual response send cannot reserve newer authority`, async () => {
    let armed = true;
    let sentRequest;
    let f;
    f = fixture({
      send: (payload, c) => {
        if (!armed || payload.type !== 'response.create') return;
        armed = false;
        sentRequest = payload;
        if (lifecycle === 'new typed') c.sendTextCommand('new typed successor');
        else {
          c.stop();
          if (lifecycle === 'replace') {
            c.dc = f.channel();
            c.status = 'listening';
          }
        }
      },
    });
    try {
      f.c.sendTextCommand('original typed request');
      if (lifecycle === 'stop') {
        assert.equal(f.c.dc, null);
        assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
      } else {
        if (lifecycle === 'replace') {
          assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
          f.c.sendTextCommand('new typed successor');
        }
        await f.created('old-sent-response', sentRequest.response.metadata);
        await f.tool('old-sent-response', 'old-tool');
        assert.equal(f.calls.length, 0);
        assert.equal(f.output().at(-1).superseded, true);
        if (lifecycle === 'new typed') await f.done('old-sent-response');
        const latest = f.request();
        assert.notEqual(latest.event_id, sentRequest.event_id);
        await f.created('new-response', latest.response.metadata);
        await f.tool('new-response', 'new-tool');
        assert.equal(readVoiceUserTurnText(f.calls[0]), 'new typed successor');
      }
    } finally {
      f.close();
    }
  });
}

for (const stage of ['conversation.item.create', 'response.create']) {
  test(`OpenAI failed ${stage} never reserves a response or authorizes an automatic reply`, async () => {
    const f = fixture({
      send: (payload) => {
        if (payload.type === stage) throw new Error('synthetic send failure');
      },
    });
    try {
      f.c.sendTextCommand('newer typed request');
      assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
      await f.created('untracked');
      await f.tool('untracked', 'untracked-tool');
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  });
}

test('OpenAI rejected tagged request cannot consume later genuine speech authority', async () => {
  const f = fixture();
  try {
    f.c.sendTextCommand('old typed request');
    const rejected = f.request();
    await f.start('C');
    await f.transcript('C', 'genuine speech');
    await f.commit('C');
    await f.event({
      type: 'error',
      event_id: 'server-error',
      error: {
        code: 'conversation_already_has_active_response',
        event_id: rejected.event_id,
        message: 'synthetic overlap',
      },
    });
    await f.created('rejected-request-response', rejected.response.metadata);
    assert.equal(
      f.c._turns.isSupersededResponse('rejected-request-response'),
      true,
    );
    await f.created('C-response');
    await f.tool('C-response', 'C-tool');
    assert.equal(readVoiceUserTurnText(f.calls[0]), 'genuine speech');
  } finally {
    f.close();
  }
});

test('OpenAI local barge-in drops a deferred typed capture before a late old completion', async () => {
  const f = fixture();
  try {
    await f.created('R0');
    f.c.sendTextCommand('deferred typed');
    assert.equal(f.c.pendingUserTextResponse, true);
    f.c._turns.bargeIn();
    await f.done('R0');
    assert.equal(f.sent.filter((e) => e.type === 'response.create').length, 0);
    assert.equal(f.c.pendingUserTextResponse, false);
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
  } finally {
    f.close();
  }
});

test('OpenAI unrelated explicit out-of-band response never consumes a tagged typed request', async () => {
  const f = fixture();
  try {
    f.c.sendTextCommand('newer typed request');
    const request = f.request();
    await f.event({
      type: 'response.created',
      response: {
        id: 'foreign-oob',
        conversation_id: null,
        metadata: request.response.metadata,
      },
    });
    await f.tool('foreign-oob', 'oob-tool');
    assert.equal(f.calls.length, 0);
    assert.equal(f.c.pendingResponseInstructions, null);
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 1);
    await f.created('typed-T', request.response.metadata);
    await f.tool('typed-T', 'T-tool');
    assert.equal(readVoiceUserTurnText(f.calls[0]), 'newer typed request');
  } finally {
    f.close();
  }
});

test('OpenAI duplicate late commits for retained retired C do not duplicate reservations', async () => {
  const f = fixture({ via: 'boundary' });
  try {
    await f.prepare();
    await f.done('R0');
    const request = f.request();
    await f.commit('C');
    await f.commit('C');
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 2);
    await f.created('automatic-C');
    await f.commit('C');
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 1);
    await f.created('typed-T', request.response.metadata);
    await f.tool('typed-T', 'T-tool');
    assert.equal(readVoiceUserTurnText(f.calls[0]), 'newer typed request');
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
  } finally {
    f.close();
  }
});

test('OpenAI a newer typed input during a followup send cannot own the old followup response', async () => {
  let armed = true;
  const f = fixture({
    send: (payload, c) => {
      if (
        armed &&
        payload.type === 'response.create' &&
        payload.response?.instructions
      ) {
        armed = false;
        c.sendTextCommand('new typed successor');
      }
    },
  });
  try {
    f.c.sendTextCommand('original typed request');
    await f.created('T-original', f.request().response.metadata);
    await f.tool('T-original', 'original-tool');
    await f.done('T-original', true);
    const oldFollowup = f.request();
    await f.created('old-followup', oldFollowup.response.metadata);
    await f.tool('old-followup', 'old-followup-tool');
    assert.equal(f.calls.length, 1);
    assert.equal(f.output().at(-1).superseded, true);
    await f.done('old-followup');
    const latest = f.request();
    assert.notEqual(latest.event_id, oldFollowup.event_id);
    await f.created('T-successor', latest.response.metadata);
    await f.tool('T-successor', 'successor-tool');
    assert.equal(readVoiceUserTurnText(f.calls[1]), 'new typed successor');
  } finally {
    f.close();
  }
});
