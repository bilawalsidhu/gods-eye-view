// Actual controller traces: typed input cannot borrow or lose another input's identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './geminiNativeHarness.mjs';
import { GevRealtimeController } from './realtimeController.js';
import { withToolCatalog } from './gevRealtime.js';
import { createNarrationScheduler } from './narration.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
} from './voiceCardPresentation.js';
import {
  readVoiceUserTurnText,
  readVoiceUserTurnProvenance,
  subscribeVoiceUserTurn,
} from './userTurnIntent.js';

const activity = (ws, type) => ws.message({ voiceActivity: { type } });
const onset = (ws) => {
  activity(ws, 'ACTIVITY_START');
  activity(ws, 'ACTIVITY_END');
};
const marker = (ws, complete = true) =>
  ws.message({ serverContent: { interrupted: true, turnComplete: complete } });
const audio = {
  serverContent: {
    modelTurn: {
      parts: [
        { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
      ],
    },
  },
};
const tool = (ws, id) =>
  ws.message({
    toolCall: {
      functionCalls: [
        {
          id,
          name: 'adjust_camera_zoom',
          args: { direction: 'in', amount: 'little' },
        },
      ],
    },
  });
async function gemini(run, options) {
  const h = harness();
  try {
    await h.c.start(options);
    await run(h, h.sockets[0]);
  } finally {
    h.c.stop();
    assert.equal(h.timers.size, 0, 'all owned timers released');
  }
}
for (const text of ['Zoom in', 'Switch voice provider to OpenAI']) {
  test(`Gemini unobserved automatic predecessor preserves typed policy - ${text}`, () =>
    gemini(async (h, ws) => {
      onset(ws);
      assert.equal(h.c.replyPending, false);
      assert.equal(h.c.sendTextCommand(text), true);
      const typed = h.c.readTypedTurnInput();
      assert.ok(h.c.typedIntent.automaticPredecessor);
      marker(ws);
      assert.equal(h.c.readTypedTurnInput(), typed);
      assert.equal(readVoiceUserTurnText(typed), text);
      assert.equal(h.c.typedIntent.automaticPredecessor, null);
      tool(ws, 'current');
      await h.c.toolQueue;
      if (text.startsWith('Switch')) {
        assert.equal(h.calls.length, 0);
        assert.equal(
          ws.sent.at(-1).toolResponse.functionResponses[0].response
            .providerRequestBlocked,
          true,
        );
      } else {
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0].options.userTurn, typed);
      }
    }));
}
test('Gemini omitted predecessor marker neither fences nor times out a typed reply', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Zoom in');
    const typed = h.c.readTypedTurnInput();
    assert.equal(h.c.retiredReplyPending, false);
    assert.equal(h.c.retiredBoundaryWait, null);
    h.advance(5001);
    assert.equal(h.c.isActive(), true);
    tool(ws, 'no-marker');
    await h.c.toolQueue;
    assert.equal(h.calls[0].options.userTurn, typed);
    assert.equal(
      h.c.typedIntent.automaticPredecessor,
      null,
      'actual successor output consumes the candidate',
    );
  }));
test('Gemini observed predecessor output keeps its existing retirement route', () =>
  gemini(async (h, ws) => {
    ws.message(audio);
    onset(ws);
    h.c.sendTextCommand('Zoom in');
    const typed = h.c.readTypedTurnInput();
    assert.equal(h.c.retiredReplyPending, true);
    assert.equal(h.c.typedIntent.automaticPredecessor, null);
    marker(ws);
    tool(ws, 'observed-control');
    await h.c.toolQueue;
    assert.equal(h.calls[0].options.userTurn, typed);
  }));
test('Gemini split and repeated pending interruption markers discard old output without revoking typed input', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Zoom in');
    const typed = h.c.readTypedTurnInput();
    marker(ws, false);
    marker(ws, false);
    assert.equal(h.c.readTypedTurnInput(), typed);
    ws.message(audio);
    tool(ws, 'old-before-boundary');
    await h.c.toolQueue;
    assert.equal(h.calls.length, 0);
    assert.equal(h.captures[0].played.length, 0);
    marker(ws);
    assert.equal(h.c.readTypedTurnInput(), typed);
    tool(ws, 'new-after-boundary');
    await h.c.toolQueue;
    assert.equal(h.calls[0].options.userTurn, typed);
  }));
test('Gemini coalesced retired tool and audio cannot run with typed successor ownership', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Zoom in');
    const typed = h.c.readTypedTurnInput();
    ws.message({
      serverContent: {
        ...audio.serverContent,
        interrupted: true,
        turnComplete: true,
      },
      toolCall: {
        functionCalls: [
          { id: 'retired-coalesced', name: 'adjust_camera_zoom', args: {} },
        ],
      },
    });
    await h.c.toolQueue;
    assert.equal(h.calls.length, 0);
    assert.equal(h.captures[0].played.length, 0);
    assert.equal(h.c.readTypedTurnInput(), typed);
  }));
for (const variant of [
  'separate-start',
  'repeated-marker',
  'boundary-with-start',
  'retired-output',
]) {
  test(`Gemini new activity revokes typed ownership during its precise predecessor wait - ${variant}`, () =>
    gemini(async (h, ws) => {
      onset(ws);
      h.c.sendTextCommand('Switch voice provider to OpenAI');
      const typed = h.c.readTypedTurnInput();
      marker(ws, false);
      assert.equal(h.c.readTypedTurnInput(), typed);
      if (variant === 'repeated-marker') marker(ws, false);
      if (variant === 'retired-output') {
        h.advance(100);
        ws.message(audio);
        assert.equal(
          h.captures[0].played.length,
          0,
          'retired audio is not replayed',
        );
      }
      const originalWait = h.c.retiredBoundaryWait;
      const oldOwner = h.c.retiredAutomaticActivityOwner;
      ws.message({
        voiceActivity: { type: 'ACTIVITY_START' },
        ...(variant === 'boundary-with-start'
          ? { serverContent: { turnComplete: true } }
          : {}),
      });
      const typedAfterStart = h.c.readTypedTurnInput();
      const newOwner = h.c.automaticActivityOwner;
      assert.ok(newOwner);
      assert.notEqual(newOwner, oldOwner);
      assert.equal(
        h.c.deferredInput,
        null,
        'no phantom second input waits behind the predecessor',
      );
      if (variant !== 'boundary-with-start') {
        assert.equal(
          h.c.retiredBoundaryWait,
          originalWait,
          'new onset cannot renew the old bound',
        );
        assert.equal(h.c.retiredBoundaryWait.deadline, originalWait.deadline);
      }
      activity(ws, 'ACTIVITY_END');
      if (variant !== 'boundary-with-start')
        ws.message({ serverContent: { turnComplete: true } });
      assert.equal(
        h.c.automaticActivityOwner,
        newOwner,
        'old boundary cannot clear the real successor',
      );
      assert.equal(
        h.c.retiredReplyPending,
        false,
        'one original boundary closes this wait',
      );
      tool(ws, `new-speech-${variant}`);
      await h.c.toolQueue;
      const result = ws.sent
        .flatMap((m) => m.toolResponse?.functionResponses || [])
        .at(-1)?.response;
      assert.equal(typedAfterStart, undefined);
      assert.equal(readVoiceUserTurnText(typed), undefined);
      assert.equal(
        h.calls.length,
        1,
        'new native input is not refused under old typed provider restriction',
      );
      assert.notEqual(h.calls[0].options.userTurn, typed);
      assert.equal(
        h.calls[0].options.userTurn,
        undefined,
        'native speech does not inherit typed authority',
      );
      assert.notEqual(result?.providerRequestBlocked, true);
    }));
}
test('Gemini the original predecessor deadline still ends the session after new onset', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Switch voice provider to OpenAI');
    marker(ws, false);
    const deadline = h.c.retiredBoundaryWait.deadline;
    activity(ws, 'ACTIVITY_START');
    activity(ws, 'ACTIVITY_END');
    assert.equal(h.c.readTypedTurnInput(), undefined);
    assert.equal(h.c.deferredInput, null);
    h.advance(deadline - 1);
    assert.equal(h.c.isActive(), true);
    h.advance(1);
    assert.equal(h.c.isActive(), false);
    assert.equal(h.c.status, 'error');
    assert.equal(h.timers.size, 0);
    assert.equal(
      h.tracks.every((track) => track.readyState === 'ended'),
      true,
    );
  }));
test('Gemini successor output before new speech retains the existing retirement route', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Switch voice provider to OpenAI');
    const typed = h.c.readTypedTurnInput();
    ws.message(audio);
    activity(ws, 'ACTIVITY_START');
    assert.equal(readVoiceUserTurnText(typed), undefined);
    assert.equal(h.c.readTypedTurnInput(), undefined);
    assert.equal(h.c.retiredReplyPending, true);
    activity(ws, 'ACTIVITY_END');
    ws.message({ serverContent: { turnComplete: true } });
    tool(ws, 'after-output-new-speech');
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.userTurn, undefined);
  }));
test('Gemini goAway preserves the real new activity after exempted retirement onset', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Switch voice provider to OpenAI');
    marker(ws, false);
    activity(ws, 'ACTIVITY_START');
    activity(ws, 'ACTIVITY_END');
    const owner = h.c.automaticActivityOwner;
    assert.equal(h.c.readTypedTurnInput(), undefined);
    ws.message({ goAway: { timeLeft: '30s' } });
    ws.message({ serverContent: { turnComplete: true } });
    assert.equal(h.c.automaticActivityOwner, owner);
    assert.equal(h.c.isActive(), true);
    ws.message(audio);
    ws.message({ serverContent: { turnComplete: true } });
    h.captures[0].drain();
    assert.equal(h.c.isActive(), false);
    assert.equal(h.timers.size, 0);
  }));
test('Gemini genuine new automatic onset before the marker supersedes typed input', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Switch voice provider to OpenAI');
    const typed = h.c.readTypedTurnInput();
    activity(ws, 'ACTIVITY_START');
    assert.equal(h.c.readTypedTurnInput(), undefined);
    assert.equal(readVoiceUserTurnText(typed), undefined);
    marker(ws);
    assert.equal(h.c.readTypedTurnInput(), undefined);
  }));
test('Gemini new onset coalesced with the marker supersedes typed input', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Switch voice provider to OpenAI');
    const typed = h.c.readTypedTurnInput();
    ws.message({
      voiceActivity: { type: 'ACTIVITY_START' },
      serverContent: { interrupted: true, turnComplete: true },
    });
    assert.equal(h.c.readTypedTurnInput(), undefined);
    assert.equal(readVoiceUserTurnText(typed), undefined);
    assert.equal(h.c.automaticTurnOpen, true);
    assert.ok(h.c.automaticActivityOwner);
  }));
for (const outputFirst of [false, true]) {
  test(`Gemini late marker after ${outputFirst ? 'successor output' : 'consumed boundary'} is not guessed to be the predecessor`, () =>
    gemini(async (h, ws) => {
      onset(ws);
      h.c.sendTextCommand('Zoom in');
      if (outputFirst) ws.message(audio);
      else marker(ws);
      assert.equal(h.c.typedIntent.automaticPredecessor, null);
      marker(ws);
      assert.equal(
        h.c.readTypedTurnInput(),
        undefined,
        'existing unattributed-marker behavior remains',
      );
    }));
}
test('Gemini a natural terminal boundary consumes the potential predecessor', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Zoom in');
    assert.ok(h.c.typedIntent.automaticPredecessor);
    ws.message({ serverContent: { turnComplete: true } });
    assert.equal(h.c.typedIntent.automaticPredecessor, null);
    marker(ws);
    assert.equal(h.c.readTypedTurnInput(), undefined);
  }));
test('Gemini a first typed input has no automatic predecessor exemption', () =>
  gemini(async (h, ws) => {
    h.c.sendTextCommand('Zoom in');
    assert.equal(h.c.typedIntent.automaticPredecessor, null);
    marker(ws);
    assert.equal(h.c.readTypedTurnInput(), undefined);
  }));
test('Gemini PTT text does not invent automatic predecessor ownership', () =>
  gemini(
    async (h, ws) => {
      h.c.sendTextCommand('Zoom in');
      assert.equal(h.c.typedIntent.automaticPredecessor, null);
      tool(ws, 'ptt-text');
      await h.c.toolQueue;
      assert.equal(
        readVoiceUserTurnText(h.calls[0].options.userTurn),
        'Zoom in',
      );
    },
    { pushToTalk: true },
  ));
test('Gemini Stop and restart revoke predecessor metadata and reject old-socket markers', () =>
  gemini(async (h, ws) => {
    onset(ws);
    h.c.sendTextCommand('Zoom in');
    const old = h.c.readTypedTurnInput();
    marker(ws, false);
    assert.ok(h.c.retiredBoundaryWait);
    h.c.stop();
    assert.equal(h.c.typedIntent, null);
    assert.equal(h.c.retiredBoundaryWait, null);
    assert.equal(readVoiceUserTurnText(old), undefined);
    await h.c.start();
    h.c.sendTextCommand('Zoom out');
    const fresh = h.c.readTypedTurnInput();
    marker(ws);
    assert.equal(h.c.readTypedTurnInput(), fresh);
    assert.equal(h.c.typedIntent.automaticPredecessor, null);
  }));

function openai() {
  const sent = [],
    calls = [];
  const runner = withToolCatalog(
    async (name, _args, options) => {
      calls.push({
        name,
        text: readVoiceUserTurnText(options.userTurn),
        provenance: readVoiceUserTurnProvenance(options.userTurn),
      });
      return { ok: true };
    },
    async () => ({ get: () => null }),
  );
  const c = new GevRealtimeController({
    runner,
    backend: {},
    debugSink: null,
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
  c.dc = { readyState: 'open', send: (value) => sent.push(JSON.parse(value)) };
  c.status = 'listening';
  c._turns.narration = null;
  const emit = (payload) =>
    c.handleRealtimeEvent({ data: JSON.stringify(payload) });
  const creates = () => sent.filter((e) => e.type === 'response.create');
  const output = () =>
    sent
      .filter((e) => e.item?.type === 'function_call_output')
      .map((e) => JSON.parse(e.item.output));
  const tool = (response, id) =>
    emit({
      type: 'response.function_call_arguments.done',
      response_id: response,
      name: 'adjust_camera_zoom',
      call_id: id,
      arguments: '{"direction":"in","amount":"little"}',
    });
  return {
    c,
    sent,
    calls,
    emit,
    creates,
    output,
    tool,
    close: () => c._turns.reset(),
  };
}
const created = (f, id, metadata) =>
  f.emit({
    type: 'response.created',
    response: { id, ...(metadata ? { metadata } : {}) },
  });
const done = (f, id) =>
  f.emit({
    type: 'response.done',
    response: { id, status: 'completed', output: [] },
  });
const speech = (f, id) =>
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: id });
const committed = (f, id) =>
  f.emit({ type: 'input_audio_buffer.committed', item_id: id });
const transcript = (f, id, text) =>
  f.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: id,
    transcript: text,
  });

test('OpenAI actual newer speech drops unsent typed response with no reservation', async () => {
  const f = openai();
  try {
    await created(f, 'R0');
    f.c.sendTextCommand('zoom in');
    assert.equal(f.c.pendingUserTextResponse, true);
    await speech(f, 'S');
    assert.equal(f.c.pendingUserTextResponse, false);
    assert.equal(f.c._turns.userTurnIntent.reservationState().pending, 0);
    await done(f, 'R0');
    assert.equal(f.creates().length, 0);
  } finally {
    f.close();
  }
});
for (const text of ['zoom out', 'switch to Gemini']) {
  test(`OpenAI superseding speech retains its own policy - ${text}`, async () => {
    const f = openai();
    try {
      await created(f, 'R0');
      f.c.sendTextCommand('zoom in');
      await speech(f, 'S');
      await committed(f, 'S');
      await done(f, 'R0');
      assert.equal(f.creates().length, 0, 'no phantom typed response');
      await transcript(f, 'S', text);
      await created(f, 'S-reply');
      await f.tool('S-reply', 'S-tool');
      if (text.startsWith('switch')) {
        assert.equal(f.calls.length, 0);
        assert.equal(f.output().at(-1).providerRequestBlocked, true);
      } else {
        assert.deepEqual(f.calls, [
          {
            name: 'adjust_camera_zoom',
            text,
            provenance: {
              inputKind: 'speech',
              transcriptionStatus: 'completed',
            },
          },
        ]);
      }
    } finally {
      f.close();
    }
  });
}
for (const mode of ['disabled', 'failed']) {
  test(`OpenAI superseding ${mode} transcription still admits ordinary navigation`, async () => {
    const f = openai();
    try {
      await created(f, 'R0');
      f.c.sendTextCommand('switch to Gemini');
      if (mode === 'disabled') f.c._turns.bindTranscriptionModel('off');
      await speech(f, 'S');
      await committed(f, 'S');
      if (mode === 'failed')
        await f.emit({
          type: 'conversation.item.input_audio_transcription.failed',
          item_id: 'S',
        });
      await done(f, 'R0');
      assert.equal(f.creates().length, 0);
      await created(f, 'S-reply');
      await f.tool('S-reply', 'ordinary');
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.calls[0].provenance, {
        inputKind: 'speech',
        transcriptionStatus: mode,
      });
      assert.equal(f.calls[0].text, undefined);
    } finally {
      f.close();
    }
  });
}
test('OpenAI no-speech deferred typed burst flushes once with latest typed identity', async () => {
  const f = openai();
  try {
    await created(f, 'R0');
    f.c.sendTextCommand('zoom in');
    f.c.sendTextCommand('zoom out');
    await done(f, 'R0');
    assert.equal(f.creates().length, 1);
    await created(f, 'T-reply', f.creates().at(-1)?.response?.metadata);
    await f.tool('T-reply', 'T-tool');
    assert.deepEqual(f.calls, [
      {
        name: 'adjust_camera_zoom',
        text: 'zoom out',
        provenance: { inputKind: 'typed', transcriptionStatus: 'completed' },
      },
    ]);
    assert.equal(f.c.pendingUserTextResponse, false);
  } finally {
    f.close();
  }
});
test('OpenAI already-sent typed response stays superseded by newer speech', async () => {
  const f = openai();
  try {
    f.c.sendTextCommand('zoom in');
    assert.equal(f.creates().length, 1);
    await speech(f, 'S');
    await created(f, 'T-reply', f.creates().at(-1)?.response?.metadata);
    await f.tool('T-reply', 'stale');
    assert.equal(f.calls.length, 0);
    assert.equal(f.output().at(-1).superseded, true);
    assert.ok(
      f.sent.some(
        (e) => e.type === 'response.cancel' && e.response_id === 'T-reply',
      ),
    );
  } finally {
    f.close();
  }
});
test('OpenAI a later typed input after speech is the new owner, not the discarded request', async () => {
  const f = openai();
  try {
    await created(f, 'R0');
    f.c.sendTextCommand('discarded typed request');
    await speech(f, 'S');
    f.c.sendTextCommand('zoom out latest');
    await done(f, 'R0');
    assert.equal(f.creates().length, 1);
    await created(f, 'latest', f.creates().at(-1)?.response?.metadata);
    await f.tool('latest', 'latest-tool');
    assert.equal(f.calls[0].text, 'zoom out latest');
    assert.equal(f.calls[0].provenance.inputKind, 'typed');
  } finally {
    f.close();
  }
});

// B1: callbacks reached during typed admission cannot restore older ownership.
for (const provider of ['OpenAI', 'Gemini']) {
  for (const seam of provider === 'OpenAI'
    ? [
        'boundary',
        'token',
        'abort',
        'pointer',
        'metrics',
        'narration',
        'debug-send',
        'transport',
      ]
    : [
        'boundary',
        'token',
        'abort',
        'pointer',
        'interruption',
        'state',
        'playback',
        'transport',
        'response-start',
      ]) {
    for (const action of ['newer', 'stop']) {
      test(`${provider} typed admission preserves ${action} from ${seam} callback`, async () => {
        let armed = false;
        let fired = false;
        let c;
        const successor = () => {
          if (!armed || fired) return;
          fired = true;
          if (action === 'stop') c.stop();
          else c.sendTextCommand('newer typed successor');
        };
        let h;
        const f = provider === 'OpenAI' ? openai() : null;
        if (f) c = f.c;
        else {
          h = harness();
          c = h.c;
          await c.start({ pushToTalk: true });
        }
        try {
          c.sendTextCommand('seed request');
          if (seam === 'boundary') {
            if (f)
              c.onSessionEvent = (event) => {
                if (event.type === 'user-turn-start') successor();
              };
            else
              c.emit = (event) => {
                if (event.type === 'user-turn-start') successor();
              };
          } else if (seam === 'token') {
            const current = f
              ? c._turns.userTurnIntent.forResponse('seed')
              : c.readTypedTurnInput();
            if (f) {
              c._turns.userTurnIntent.expectResponse();
              c._turns.userTurnIntent.bindResponse('seed');
            }
            const t = f ? c._turns.userTurnIntent.forResponse('seed') : current;
            subscribeVoiceUserTurn(t, () => {
              if (readVoiceUserTurnText(t) === undefined) successor();
            });
          } else if (seam === 'pointer') {
            c.pointer = { beginTurn: () => null, clear() {} };
            if (f)
              c.onSessionEvent = (event) => {
                if (event.type === 'pointer') successor();
              };
            else
              c.emit = (event) => {
                if (event.type === 'pointer') successor();
              };
          } else if (seam === 'metrics') {
            c.onSessionEvent = (event) => {
              if (event.type === 'turn-metrics') successor();
            };
          } else if (seam === 'narration') {
            c._turns.narration = createNarrationScheduler({
              stop: () => c._turns.stopProgressLine(),
            });
            c._turns.progressResponse = {
              id: 'progress',
              generating: true,
              playing: true,
            };
            const send = c.dc.send;
            c.dc.send = (raw) => {
              send(raw);
              if (JSON.parse(raw).type === 'response.cancel') successor();
            };
          } else if (seam === 'debug-send') {
            c._diagnostics.debugSink = (entry) => {
              if (entry.event === 'client.user_text') successor();
            };
            // Debug sinks receive a named envelope through the actual diagnostics owner.
          } else if (
            ['interruption', 'state', 'response-start'].includes(seam)
          ) {
            c.emit = (event) => {
              if (event.type === seam) successor();
            };
          } else if (seam === 'playback') {
            const clear = c.audio.clearPlayback.bind(c.audio);
            c.audio.clearPlayback = () => {
              clear();
              successor();
            };
          } else if (seam === 'transport') {
            const channel = f ? c.dc : h.sockets[0];
            const send = channel.send.bind(channel);
            channel.send = (raw) => {
              send(raw);
              const e = JSON.parse(raw);
              if (
                f
                  ? e.item?.role === 'user'
                  : e.clientContent?.turnComplete === true
              )
                successor();
            };
          } else {
            (f
              ? c._turns.turnResourceAbort
              : c.turnAbort
            ).signal.addEventListener('abort', successor, { once: true });
          }
          const before = f ? f.sent.length : h.sockets[0].sent.length;
          armed = true;
          c.sendTextCommand('older typed request');
          assert.equal(fired, true);
          const sent = (f ? f.sent : h.sockets[0].sent).slice(before);
          const texts = f
            ? sent
                .filter((e) => e.item?.role === 'user')
                .map((e) => e.item.content[0].text)
            : sent
                .filter((e) => e.clientContent?.turnComplete === true)
                .flatMap((e) =>
                  e.clientContent.turns.flatMap((t) =>
                    t.parts.filter((p) => p.text).map((p) => p.text),
                  ),
                );
          if (!['transport', 'response-start'].includes(seam))
            assert.equal(
              texts.includes('older typed request'),
              false,
              'older invocation must not submit after callback',
            );
          if (action === 'stop') {
            assert.equal(c.status, 'idle');
            if (!f) {
              assert.equal(c.isActive(), false);
              assert.equal(c.readTypedTurnInput(), undefined);
            }
          } else {
            if (f) {
              const seed = f.creates()[0];
              await created(f, 'seed', seed.response.metadata);
              await done(f, 'seed');
              if (seam === 'narration')
                await f.emit({
                  type: 'response.done',
                  response: {
                    id: 'progress',
                    metadata: { gev: 'progress' },
                    status: 'cancelled',
                    output: [],
                  },
                });
              const next = f.creates().at(-1);
              await created(f, 'newer', next.response.metadata);
              await f.tool('newer', 'newer-tool');
              assert.equal(f.calls.at(-1)?.text, 'newer typed successor');
              if (seam === 'metrics')
                assert.equal(
                  c._metrics.sequence,
                  2,
                  'outer metrics cannot open over newer span',
                );
            } else {
              assert.equal(
                readVoiceUserTurnText(c.readTypedTurnInput()),
                'newer typed successor',
              );
              // The real old boundary precedes the successor tool when retirement is pending.
              h.sockets[0].message({ serverContent: { turnComplete: true } });
              if (c.retiredReplyPending)
                h.sockets[0].message({ serverContent: { turnComplete: true } });
              tool(h.sockets[0], 'b1-newer-tool');
              await c.toolQueue;
              assert.equal(
                readVoiceUserTurnText(h.calls.at(-1)?.options.userTurn),
                'newer typed successor',
              );
            }
          }
        } finally {
          if (f) {
            c.stop();
            f.close();
          } else {
            c.stop();
            assert.equal(h.timers.size, 0);
          }
        }
      });
    }
  }
}

for (const onset of ['automatic', 'PTT']) {
  for (const action of ['newer', 'stop']) {
    test(`Gemini ${onset} callback cannot continue over ${action} and can recover`, async () => {
      let armed = false;
      let fired = false;
      let h;
      h = harness({
        emit(event) {
          if (armed && !fired && event.type === 'user-turn-start') {
            fired = true;
            if (action === 'stop') h.c.stop();
            else h.c.sendTextCommand('newer typed successor');
          }
        },
      });
      try {
        await h.c.start({ pushToTalk: onset === 'PTT' });
        armed = true;
        if (onset === 'PTT') h.c.input.setMicrophoneEnabled(true);
        else activity(h.sockets[0], 'ACTIVITY_START');
        assert.equal(fired, true);
        if (action === 'stop') {
          assert.equal(h.c.status, 'idle');
          assert.equal(h.c.readTypedTurnInput(), undefined);
          assert.equal(h.timers.size, 0);
          await h.c.start({ pushToTalk: true });
          assert.equal(
            h.sockets.length,
            2,
            'fresh startup is not stranded active',
          );
          h.c.sendTextCommand('fresh recovery');
          assert.equal(
            readVoiceUserTurnText(h.c.readTypedTurnInput()),
            'fresh recovery',
          );
        } else {
          assert.equal(
            readVoiceUserTurnText(h.c.readTypedTurnInput()),
            'newer typed successor',
          );
          tool(h.sockets[0], 'onset-successor');
          await h.c.toolQueue;
          assert.equal(
            readVoiceUserTurnText(h.calls.at(-1)?.options.userTurn),
            'newer typed successor',
          );
        }
      } finally {
        h.c.stop();
        assert.equal(h.timers.size, 0);
      }
    });
  }
}

for (const provider of ['OpenAI', 'Gemini']) {
  test(`${provider} actual pending runner abort preserves a nested typed successor`, async () => {
    let release;
    let entered;
    const began = new Promise((resolve) => {
      entered = resolve;
    });
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let c;
    let oldSignal;
    const calls = [];
    const run = async (name, args, options) => {
      const text = readVoiceUserTurnText(options.userTurn);
      calls.push({ text, signal: options.signal, current: options.isCurrent });
      if (text === 'seed request') {
        oldSignal = options.signal;
        oldSignal.addEventListener(
          'abort',
          () => c.sendTextCommand('newer typed successor'),
          { once: true },
        );
        entered();
        return pending;
      }
      return { ok: true };
    };
    const f = provider === 'OpenAI' ? openai() : null;
    const h = f ? null : harness({ runAction: run });
    c = f ? f.c : h.c;
    let job;
    try {
      if (f) c.runner = withToolCatalog(run, async () => ({ get: () => null }));
      else await c.start({ pushToTalk: true });
      c.sendTextCommand('seed request');
      if (f) {
        await created(f, 'seed', f.creates()[0].response.metadata);
        job = f.tool('seed', 'old-tool');
      } else {
        tool(h.sockets[0], 'old-tool');
        job = c.toolQueue;
      }
      await began;
      c.sendTextCommand('older typed request');
      assert.equal(oldSignal.aborted, true);
      release({ ok: true });
      await job;
      if (f) {
        await done(f, 'seed');
        const req = f.creates().at(-1);
        await created(f, 'newer', req.response.metadata);
        await f.tool('newer', 'newer-tool');
      } else {
        h.sockets[0].message({ serverContent: { turnComplete: true } });
        if (c.retiredReplyPending)
          h.sockets[0].message({ serverContent: { turnComplete: true } });
        tool(h.sockets[0], 'newer-tool');
        await c.toolQueue;
      }
      assert.equal(calls.at(-1).text, 'newer typed successor');
      assert.equal(calls.at(-1).signal.aborted, false);
      assert.equal(calls.at(-1).current(), true);
    } finally {
      release?.({ ok: true });
      c.stop();
      if (f) f.close();
      else assert.equal(h.timers.size, 0);
    }
  });
}

for (const provider of ['OpenAI']) {
  for (const seam of ['boundary', 'token', 'abort', 'pointer']) {
    test(`${provider} newer actual speech supersedes typed entry at ${seam}`, async () => {
      let armed = false;
      let fired = false;
      const f = provider === 'OpenAI' ? openai() : null;
      const h = f ? null : harness();
      const c = f ? f.c : h.c;
      const successor = () => {
        if (!armed || fired) return;
        fired = true;
        if (f) {
          void speech(f, 'new-mic');
          void committed(f, 'new-mic');
          void transcript(f, 'new-mic', 'zoom out');
        } else activity(h.sockets[0], 'ACTIVITY_START');
      };
      try {
        if (h) await c.start();
        c.sendTextCommand('seed request');
        if (seam === 'boundary' || seam === 'pointer') {
          const eventType = seam === 'boundary' ? 'user-turn-start' : 'pointer';
          const observer = (e) => {
            if (e.type === eventType) successor();
          };
          if (f) c.onSessionEvent = observer;
          else c.emit = observer;
          if (seam === 'pointer')
            c.pointer = { beginTurn: () => null, clear() {} };
        } else if (seam === 'token') {
          if (f) {
            c._turns.userTurnIntent.expectResponse();
            c._turns.userTurnIntent.bindResponse('seed-token');
          }
          const t = f
            ? c._turns.userTurnIntent.forResponse('seed-token')
            : c.readTypedTurnInput();
          subscribeVoiceUserTurn(t, () => {
            if (readVoiceUserTurnText(t) === undefined) successor();
          });
        } else
          (f
            ? c._turns.turnResourceAbort
            : c.turnAbort
          ).signal.addEventListener('abort', successor, { once: true });
        const before = f ? f.sent.length : h.sockets[0].sent.length;
        armed = true;
        c.sendTextCommand('older typed request');
        assert.equal(fired, true);
        const added = (f ? f.sent : h.sockets[0].sent).slice(before);
        assert.equal(
          JSON.stringify(added).includes('older typed request'),
          false,
        );
        if (f) {
          await done(f, 'seed');
          await created(f, 'spoken-response');
          await f.tool('spoken-response', 'spoken-tool');
          assert.equal(f.calls.at(-1)?.text, 'zoom out');
          assert.equal(f.calls.at(-1)?.provenance.inputKind, 'speech');
        } else {
          activity(h.sockets[0], 'ACTIVITY_END');
          h.sockets[0].message({ serverContent: { turnComplete: true } });
          tool(h.sockets[0], 'spoken-tool');
          await c.toolQueue;
          assert.equal(c.readTypedTurnInput(), undefined);
          assert.equal(
            h.calls.at(-1)?.options.userTurn,
            undefined,
            'native captions do not mint typed authority',
          );
          assert.equal(h.calls.length, 1);
        }
      } finally {
        c.stop();
        if (f) f.close();
        else assert.equal(h.timers.size, 0);
      }
    });
  }
}

for (const seam of ['boundary', 'token', 'abort', 'pointer']) {
  test(`Gemini first-party PTT admission supersedes typed entry at ${seam}`, async () => {
    let armed = false,
      fired = false;
    const h = harness();
    const c = h.c;
    const successor = () => {
      if (!armed || fired) return;
      fired = true;
      c.input.setMicrophoneEnabled(true);
    };
    try {
      await c.start({ pushToTalk: true });
      c.sendTextCommand('seed request');
      if (seam === 'boundary' || seam === 'pointer') {
        c.emit = (event) => {
          if (
            event.type === (seam === 'boundary' ? 'user-turn-start' : 'pointer')
          )
            successor();
        };
        if (seam === 'pointer')
          c.pointer = { beginTurn: () => null, clear() {} };
      } else if (seam === 'token') {
        const t = c.readTypedTurnInput();
        subscribeVoiceUserTurn(t, () => {
          if (readVoiceUserTurnText(t) === undefined) successor();
        });
      } else
        c.turnAbort.signal.addEventListener('abort', successor, { once: true });
      const before = h.sockets[0].sent.length;
      armed = true;
      c.sendTextCommand('older typed request');
      assert.equal(fired, true);
      assert.equal(
        JSON.stringify(h.sockets[0].sent.slice(before)).includes(
          'older typed request',
        ),
        false,
      );
      assert.equal(c.readTypedTurnInput(), undefined);
      c.input.setMicrophoneEnabled(false);
      h.sockets[0].message({ serverContent: { turnComplete: true } });
      tool(h.sockets[0], 'ptt-new-tool');
      await c.toolQueue;
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].options.userTurn, undefined);
    } finally {
      c.stop();
      assert.equal(h.timers.size, 0);
    }
  });
}
for (const seam of ['boundary', 'token', 'abort', 'pointer']) {
  test(`Gemini unattributed activity marker preserves existing retired typed policy at ${seam}`, async () => {
    let armed = false,
      fired = false;
    const h = harness();
    const c = h.c;
    const marker = () => {
      if (!armed || fired) return;
      fired = true;
      activity(h.sockets[0], 'ACTIVITY_START');
    };
    try {
      await c.start();
      c.sendTextCommand('seed request');
      if (seam === 'boundary' || seam === 'pointer') {
        c.emit = (e) => {
          if (e.type === (seam === 'boundary' ? 'user-turn-start' : 'pointer'))
            marker();
        };
        if (seam === 'pointer')
          c.pointer = { beginTurn: () => null, clear() {} };
      } else if (seam === 'token') {
        const t = c.readTypedTurnInput();
        subscribeVoiceUserTurn(t, () => {
          if (readVoiceUserTurnText(t) === undefined) marker();
        });
      } else
        c.turnAbort.signal.addEventListener('abort', marker, { once: true });
      armed = true;
      c.sendTextCommand('older typed request');
      assert.equal(fired, true);
      assert.equal(
        readVoiceUserTurnText(c.readTypedTurnInput()),
        'older typed request',
        'untagged activity does not prove successor ownership during retirement',
      );
      h.sockets[0].message({ serverContent: { turnComplete: true } });
      tool(h.sockets[0], 'preserved-policy');
      await c.toolQueue;
      assert.equal(
        readVoiceUserTurnText(h.calls[0]?.options.userTurn),
        'older typed request',
      );
    } finally {
      c.stop();
      assert.equal(h.timers.size, 0);
    }
  });
}

// Final B1 consolidation: enclosing owners must honor rejected continuations.
for (const action of ['stop', 'newer']) {
  test(`B1 consolidation Gemini interrupted wrapper preserves ${action}`, async () => {
    let h;
    let armed = false;
    h = harness({
      emit(event) {
        if (armed && event.type === 'user-turn-start') {
          armed = false;
          if (action === 'stop') h.c.stop();
          else h.c.sendTextCommand('newer callback text');
        }
      },
    });
    try {
      await h.c.start({ pushToTalk: true });
      armed = true;
      h.sockets[0].message({ serverContent: { interrupted: true } });
      if (action === 'stop') {
        assert.equal(h.c.status, 'idle');
        assert.equal(h.timers.size, 0);
        assert.equal(h.c.retiredReplyPending, false);
        h.advance(5001);
        assert.equal(h.c.status, 'idle');
      } else {
        assert.equal(h.c.retiredReplyPending, false);
        tool(h.sockets[0], 'wrapper-successor');
        await h.c.toolQueue;
        assert.equal(
          readVoiceUserTurnText(h.calls.at(-1)?.options.userTurn),
          'newer callback text',
        );
      }
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });
}
for (const seam of ['token', 'interruption', 'narration']) {
  for (const action of ['stop', 'newer']) {
    test(`B1 consolidation OpenAI barge ${seam} preserves ${action}`, async () => {
      const f = openai(),
        c = f.c;
      let armed = false;
      let card = initialVoiceCardState();
      const observed = [];
      const react = () => {
        if (!armed) return;
        armed = false;
        if (action === 'stop') c.stop();
        else c.sendTextCommand('newer callback text');
      };
      c.onSessionEvent = (e) => {
        observed.push(e);
        card = reduceVoiceCard(card, e);
        if (seam === 'interruption' && e.type === 'interruption') react();
      };
      try {
        c.sendTextCommand('seed request');
        await created(f, 'seed', f.creates()[0].response.metadata);
        c.assistantAudioPlaying = true;
        if (seam === 'token') {
          const t = c._turns.userTurnIntent.forResponse('seed');
          subscribeVoiceUserTurn(t, () => {
            if (readVoiceUserTurnText(t) === undefined) react();
          });
        }
        if (seam === 'narration')
          c._turns.narration = createNarrationScheduler({ stop: react });
        armed = true;
        c._turns.bargeIn();
        if (action === 'stop') {
          assert.equal(c.status, 'idle');
          assert.equal(
            card.visible,
            false,
            'stale barge event cannot reopen stopped card',
          );
          const idle = observed.findLastIndex(
            (e) => e.type === 'state' && e.state === 'idle',
          );
          assert.ok(idle >= 0);
          assert.equal(observed.length, idle + 1, 'no late event after Stop');
        } else {
          await done(f, 'seed');
          const req = f.creates().at(-1);
          await created(f, 'newer', req.response.metadata);
          await f.tool('newer', 'barge-successor');
          assert.equal(f.calls.at(-1)?.text, 'newer callback text');
        }
      } finally {
        c.stop();
        f.close();
      }
    });
  }
}
for (const successor of ['none', 'reservation', 'pending', 'preflight']) {
  test(`B1 consolidation Radio old cleanup preserves successor ${successor}`, async () => {
    const f = openai(),
      c = f.c;
    let release, entered;
    const gate = new Promise((resolve) => {
        release = resolve;
      }),
      began = new Promise((resolve) => {
        entered = resolve;
      });
    const pendingPlays = [];
    const stopCalls = [];
    let activeAttempt = null;
    let newToken, newResult, newAttempt;
    c.radioLayer = {
      setVoiceDucked() {},
      playForVoice({ attemptId }) {
        activeAttempt = attemptId;
        return new Promise((resolve) => pendingPlays.push(resolve));
      },
      stopPlayback(event) {
        stopCalls.push(event);
        if (event.attemptId === activeAttempt) activeAttempt = null;
      },
    };
    c.runner = withToolCatalog(
      async (name, args, options) => {
        options.signal.addEventListener(
          'abort',
          () => {
            if (successor === 'none') return;
            c.sendTextCommand('newer callback text');
            if (successor === 'reservation')
              newToken = c.reserveRadioToolHandoff({ abortScope: 'playback' });
            else {
              newResult = {
                ok: true,
                action: 'control_radio',
                radioAction: 'play',
                radioPlaybackRequested: true,
              };
              c.pendingRadioPlaybackResult = newResult;
              if (successor === 'preflight') {
                void c.startPendingRadioHandoff();
                newAttempt = c.radioHandoffAttemptId;
              }
            }
          },
          { once: true },
        );
        entered();
        return gate;
      },
      async () => ({ get: () => null }),
    );
    let job;
    try {
      c.sendTextCommand('seed request');
      await created(f, 'seed', f.creates()[0].response.metadata);
      job = f.tool('seed', 'radio-old-tool');
      await began;
      c.pendingRadioPlaybackResult = {
        ok: true,
        action: 'control_radio',
        radioAction: 'play',
        radioPlaybackRequested: true,
      };
      void c.startPendingRadioHandoff();
      const oldAttempt = c.radioHandoffAttemptId;
      assert.ok(oldAttempt);
      c.sendTextCommand('older outer text');
      assert.equal(
        stopCalls.some((e) => e.attemptId === oldAttempt),
        true,
        'old owned attempt is still cleaned up',
      );
      if (successor === 'none') {
        assert.equal(c.radioHandoffInFlight, false);
        assert.equal(c.pendingRadioPlaybackResult, null);
      }
      if (successor === 'reservation')
        assert.equal(c._radio.radioToolHandoffReservations.has(newToken), true);
      if (successor === 'pending')
        assert.equal(c.pendingRadioPlaybackResult, newResult);
      if (successor === 'preflight') {
        assert.ok(newAttempt);
        assert.equal(c.radioHandoffAttemptId, newAttempt);
        assert.equal(c.radioHandoffInFlight, true);
        assert.equal(activeAttempt, newAttempt);
        assert.equal(
          stopCalls.some((e) => e.attemptId === newAttempt),
          false,
        );
      }
      release({ ok: true });
      await job;
    } finally {
      release?.({ ok: true });
      for (const resolve of pendingPlays) resolve(true);
      await job;
      c.stop();
      f.close();
    }
  });
}
