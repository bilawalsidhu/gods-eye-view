// Native provider policy, retirement recovery, and playback ownership regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './geminiNativeHarness.mjs';

{
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
  const speak = (ws) =>
    ws.message({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
          ],
        },
      },
    });

  // R2-1: RealtimeInput reads mayClaimSpeaker() and deliberately skips bargeIn()
  // while a prepared Radio handoff owns the speaker. Revoking typed ownership on
  // that PTT capture must not perform the barge-in playback cut it declined.
  test('R2-1 PTT revocation under Radio speaker ownership keeps confirmation playback', async () => {
    const h = harness();
    try {
      await h.c.start({ pushToTalk: true });
      const ws = h.sockets[0];
      assert.equal(h.c.sendTextCommand('Play the radio'), true);
      speak(ws);
      ws.message({ serverContent: { turnComplete: true } });
      // Confirmation audio is still draining locally with a prepared handoff.
      h.c.radio.pendingRadioPlaybackResult = { ok: true };
      assert.equal(h.c.audio.pending, true);
      assert.equal(h.c.radio.mayVoiceClaimSpeaker(), false);
      assert.ok(h.c.readTypedTurnInput());
      h.c.audio.cleared = false; // the typed submission's own interrupt set it
      h.c.input.setMicrophoneEnabled(true);
      assert.equal(
        h.c.readTypedTurnInput(),
        undefined,
        'fresh PTT capture still revokes typed ownership',
      );
      assert.notEqual(
        h.c.audio.cleared,
        true,
        'declined barge-in must not clear speaker playback',
      );
      assert.equal(h.c.audio.pending, true);
      // Pre-existing behavior: microphone activation cancels the prepared handoff.
      assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
      h.c.input.setMicrophoneEnabled(false);
      tool(ws, 'next-spoken-zoom');
      await h.c.toolQueue;
      assert.equal(h.calls.length, 1, 'next PTT command recovers');
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  // Control: a claimed barge-in still cuts playback exactly as before the patch.
  test('R2-1 control: claimed PTT barge-in still clears playback', async () => {
    const h = harness();
    try {
      await h.c.start({ pushToTalk: true });
      const ws = h.sockets[0];
      assert.equal(h.c.sendTextCommand('Zoom in'), true);
      speak(ws);
      assert.equal(h.c.radio.mayVoiceClaimSpeaker(), true);
      assert.equal(h.c.bargeIn(), true);
      assert.equal(h.c.audio.cleared, true);
      assert.equal(h.c.readTypedTurnInput(), undefined);
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  // R2-1 protection: keeping playback must not let the protected typed reply's
  // still-arriving tools run unrestricted after revocation.
  test('R2-1 revocation without playback cut still retires the protected reply tools', async () => {
    const h = harness({ providerDropdown: () => true });
    try {
      await h.c.start({ pushToTalk: true });
      const ws = h.sockets[0];
      assert.equal(
        h.c.sendTextCommand('Switch voice provider to OpenAI'),
        true,
      );
      speak(ws); // protected reply still generating
      h.c.radio.pendingRadioPlaybackResult = { ok: true };
      h.c.audio.cleared = false;
      h.c.input.setMicrophoneEnabled(true);
      assert.notEqual(h.c.audio.cleared, true);
      tool(ws, 'old-reply-tool');
      await h.c.toolQueue;
      assert.equal(
        h.calls.length,
        0,
        'old reply tool is retired, not run unrestricted',
      );
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });
}

{
  const speak = {
    serverContent: {
      modelTurn: {
        parts: [
          { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
        ],
      },
    },
  };
  const zoom = (id) => ({
    id,
    name: 'adjust_camera_zoom',
    args: { direction: 'in', amount: 'little' },
  });
  const panel = (id) => ({
    id,
    name: 'set_panel_open',
    args: { panelId: 'radio-panel', open: true },
  });
  const setter = (id) => ({
    id,
    name: 'set_voice_provider',
    args: { provider: 'openai' },
  });
  const tools = (ws, ...functionCalls) =>
    ws.message({ toolCall: { functionCalls } });
  const responses = (ws) =>
    ws.sent.flatMap((m) => m.toolResponse?.functionResponses || []);
  const onset = (ws) => {
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
  };

  test('R3 P2-A: a silent first retirement fails within the input boundary bound', async () => {
    const h = harness();
    try {
      await h.c.start();
      h.sockets[0].message(speak);
      assert.equal(h.c.sendTextCommand('Zoom in'), true);
      assert.equal(h.c.retiredReplyPending, true);
      h.advance(4999);
      assert.equal(h.c.isActive(), true);
      h.advance(2);
      assert.equal(h.c.isActive(), false);
      assert.equal(h.c.status, 'error');
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('R3 P2-A: retired output keeps a long old reply alive until its boundary', async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message(speak);
      assert.equal(h.c.sendTextCommand('Zoom in'), true);
      for (let i = 0; i < 4; i++) {
        h.advance(4000);
        ws.message(speak); // still the retired reply
      }
      ws.message({ serverContent: { generationComplete: true } });
      h.advance(4500); // observed live natural turnComplete lag
      assert.equal(h.c.isActive(), true);
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      assert.equal(h.c.retiredReplyPending, false);
      assert.equal(h.c.isActive(), true);
      assert.equal(h.c.retiredBoundaryWait, null);
      tools(ws, zoom('after-boundary'));
      await h.c.toolQueue;
      assert.equal(
        h.calls.length,
        1,
        'typed successor still works after the boundary',
      );
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('R3 P2-A: a server interrupted marker with no outstanding reply is bounded too', async () => {
    const h = harness();
    try {
      await h.c.start();
      h.sockets[0].message({ serverContent: { interrupted: true } });
      assert.equal(h.c.retiredReplyPending, true);
      assert.ok(h.c.retiredBoundaryWait);
      h.advance(5001);
      assert.equal(h.c.status, 'error');
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('R3 policy: a spoken turn whose model calls the setter refuses every sibling and continuation', async () => {
    const h = harness({ providerDropdown: () => true });
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      tools(ws, zoom('z1'), setter('s1'), panel('p1'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 0, 'no tool reaches the runner');
      assert.deepEqual(
        responses(ws).map((r) => [r.id, r.response.providerRequestBlocked]),
        [
          ['z1', true],
          ['s1', true],
          ['p1', true],
        ],
      );
      ws.message({ serverContent: { turnComplete: true } });
      tools(ws, zoom('continuation'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 0, 'same-turn continuation stays refused');
      ws.message({ serverContent: { turnComplete: true } }); // reply to the refusal ends
      onset(ws); // genuine next speech turn
      tools(ws, zoom('next'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 1, 'next spoken turn recovers');
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('R3 policy: an earlier completed ordinary tool is not retroactively affected', async () => {
    const h = harness({ providerDropdown: () => true });
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      tools(ws, zoom('before'));
      await h.c.toolQueue;
      tools(ws, setter('late-setter'), zoom('after'));
      await h.c.toolQueue;
      assert.deepEqual(
        h.calls.map((c) => c.name),
        ['adjust_camera_zoom'],
      );
      assert.equal(
        responses(ws).find((r) => r.id === 'after').response
          .providerRequestBlocked,
        true,
      );
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('R3 policy: Stop/restart and a fresh PTT capture lift the quarantine', async () => {
    const h = harness({ providerDropdown: () => true });
    try {
      await h.c.start({ pushToTalk: true });
      let ws = h.sockets[0];
      tools(ws, setter('s1'));
      await h.c.toolQueue;
      ws.message({ serverContent: { turnComplete: true } });
      assert.equal(h.c.providerQuarantined(), true);
      h.c.radio.pendingRadioPlaybackResult = { ok: true }; // speaker claim denied
      assert.equal(h.c.bargeIn(), false);
      h.c.input.setMicrophoneEnabled(true);
      assert.equal(
        h.c.providerQuarantined(),
        false,
        'fresh PTT capture lifts it',
      );
      h.c.input.setMicrophoneEnabled(false);
      tools(ws, zoom('ptt-next'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 1);
      tools(ws, setter('s2'));
      await h.c.toolQueue;
      h.c.stop();
      await h.c.start();
      ws = h.sockets.at(-1);
      assert.equal(h.c.providerQuarantined(), false);
      tools(ws, zoom('after-restart'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 2);
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('R3 policy: ordinary spoken tools without a setter call run promptly', async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      tools(ws, zoom('z'), panel('p'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 2);
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });
}

{
  const setter = (id) => ({
    id,
    name: 'set_voice_provider',
    args: { provider: 'openai' },
  });
  const zoom = (id) => ({
    id,
    name: 'adjust_camera_zoom',
    args: { direction: 'in', amount: 'little' },
  });
  const tools = (ws, ...calls) =>
    ws.message({ toolCall: { functionCalls: calls } });
  const complete = (ws) =>
    ws.message({ serverContent: { turnComplete: true } });
  const onset = (ws) => {
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
  };
  for (const variant of [
    'duplicate-prior-turn',
    'missing-id',
    'duplicate-current-batch',
  ]) {
    test(`quarantine validates call identity before mutation: ${variant}`, async () => {
      const h = harness({ providerDropdown: () => true });
      try {
        await h.c.start();
        const ws = h.sockets[0];
        onset(ws);
        if (variant === 'duplicate-prior-turn') {
          tools(ws, setter('old'));
          await h.c.toolQueue;
          complete(ws);
          onset(ws);
          tools(ws, setter('old'), zoom('fresh'));
        } else if (variant === 'missing-id')
          tools(ws, setter(undefined), zoom('fresh'));
        else tools(ws, zoom('same-id'), setter('same-id'));
        await h.c.toolQueue;
        assert.deepEqual(
          h.calls.map((c) => c.name),
          ['adjust_camera_zoom'],
        );
        assert.equal(h.c.providerQuarantined(), false);
      } finally {
        h.c.stop();
        assert.equal(h.timers.size, 0);
      }
    });
  }
  test('fresh setter still quarantines earlier and later batch siblings', async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      tools(ws, zoom('before'), setter('fresh'), zoom('after'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 0);
      assert.equal(h.c.providerQuarantined(), true);
      assert.equal(
        ws.sent
          .flatMap((x) => x.toolResponse?.functionResponses || [])
          .filter((x) => x.response.providerRequestBlocked).length,
        3,
      );
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });
}

test('retirement timers call injected scheduler functions without a controller receiver', () => {
  let next = 0;
  const pending = new Map();
  const h = harness({
    setTimer: function (fn, ms) {
      assert.equal(
        this,
        undefined,
        'browser timer functions must not receive the controller as this',
      );
      const id = ++next;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: function (id) {
      assert.equal(
        this,
        undefined,
        'browser clearTimeout must not receive the controller as this',
      );
      pending.delete(id);
    },
  });
  try {
    h.c.retiredReplyPending = true;
    h.c.boundRetiredReply();
    assert.equal(pending.size, 1);
    assert.equal(pending.get(h.c.retiredBoundaryWait.timer).ms, 5000);
    h.c.clearRetiredBoundaryWait();
    assert.equal(pending.size, 0);
    assert.equal(h.c.retiredBoundaryWait, null);
  } finally {
    h.c.stop();
  }
});

// A Live socket has no response ID to rescue forgotten call ownership. Exercise
// validation and the lifetime budget through its actual JSON message boundary.
{
  const invalidIds = [
    ['object', {}],
    ['number', 42],
    ['array', ['call']],
    ['empty', ''],
    ['whitespace', '   '],
    ['NUL', 'call\u0000id'],
    ['newline', 'call\nid'],
    ['DEL', 'call\u007fid'],
    ['oversize', 'x'.repeat(1025)],
  ];
  const setter = (id) => ({
    id,
    name: 'set_voice_provider',
    args: { provider: 'openai' },
  });
  const zoom = (id) => ({
    id,
    name: 'adjust_camera_zoom',
    args: { direction: 'in', amount: 'little' },
  });
  const tools = (ws, ...functionCalls) =>
    ws.message({ toolCall: { functionCalls } });
  const complete = (ws) =>
    ws.message({ serverContent: { turnComplete: true } });
  const onset = (ws) => {
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
  };
  const responses = (ws) =>
    ws.sent.flatMap((message) => message.toolResponse?.functionResponses || []);
  const assertRestartRequired = (h, ws) => {
    assert.equal(h.c.status, 'error');
    assert.match(h.events.at(-1).detail, /start voice again|restart/i);
    assert.equal(ws.closed, true);
    assert.equal(h.tracks[0].readyState, 'ended');
    assert.equal(h.captures[0].closed, true);
    assert.equal(h.c.pendingTools, 0);
    assert.equal(h.timers.size, 0);
  };
  const retireReply = (h, ws) => {
    ws.message({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
          ],
        },
      },
    });
    assert.equal(h.c.bargeIn(), true);
    assert.equal(h.c.retiredReplyPending, true);
  };

  for (const [label, id] of invalidIds) {
    test(`native call identity rejects ${label} setter before valid sibling policy`, async () => {
      const h = harness();
      try {
        await h.c.start();
        const ws = h.sockets[0];
        onset(ws);
        tools(ws, setter(id), zoom('valid-sibling'));
        await h.c.toolQueue;
        assert.deepEqual(
          h.calls.map((call) => call.name),
          ['adjust_camera_zoom'],
        );
        assert.equal(h.c.providerQuarantined(), false);
        assert.deepEqual(
          responses(ws).map((call) => call.id),
          ['valid-sibling'],
        );
      } finally {
        h.c.stop();
        assert.equal(h.timers.size, 0);
      }
    });
  }

  test('native call identity preserves opaque strings exactly and accepts the 1024-character boundary', async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      const ids = [
        'Opaque:/+@= ID',
        ' Opaque:/+@= ID ',
        'opaque:/+@= ID',
        'x'.repeat(1024),
      ];
      tools(ws, ...ids.map(zoom));
      await h.c.toolQueue;
      tools(ws, ...ids.map(setter));
      await h.c.toolQueue;
      assert.equal(h.calls.length, ids.length);
      assert.deepEqual(
        responses(ws).map((call) => call.id),
        ids,
      );
      assert.equal(
        h.c.providerQuarantined(),
        false,
        'exact duplicate IDs cannot acquire new setter authority',
      );
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('native accepted-call budget retains old setter identity and requires explicit fresh-session recovery', async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      const retainedOldMessage = ws.onmessage;
      onset(ws);
      tools(ws, setter('original-setter'));
      await h.c.toolQueue;
      complete(ws);
      onset(ws);
      for (let index = 0; index < 255; index++) {
        tools(ws, zoom(`accepted-${index}`));
        await h.c.toolQueue;
      }
      complete(ws);
      onset(ws);
      const callsAtCapacity = h.calls.length;
      const outputsAtCapacity = responses(ws).length;
      tools(
        ws,
        setter('original-setter'),
        ...invalidIds.map(([, id]) => setter(id)),
      );
      await h.c.toolQueue;
      assert.equal(
        h.c.status,
        'listening',
        'duplicates and malformed IDs consume no new slots',
      );
      assert.equal(h.c.providerQuarantined(), false);
      assert.equal(h.calls.length, callsAtCapacity);
      assert.equal(responses(ws).length, outputsAtCapacity);
      tools(ws, zoom('new-call-257'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, callsAtCapacity);
      assertRestartRequired(h, ws);

      await h.c.start();
      const replacement = h.sockets[1];
      assert.equal(
        h.requests.length,
        2,
        'explicit restart requests fresh provisioning',
      );
      retainedOldMessage({
        data: JSON.stringify({
          toolCall: { functionCalls: [setter('original-setter')] },
        }),
      });
      tools(replacement, zoom('original-setter'));
      await h.c.toolQueue;
      assert.equal(h.c.status, 'listening');
      assert.equal(h.c.providerQuarantined(), false);
      assert.equal(
        h.calls.length,
        callsAtCapacity + 1,
        'fresh session resets the call budget without accepting old-socket events',
      );
      assert.deepEqual(
        responses(replacement).map((call) => call.id),
        ['original-setter'],
      );
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('native cancelled-call budget never forgets old cancellation to admit replay', async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      for (let index = 0; index < 256; index++) {
        const id = index === 0 ? 'cancelled-original' : `cancelled-${index}`;
        tools(ws, zoom(id));
        ws.message({ toolCallCancellation: { ids: [id] } });
        await h.c.toolQueue;
      }
      complete(ws);
      onset(ws);
      ws.message({
        toolCallCancellation: {
          ids: Array.from({ length: 256 }, (_, index) => `unknown-${index}`),
        },
      });
      tools(ws, setter('cancelled-original'));
      await h.c.toolQueue;
      assert.equal(h.c.providerQuarantined(), false);
      assert.equal(h.c.status, 'listening');
      assert.equal(h.calls.length, 0);
      tools(ws, zoom('new-after-cancellations'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 0);
      assertRestartRequired(h, ws);
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('native retired reply rejects malformed identities without poisoning the valid successor', async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      retireReply(h, ws);
      tools(ws, ...invalidIds.map(([, id]) => setter(id)));
      complete(ws);
      tools(ws, zoom('valid-after-retirement'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 1);
      assert.equal(h.c.providerQuarantined(), false);
      assert.deepEqual(
        responses(ws).map((call) => call.id),
        ['valid-after-retirement'],
      );
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  test('native retired reply reserves lifetime tombstones and fails before accepting a 257th identity', async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      retireReply(h, ws);
      for (let index = 0; index < 256; index++)
        tools(ws, zoom(`retired-${index}`));
      tools(ws, setter('retired-0'), ...invalidIds.map(([, id]) => setter(id)));
      assert.equal(
        h.c.isActive(),
        true,
        'invalid and duplicate retired IDs consume no slots',
      );
      assert.equal(h.c.providerQuarantined(), false);
      assert.equal(h.calls.length, 0);
      complete(ws);
      tools(ws, setter('retired-0'));
      await h.c.toolQueue;
      assert.equal(
        h.c.providerQuarantined(),
        false,
        'retired IDs remain inert after the boundary',
      );
      tools(ws, zoom('new-after-retired-budget'));
      await h.c.toolQueue;
      assert.equal(h.calls.length, 0);
      assertRestartRequired(h, ws);
    } finally {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    }
  });

  for (const retired of [false, true]) {
    test(`native ${retired ? 'retired' : 'active'} call-budget overflow batch rejects all new identities atomically`, async () => {
      const h = harness();
      try {
        await h.c.start();
        const ws = h.sockets[0];
        if (retired) retireReply(h, ws);
        else onset(ws);
        for (let index = 0; index < 255; index++) {
          tools(ws, zoom(`before-overflow-${index}`));
          await h.c.toolQueue;
        }
        const callsBefore = h.calls.length;
        const outputsBefore = responses(ws).length;
        tools(ws, zoom('would-fill-last-slot'), setter('would-overflow'));
        await h.c.toolQueue;
        assert.equal(
          h.calls.length,
          callsBefore,
          'no sibling reaches the action runner',
        );
        assert.equal(
          responses(ws).length,
          outputsBefore,
          'no partial refusal or success is published',
        );
        assert.equal(h.c.providerQuarantined(), false);
        assertRestartRequired(h, ws);
      } finally {
        h.c.stop();
        assert.equal(h.timers.size, 0);
      }
    });
  }
}

// Viewport images use the injected session clock, so tests and paused clocks
// govern the one-per-second bound instead of host wall time.
test('viewport images are throttled on the injected session clock', async () => {
  const h = harness({
    runAction: async () => ({
      ok: true,
      action: 'get_entity_context',
      scene: { basemap: { viewScale: 'local' } },
    }),
    captureViewport: async () => 'data:image/jpeg;base64,aW1hZ2U=',
  });
  try {
    await h.c.start();
    const ws = h.sockets[0];
    const images = () =>
      ws.sent.filter((entry) => entry.realtimeInput?.video).length;
    const ask = (...ids) =>
      ws.message({
        toolCall: {
          functionCalls: ids.map((id) => ({
            id,
            name: 'get_entity_context',
            args: {},
          })),
        },
      });
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    ask('first', 'same-second');
    await h.c.toolQueue;
    assert.equal(images(), 1, 'a second image within one second is skipped');
    h.advance(1000);
    ask('next-second');
    await h.c.toolQueue;
    assert.equal(images(), 2, 'the injected clock reopens the bound');
  } finally {
    h.c.stop();
  }
});
