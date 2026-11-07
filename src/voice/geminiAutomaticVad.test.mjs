// Native automatic activity, reply ownership and expiry lifecycle regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harness,
  tick,
  deferred,
} from '../testSupport/geminiNativeHarness.mjs';
const vad = (ws, type) => ws.message({ voiceActivity: { type } });
const onset = (ws) => {
  vad(ws, 'ACTIVITY_START');
  vad(ws, 'ACTIVITY_END');
};
const split = (ws) => {
  onset(ws);
  onset(ws);
};
const audio = {
  serverContent: {
    modelTurn: {
      parts: [
        { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
      ],
    },
  },
};
const done = (ws) => ws.message({ serverContent: { turnComplete: true } });
const tools = (ws, id) =>
  ws.message({
    toolCall: {
      functionCalls: [
        {
          id,
          name: 'adjust_camera_zoom',
          args: { direction: 'out', amount: 'little' },
        },
      ],
    },
  });
const responses = (ws) =>
  ws.sent.flatMap((m) => m.toolResponse?.functionResponses || []);
function close(h) {
  h.c.stop();
  assert.equal(h.timers.size, 0, 'owned timers released');
}
test('N1 VAD-only split admits the first real answer and completes after playback', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    split(ws);
    ws.message(audio);
    ws.message({ serverContent: { outputTranscription: { text: 'Answer' } } });
    done(ws);
    assert.equal(h.captures[0].played.length, 1);
    h.captures[0].drain();
    assert.equal(
      h.events.findLast((e) => e.type === 'completion')?.status,
      'completed',
    );
    assert.equal(h.c.retiredReplyPending, false);
  } finally {
    close(h);
  }
});
test('N2 VAD-only split does not arm a nonexistent reply timeout', async () => {
  const h = harness();
  try {
    await h.c.start();
    split(h.sockets[0]);
    h.advance(5001);
    assert.equal(h.c.status, 'listening');
    assert.equal(h.c.retiredReplyPending, false);
    assert.equal(h.c.retiredBoundaryWait, null);
  } finally {
    close(h);
  }
});
test('N3 server interruption before output still fences until ordered turnComplete', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    split(ws);
    ws.message({ serverContent: { interrupted: true } });
    assert.equal(h.c.retiredReplyPending, true);
    ws.message(audio);
    tools(ws, 'retired-before-boundary');
    await h.c.toolQueue;
    assert.equal(h.captures[0].played.length, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(responses(ws).length, 0);
    ws.message({
      serverContent: { ...audio.serverContent, turnComplete: true },
    });
    assert.equal(
      h.captures[0].played.length,
      0,
      'coalesced retired content is discarded',
    );
    ws.message(audio);
    assert.equal(h.captures[0].played.length, 1);
    done(ws);
    h.captures[0].drain();
    assert.equal(
      h.events.findLast((e) => e.type === 'completion')?.status,
      'completed',
    );
  } finally {
    close(h);
  }
});
test('N4 generationComplete is server evidence and next onset retires it', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    ws.message({ serverContent: { generationComplete: true } });
    onset(ws);
    assert.equal(h.c.retiredReplyPending, true);
    assert.ok(h.c.retiredBoundaryWait);
    ws.message(audio);
    tools(ws, 'old-generation');
    await h.c.toolQueue;
    assert.equal(h.captures[0].played.length, 0);
    assert.equal(h.calls.length, 0);
    done(ws);
    assert.equal(h.c.retiredReplyPending, false);
  } finally {
    close(h);
  }
});
test('N5 goAway during VAD-only activity waits for actual reply and playback', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    split(ws);
    ws.message({ goAway: { timeLeft: '30s' } });
    assert.equal(h.c.isActive(), true);
    assert.ok(h.c.goAway);
    assert.equal(ws.closed, undefined);
    h.advance(5001);
    assert.equal(h.c.isActive(), true);
    ws.message(audio);
    done(ws);
    assert.equal(
      h.c.isActive(),
      true,
      'pending actual PCM drains before expiry',
    );
    h.captures[0].drain();
    assert.equal(h.c.status, 'error');
    assert.equal(ws.closed, true);
  } finally {
    close(h);
  }
});
test('N6 first server tool after VAD-only split executes exactly once', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    split(ws);
    tools(ws, 'new-generation');
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.equal(
      responses(ws).filter((x) => x.id === 'new-generation').length,
      1,
    );
    assert.equal(responses(ws).at(-1).response.ok, true);
    tools(ws, 'new-generation');
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.equal(
      responses(ws).filter((x) => x.id === 'new-generation').length,
      1,
    );
  } finally {
    close(h);
  }
});
test('C1 actual old audio followed by onset fences late audio and tool until boundary', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    ws.message(audio);
    onset(ws);
    assert.equal(h.c.retiredReplyPending, true);
    ws.message(audio);
    tools(ws, 'late-old');
    await h.c.toolQueue;
    assert.equal(h.captures[0].played.length, 1);
    assert.equal(h.calls.length, 0);
    ws.message({ serverContent: { interrupted: true } });
    ws.message(audio);
    assert.equal(h.captures[0].played.length, 1);
    done(ws);
    ws.message(audio);
    assert.equal(h.captures[0].played.length, 2);
  } finally {
    close(h);
  }
});
test('C2 first server tool in flight is aborted and never answered after new onset', async () => {
  const gate = deferred(),
    entered = [];
  const h = harness({
    runAction: async (_n, _a, o) => {
      entered.push(o);
      await gate.promise;
      return { ok: true };
    },
  });
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    tools(ws, 'old-running');
    await tick();
    assert.equal(entered.length, 1);
    onset(ws);
    assert.equal(entered[0].signal.aborted, true);
    gate.resolve();
    await h.c.toolQueue;
    assert.equal(responses(ws).filter((x) => x.id === 'old-running').length, 0);
    assert.equal(h.c.retiredReplyPending, true);
  } finally {
    gate.resolve();
    close(h);
  }
});
test('C5 typed request before first server output still retires on next onset', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    assert.equal(h.c.sendTextCommand('Zoom in'), true);
    onset(ws);
    assert.equal(h.c.retiredReplyPending, true);
    ws.message(audio);
    tools(ws, 'late-typed');
    await h.c.toolQueue;
    assert.equal(h.captures[0].played.length, 0);
    assert.equal(h.calls.length, 0);
  } finally {
    close(h);
  }
});
test('N7 old retired boundary preserves the newer automatic owner for goAway', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    const oldOwner = h.c.automaticActivityOwner;
    ws.message(audio);
    onset(ws);
    const successor = h.c.automaticActivityOwner;
    assert.notEqual(successor, oldOwner);
    assert.equal(h.c.retiredAutomaticActivityOwner, oldOwner);
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    assert.equal(h.c.automaticActivityOwner, successor);
    assert.equal(h.c.automaticTurnOpen, true);
    ws.message({ goAway: { timeLeft: '30s' } });
    assert.equal(h.c.isActive(), true);
    ws.message(audio);
    done(ws);
    h.captures[0].drain();
    assert.equal(h.c.status, 'error');
  } finally {
    close(h);
  }
});
test('N8 old automatic owner with no successor is cleared by its retired boundary', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    const owner = h.c.automaticActivityOwner;
    ws.message(audio);
    ws.message({ serverContent: { interrupted: true } });
    assert.equal(h.c.retiredAutomaticActivityOwner, owner);
    done(ws);
    assert.equal(h.c.automaticTurnOpen, false);
    assert.equal(h.c.automaticActivityOwner, null);
    assert.equal(h.c.retiredAutomaticActivityOwner, null);
    ws.message({ goAway: { timeLeft: '30s' } });
    assert.equal(h.c.isActive(), false, 'no invented successor wait');
  } finally {
    close(h);
  }
});
test('N9 coalesced old completion and new VAD preserves the new owner', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    ws.message(audio);
    vad(ws, 'ACTIVITY_END');
    ws.message({
      voiceActivity: { type: 'ACTIVITY_START' },
      serverContent: { interrupted: true, turnComplete: true },
    });
    assert.equal(h.c.automaticTurnOpen, true);
    assert.ok(h.c.automaticActivityOwner);
    assert.equal(h.c.retiredAutomaticActivityOwner, null);
    ws.message({ goAway: { timeLeft: '30s' } });
    assert.equal(h.c.isActive(), true);
  } finally {
    close(h);
  }
});
test('N10 stop, restart and destroy release automatic owner identities and timers', async () => {
  const h = harness();
  try {
    await h.c.start();
    onset(h.sockets[0]);
    const first = h.c.automaticActivityOwner;
    h.c.stop();
    assert.equal(h.c.automaticTurnOpen, false);
    assert.equal(h.c.automaticActivityOwner, null);
    assert.equal(h.c.retiredAutomaticActivityOwner, null);
    assert.equal(h.c.automaticActivitySequence, 0);
    await h.c.start();
    onset(h.sockets[1]);
    assert.notEqual(h.c.automaticActivityOwner, first);
    assert.notEqual(h.c.automaticActivityOwner.epoch, first.epoch);
    h.c.stop({ removeUi: true });
    assert.equal(h.c.disposed, true);
    assert.equal(h.c.automaticTurnOpen, false);
    assert.equal(h.c.automaticActivityOwner, null);
    assert.equal(h.c.retiredAutomaticActivityOwner, null);
    assert.equal(h.timers.size, 0);
  } finally {
    close(h);
  }
});
test('N11 deferred typed ownership counts discarded open-mic PCM without queuing or replay', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    ws.message(audio);
    assert.equal(h.c.sendTextCommand('Zoom in'), true);
    assert.equal(h.c.sendTextCommand('Zoom out'), true);
    assert.equal(h.c.deferredInput.kind, 'user-text');
    const before = ws.sent.filter((x) => x.realtimeInput?.audio).length;
    const metadata = { captureId: h.c.captureOwner.captureId };
    h.captures[0].callbacks.onAudio(
      { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' },
      metadata,
    );
    assert.equal(ws.sent.filter((x) => x.realtimeInput?.audio).length, before);
    assert.equal(
      h.c.deferredInput.messages.some((x) => x.realtimeInput?.audio),
      false,
    );
    assert.equal(h.c.getDiagnostics().droppedAudioChunks, 1);
    assert.deepEqual(h.c.getDiagnostics().deferredAudioDrops, {
      nonPttOwner: 1,
      closedActivity: 0,
    });
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    done(ws);
    assert.equal(
      ws.sent.filter((x) => x.realtimeInput?.audio).length,
      before,
      'no wrong-owner PCM replay after boundaries',
    );
  } finally {
    close(h);
  }
});
test('N12 goAway before old completion still waits for the newer automatic owner', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    ws.message(audio);
    onset(ws);
    const successor = h.c.automaticActivityOwner;
    ws.message({ goAway: { timeLeft: '30s' } });
    assert.equal(h.c.isActive(), true);
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    assert.equal(h.c.automaticActivityOwner, successor);
    assert.equal(
      h.c.isActive(),
      true,
      'old boundary during goAway cannot end successor wait',
    );
    ws.message(audio);
    done(ws);
    h.captures[0].drain();
    assert.equal(h.c.status, 'error');
  } finally {
    close(h);
  }
});
for (const interruptedBeforeExpiry of [false, true])
  test(`N13 no successor clears retired ownership with goAway ${interruptedBeforeExpiry ? 'after interruption' : 'before interruption'}`, async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      ws.message(audio);
      if (interruptedBeforeExpiry)
        ws.message({ serverContent: { interrupted: true } });
      ws.message({ goAway: { timeLeft: '30s' } });
      assert.equal(h.c.isActive(), true);
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      assert.equal(h.c.automaticTurnOpen, false);
      assert.equal(h.c.automaticActivityOwner, null);
      assert.equal(
        h.c.isActive(),
        false,
        'no successor finishes at its actual boundary',
      );
    } finally {
      close(h);
    }
  });
test('N14 native interruption during goAway aborts pending old tool and suppresses late response', async () => {
  const gate = deferred(),
    entered = [];
  const h = harness({
    runAction: async (_n, _a, o) => {
      entered.push(o);
      await gate.promise;
      return { ok: true };
    },
  });
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    tools(ws, 'expiring-old-tool');
    await tick();
    assert.equal(entered.length, 1);
    ws.message({ goAway: { timeLeft: '30s' } });
    assert.equal(h.c.isActive(), true);
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    assert.equal(entered[0].signal.aborted, true);
    gate.resolve();
    await h.c.toolQueue;
    assert.equal(
      responses(ws).filter((x) => x.id === 'expiring-old-tool').length,
      0,
    );
    assert.equal(h.c.isActive(), false);
  } finally {
    gate.resolve();
    close(h);
  }
});
test('N15 goAway still refuses local PTT and typed replacement without reopening microphone', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    ws.message(audio);
    ws.message({ goAway: { timeLeft: '30s' } });
    const turn = h.c.turn,
      sent = ws.sent.length;
    assert.equal(h.c.bargeIn(), false);
    assert.equal(h.c.sendTextCommand('Zoom out'), false);
    h.c.interrupt('push-to-talk');
    assert.equal(h.c.turn, turn);
    assert.equal(ws.sent.length, sent);
    assert.equal(
      h.tracks.every((t) => !t.enabled),
      true,
    );
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    assert.equal(h.c.isActive(), false);
    assert.equal(
      h.tracks.every((t) => t.readyState === 'ended'),
      true,
    );
  } finally {
    close(h);
  }
});

test('T-F1a PTT successor PCM survives retired boundary and a second input fences its late output', async () => {
  const h = harness();
  try {
    await h.c.start({ pushToTalk: true });
    const ws = h.sockets[0],
      a = h.captures[0];
    ws.message(audio);
    h.c.input.pushToTalkKeyHeld = true;
    assert.equal(h.c.input.bargeIn(), true);
    h.c.input.setMicrophoneEnabled(true);
    a.callbacks.onAudio(
      { data: 'AAAB', mimeType: 'audio/pcm;rate=16000' },
      a.metadata,
    );
    h.c.input.setMicrophoneEnabled(false);
    assert.equal(h.c.replyPending, true);
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    assert.equal(
      h.c.replyPending,
      true,
      'old boundary cannot clear submitted successor',
    );
    assert.equal(h.c.sendTextCommand('Zoom out second request'), true);
    assert.ok(h.c.currentTypedInput());
    const played = a.played.length;
    ws.message(audio);
    tools(ws, 'late-ptt-predecessor');
    await h.c.toolQueue;
    assert.equal(a.played.length, played);
    assert.equal(
      h.calls.length,
      0,
      'no old tool under newer local typed input',
    );
    done(ws);
    tools(ws, 'current-typed');
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.userTurn, undefined);
    assert.equal(h.calls[0].options.isCurrent(), true);
    assert.equal(h.c.currentTypedInput().text, 'Zoom out second request');
  } finally {
    close(h);
  }
});
for (const expiryBeforeBoundary of [false, true])
  test(`T-F1b VAD then submitted text survives goAway ${expiryBeforeBoundary ? 'before' : 'after'} retired boundary`, async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message(audio);
      onset(ws);
      assert.equal(h.c.sendTextCommand('Zoom out successor'), true);
      const typed = h.c.currentTypedInput();
      assert.ok(typed);
      assert.equal(h.c.replyPending, true);
      if (expiryBeforeBoundary) ws.message({ goAway: { timeLeft: '30s' } });
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      assert.equal(h.c.replyPending, true);
      if (!expiryBeforeBoundary) ws.message({ goAway: { timeLeft: '30s' } });
      assert.equal(h.c.isActive(), true, 'submitted text must finish');
      tools(ws, 'valid-successor');
      await h.c.toolQueue;
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].options.userTurn, undefined);
      assert.equal(h.calls[0].options.isCurrent(), true);
      assert.equal(h.c.currentTypedInput(), typed);
      ws.message(audio);
      done(ws);
      assert.equal(h.c.isActive(), true);
      h.captures[0].drain();
      assert.equal(h.c.isActive(), false);
    } finally {
      close(h);
    }
  });
for (const repeat of [false, true])
  test(`T-F2 forwarded A superseded by deferred B cannot run after goAway${repeat ? ' shortened twice' : ''}`, async () => {
    const h = harness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message(audio);
      assert.equal(h.c.sendTextCommand('Zoom out A'), true);
      assert.equal(h.c.replyPending, true);
      assert.equal(h.c.sendTextCommand('Zoom out B'), true);
      assert.equal(h.c.deferredInput.kind, 'user-text');
      assert.ok(h.c.currentTypedInput());
      onset(ws);
      assert.equal(h.c.automaticTurnOpen, true);
      ws.message({ goAway: { timeLeft: '30s' } });
      assert.equal(h.c.deferredInput, null);
      if (repeat) {
        ws.message({ goAway: { timeLeft: '20s' } });
        ws.message({ goAway: { timeLeft: '10s' } });
      }
      assert.equal(h.c.goAway.supersededSuccessor, true);
      assert.equal(h.c.isActive(), true);
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      tools(ws, 'superseded-A');
      await h.c.toolQueue;
      assert.equal(h.calls.length, 0, 'A cannot run with dropped B authority');
      assert.equal(
        h.c.isActive(),
        false,
        'ordered boundary closes superseded forwarded predecessor',
      );
    } finally {
      close(h);
    }
  });
test('T-F3 VAD-only no-generation expiry waits to bounded native deadline and releases resources', async () => {
  const h = harness();
  try {
    await h.c.start();
    onset(h.sockets[0]);
    h.sockets[0].message({ goAway: { timeLeft: '30s' } });
    h.advance(29999);
    assert.equal(h.c.isActive(), true);
    h.advance(1);
    assert.equal(h.c.isActive(), false);
    assert.equal(h.timers.size, 0);
    assert.equal(
      h.tracks.every((t) => t.readyState === 'ended'),
      true,
    );
  } finally {
    close(h);
  }
});
test('T-C1 coalesced new START and natural old completion preserve newer automatic activity', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    ws.message(audio);
    ws.message({
      voiceActivity: { type: 'ACTIVITY_START' },
      serverContent: { turnComplete: true },
    });
    assert.equal(h.c.retiredReplyPending, false);
    assert.equal(h.c.automaticTurnOpen, true);
    ws.message({ goAway: { timeLeft: '30s' } });
    assert.equal(h.c.isActive(), true);
  } finally {
    close(h);
  }
});
test('T-C2 generationComplete alone followed by natural completion emits completion with no retirement timer', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    ws.message({ serverContent: { generationComplete: true } });
    assert.equal(h.c.replyPending, true);
    done(ws);
    assert.equal(
      h.events.findLast((e) => e.type === 'completion')?.status,
      'completed',
    );
    assert.equal(h.c.replyPending, false);
    assert.equal(h.c.automaticTurnOpen, false);
    assert.equal(h.c.retiredBoundaryWait, null);
    assert.equal(h.timers.size, 0);
  } finally {
    close(h);
  }
});

test('T-C3 silent PTT terminal completion emits spoken false without fabricated audio', async () => {
  const h = harness();
  try {
    await h.c.start({ pushToTalk: true });
    const ws = h.sockets[0],
      a = h.captures[0];
    h.c.input.setMicrophoneEnabled(true);
    a.callbacks.onAudio(
      { data: 'AAAB', mimeType: 'audio/pcm;rate=16000' },
      a.metadata,
    );
    h.c.input.setMicrophoneEnabled(false);
    assert.equal(h.c.userTurnPending, true);
    ws.message({ serverContent: { generationComplete: true } });
    done(ws);
    const event = h.events.findLast((e) => e.type === 'completion');
    assert.equal(event.status, 'completed');
    assert.equal(event.spoken, false);
    assert.equal(a.played.length, 0);
    assert.equal(h.c.userTurnPending, false);
  } finally {
    close(h);
  }
});
test('T-C4 silent terminal boundary waits for pending tool and native follow-up completion', async () => {
  const gate = deferred(),
    entered = [];
  const h = harness({
    runAction: async (_n, _a, o) => {
      entered.push(o);
      await gate.promise;
      return { ok: true };
    },
  });
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    tools(ws, 'pending-terminal-tool');
    await tick();
    assert.equal(entered.length, 1);
    done(ws);
    assert.equal(
      h.events.some((e) => e.type === 'completion'),
      false,
    );
    assert.equal(h.c.userTurnPending, false);
    gate.resolve();
    await h.c.toolQueue;
    h.c.finishPlayback();
    assert.equal(
      h.events.some((e) => e.type === 'completion'),
      false,
    );
    assert.equal(h.c.replyPending, true, 'tool result awaits native follow-up');
    done(ws);
    assert.equal(
      h.events.findLast((e) => e.type === 'completion')?.status,
      'completed',
    );
  } finally {
    gate.resolve();
    close(h);
  }
});
test('T-C5 terminal boundary with queued PCM waits for drain and preserves real spoken state', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    ws.message(audio);
    ws.message({ serverContent: { generationComplete: true } });
    done(ws);
    assert.equal(
      h.events.some((e) => e.type === 'completion'),
      false,
    );
    h.captures[0].drain();
    const event = h.events.findLast((e) => e.type === 'completion');
    assert.equal(event.status, 'completed');
    assert.equal(event.spoken, true);
  } finally {
    close(h);
  }
});
test('T-C6 old retired terminal boundary cannot clear successor userTurnPending', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    ws.message(audio);
    assert.equal(h.c.sendTextCommand('Zoom out successor'), true);
    assert.equal(h.c.userTurnPending, true);
    done(ws);
    assert.equal(h.c.userTurnPending, true);
    assert.equal(
      h.events.some((e) => e.type === 'completion'),
      false,
    );
  } finally {
    close(h);
  }
});
test('T-C7 reentrant silent completion observer keeps new input pending', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    const emit = h.c.emit.bind(h.c);
    h.c.emit = (event) => {
      emit(event);
      if (event.type === 'completion')
        h.c.sendTextCommand('Zoom out reentrant');
    };
    onset(ws);
    ws.message({ serverContent: { generationComplete: true } });
    done(ws);
    assert.equal(h.events.filter((e) => e.type === 'completion').length, 1);
    assert.equal(h.c.replyPending, true);
    assert.equal(h.c.userTurnPending, true);
    assert.ok(h.c.currentTypedInput());
    assert.equal(h.c.modelComplete, false);
  } finally {
    close(h);
  }
});
