import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeIntegrationFixture,
  assertSuccessfulZoom,
  turnOfEventLoop,
} from '../testSupport/geminiIntegrationFixture.mjs';

const options = { concurrency: false, timeout: 5000 };
const OLD_TEXT = 'Old packet caption.';
const OLD_PCM = 'AAABAA==';
const POST_TOOL_PCM = 'AgADAA==';
const OLD_CALL = 'old-coalesced-call';

function coalescedPacket(callId = OLD_CALL) {
  return {
    serverContent: {
      outputTranscription: { text: OLD_TEXT },
      modelTurn: {
        parts: [
          { inlineData: { data: OLD_PCM, mimeType: 'audio/pcm;rate=24000' } },
        ],
      },
      turnComplete: true,
    },
    toolCall: {
      functionCalls: [
        {
          id: callId,
          name: 'adjust_camera_zoom',
          args: { direction: 'in', amount: 'little' },
        },
      ],
    },
  };
}

// Local test observations wrap only injected device fakes and the actual
// scheduler methods, delegating unchanged. No frozen fixture file is modified.
function observePacketEffects(h) {
  const played = [];
  const narration = { audible: 0, toolStarted: 0, toolFinished: 0 };
  const createAudio = h.controller.createAudio;
  h.controller.createAudio = (callbacks) => {
    const audio = createAudio(callbacks);
    const play = audio.play.bind(audio);
    audio.play = (data, mimeType) => {
      played.push({ audio, data, mimeType });
      return play(data, mimeType);
    };
    return audio;
  };
  for (const method of Object.keys(narration)) {
    const invoke = h.controller.narration[method].bind(h.controller.narration);
    h.controller.narration[method] = (...args) => {
      narration[method]++;
      return invoke(...args);
    };
  }
  return { played, narration };
}

function packetState(h) {
  const c = h.controller;
  return {
    epoch: c.epoch,
    inputGeneration: c.inputGeneration,
    turn: c.turn,
    completedTurns: c.completedTurns,
    pendingTools: c.pendingTools,
    modelComplete: c.modelComplete,
    pendingCompletionStatus: c.pendingCompletionStatus,
    postToolOutput: c.postToolOutput,
    modelSpoke: c.modelSpoke,
    assistant: c.transcripts.assistant,
    replyPending: c.replyPending,
    retiredReplyPending: c.retiredReplyPending,
    typedText: c.typedIntent?.text ?? null,
    typedResponseId: c.typedIntent?.responseId ?? null,
    narrationTools: c.narration.state().tools,
    narrationTimers: c.narration.state().pendingTimers,
    ownedTimers: h.clock.timers.size,
  };
}

const completions = (h) =>
  h.events.filter((event) => event.type === 'completion');
const toolEvents = (h, callId) =>
  h.events.filter(
    (event) =>
      ['action-call', 'action-result', 'progress'].includes(event.type) &&
      event.callId === callId,
  );

function assertOldRemainderAbsent(h, observed) {
  assert.equal(h.state.height, 1000);
  assert.deepEqual(h.state.zooms, []);
  assert.deepEqual(h.runnerCalls, []);
  assert.deepEqual(toolEvents(h, OLD_CALL), []);
  assert.deepEqual(observed.played, []);
  assert.deepEqual(observed.narration, {
    audible: 0,
    toolStarted: 0,
    toolFinished: 0,
  });
  assert.deepEqual(completions(h), []);
  assert.equal(h.controller.completedTurns, 0);
  assert.equal(h.controller.pendingTools, 0);
  assert.equal(
    h.events.filter(
      (event) =>
        event.type === 'transcript' &&
        event.role === 'assistant' &&
        event.final &&
        event.text === OLD_TEXT,
    ).length,
    0,
  );
  for (const socket of h.sockets)
    assert.equal(
      h.outputs(socket).some((output) => output.id === OLD_CALL),
      false,
    );
}

for (const mode of ['Stop', 'Stop then Start', 'typed successor']) {
  test(
    `assistant transcript observer ${mode} fences the rest of a coalesced native packet`,
    options,
    async (t) => {
      const h = nativeIntegrationFixture(t);
      const observed = observePacketEffects(h);
      const oldSocket = await h.start();
      const oldAudio = h.audios[0];
      h.activity(oldSocket);
      const before = packetState(h);
      let reached = false;
      let restart;
      let typedAccepted;
      let afterObserver;
      const remove = h.session.subscribe((event) => {
        if (
          reached ||
          event.type !== 'transcript' ||
          event.role !== 'assistant' ||
          event.final ||
          event.text !== OLD_TEXT
        )
          return;
        reached = true;
        if (mode === 'typed successor') {
          typedAccepted = h.session.sendText('Zoom in for the typed successor');
        } else {
          h.session.stop();
          if (mode === 'Stop then Start') restart = h.session.start();
        }
        afterObserver = packetState(h);
      });
      oldSocket.message(coalescedPacket());
      remove();
      assert.equal(
        reached,
        true,
        'the actual common transcript observer ran synchronously',
      );
      // A retired reply may consume its own received terminal, but cannot
      // complete or overwrite the successor. Stop/restart permits no old writes.
      const afterPacketExpected =
        mode === 'typed successor'
          ? {
              ...afterObserver,
              retiredReplyPending: false,
              ownedTimers: afterObserver.ownedTimers - 1,
            }
          : afterObserver;
      assert.deepEqual(packetState(h), afterPacketExpected);
      await h.controller.toolQueue;
      await turnOfEventLoop();
      if (restart) await restart;
      assertOldRemainderAbsent(h, observed);

      let successorSocket;
      if (mode === 'typed successor') {
        assert.equal(typedAccepted, true);
        assert.equal(
          h.controller.epoch,
          before.epoch,
          'typed replacement shares the socket epoch',
        );
        assert.ok(h.controller.inputGeneration > before.inputGeneration);
        assert.ok(h.controller.turn > before.turn);
        assert.deepEqual(packetState(h), afterPacketExpected);
        assert.equal(
          h.controller.typedIntent.text,
          'Zoom in for the typed successor',
        );
        assert.equal(h.controller.replyPending, true);
        assert.equal(h.controller.retiredReplyPending, false);
        assert.equal(oldAudio.closed, false);
        const typedMessages = oldSocket.sent.filter((message) =>
          message.clientContent?.turns?.some((turn) =>
            turn.parts?.some(
              (part) => part.text === 'Zoom in for the typed successor',
            ),
          ),
        );
        assert.equal(typedMessages.length, 1);
        // The received packet already carried the old terminal. No extra
        // provider boundary may be invented before testing the actual successor.
        assert.equal(h.controller.retiredBoundaryWait, null);
        assert.equal(h.controller.cancelledCalls.has(OLD_CALL), true);
        assert.equal(h.controller.replyPending, true);
        assert.equal(h.controller.completedTurns, 0);
        assert.deepEqual(completions(h), []);
        successorSocket = oldSocket;
      } else {
        assert.equal(oldSocket.closed, true);
        assert.equal(oldAudio.closed, true);
        assert.equal(h.controller.narration.state().tools, 0);
        assert.equal(h.controller.narration.state().pendingTimers, 0);
        assert.equal(h.clock.timers.size, 0);
        if (mode === 'Stop') {
          assert.equal(h.session.state, 'idle');
          successorSocket = await h.start();
        } else {
          assert.equal(h.session.state, 'listening');
          assert.equal(h.sockets.length, 2);
          assert.equal(h.audios.length, 2);
          assert.notEqual(h.audios[1], oldAudio);
          assert.equal(h.audios[1].closed, false);
          assert.equal(h.audios[1].pending, false);
          successorSocket = h.sockets[1];
        }
        h.activity(successorSocket);
      }
      await h.tool('owned-after-packet-cancel', successorSocket);
      assertSuccessfulZoom(
        h,
        successorSocket,
        'owned-after-packet-cancel',
        1000,
      );
      assert.equal(h.state.zooms.length, 1);
      assert.equal(h.runnerCalls.length, 1);
      assert.equal(
        h.outputs(successorSocket).some((output) => output.id === OLD_CALL),
        false,
      );
      h.complete(successorSocket);
      assert.equal(completions(h).length, 1);
      assert.equal(h.controller.narration.state().tools, 0);
      assert.equal(h.controller.narration.state().pendingTimers, 0);
    },
  );
}

test(
  'ordinary coalesced packet plays and executes once, then completes only after its post-tool reply',
  options,
  async (t) => {
    const h = nativeIntegrationFixture(t);
    const observed = observePacketEffects(h);
    const ws = await h.start();
    h.activity(ws);
    ws.message(coalescedPacket('ordinary-coalesced'));
    assert.equal(
      h.controller.completedTurns,
      1,
      'first generation terminal is counted once',
    );
    assert.equal(h.controller.pendingTools, 1);
    assert.deepEqual(
      observed.played.map(({ data }) => data),
      [OLD_PCM],
    );
    assert.equal(observed.played[0].audio, h.audios[0]);
    assert.deepEqual(completions(h), [], 'tool and playback are still pending');
    await h.controller.toolQueue;
    assertSuccessfulZoom(h, ws, 'ordinary-coalesced', 1000);
    assert.equal(h.controller.pendingTools, 0);
    assert.equal(observed.narration.toolStarted, 1);
    assert.equal(observed.narration.toolFinished, 1);
    assert.equal(h.controller.narration.state().tools, 0);
    h.audios[0].drain();
    assert.equal(
      h.controller.modelComplete,
      false,
      'function response waits for the post-tool generation',
    );
    assert.equal(h.controller.completedTurns, 1);
    assert.deepEqual(
      completions(h),
      [],
      'draining first-generation PCM cannot finish the tool reply',
    );

    // The accepted contract has two generations: the function response prompts
    // a fresh model reply. This boundary is intentional, not a stale-packet fix.
    ws.message({
      serverContent: {
        outputTranscription: { text: 'The requested zoom is complete.' },
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: POST_TOOL_PCM,
                mimeType: 'audio/pcm;rate=24000',
              },
            },
          ],
        },
        turnComplete: true,
      },
    });
    assert.equal(h.controller.completedTurns, 2);
    assert.deepEqual(
      observed.played.map(({ data }) => data),
      [OLD_PCM, POST_TOOL_PCM],
    );
    assert.deepEqual(
      completions(h),
      [],
      'post-tool playback must drain before completion',
    );
    h.audios[0].drain();
    assert.equal(completions(h).length, 1);
    assert.equal(completions(h)[0].status, 'completed');
    assert.equal(completions(h)[0].spoken, true);
    assert.equal(completions(h)[0].audioDrained, true);
    assert.equal(h.controller.pendingCompletionStatus, null);
    assert.equal(h.controller.narration.state().tools, 0);
    assert.equal(h.controller.narration.state().pendingTimers, 0);
    assert.equal(h.clock.timers.size, 0);
    assert.equal(observed.narration.audible, 2);
    assert.equal(h.runnerCalls.length, 1);
    assert.equal(h.state.zooms.length, 1);
    assert.equal(h.outputs(ws).length, 1);
    h.audios[0].drain();
    assert.equal(
      completions(h).length,
      1,
      'a duplicate device drain cannot complete twice',
    );
  },
);

// Real native message-type fields are separate packets here; no extra old
// completion is inserted before the accepted successor.
const BOUNDARY_OLD = 'Prior reply caption.';
const BOUNDARY_NEXT = 'Zoom in for the typed successor';
const boundaryZoomCall = (id) => ({
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
function boundarySnapshot(h) {
  const c = h.controller;
  return {
    retiredReplyPending: c.retiredReplyPending,
    retiredBoundaryWait: Boolean(c.retiredBoundaryWait),
    replyPending: c.replyPending,
    typedText: c.typedIntent?.text ?? null,
    completions: h.events.filter((event) => event.type === 'completion').length,
  };
}

for (const mode of [
  'partial assistant transcript',
  'input transcript',
  'interruption event',
  'listening event',
  'final assistant transcript control',
]) {
  test(
    `received native terminal preserves typed successor after ${mode}`,
    { concurrency: false, timeout: 5000 },
    async (t) => {
      const h = nativeIntegrationFixture(t);
      const ws = await h.start();
      h.activity(ws);
      let oldDispatch, gate;
      const interruptionMode =
        mode === 'interruption event' || mode === 'listening event';
      if (interruptionMode) {
        h.session.sendText('Prior zoom request');
        gate = h.holdResult('already-committed-old-tool');
        oldDispatch = h.tool('already-committed-old-tool', ws);
        await gate.ready;
      } else if (mode === 'input transcript') {
        ws.message({
          serverContent: {
            outputTranscription: { text: 'Previously emitted output' },
          },
        });
      }
      let entered = 0,
        accepted;
      const remove = h.session.subscribe((event) => {
        if (entered) return;
        const matches =
          mode === 'interruption event'
            ? event.type === 'interruption' && event.reason === 'user-speech'
            : mode === 'listening event'
              ? event.type === 'state' && event.state === 'listening'
              : mode === 'input transcript'
                ? event.type === 'transcript' &&
                  event.role === 'user' &&
                  event.text === 'Old input caption'
                : event.type === 'transcript' &&
                  event.role === 'assistant' &&
                  event.text === BOUNDARY_OLD &&
                  event.final ===
                    (mode === 'final assistant transcript control');
        if (!matches) return;
        entered++;
        accepted = h.session.sendText(BOUNDARY_NEXT);
      });
      if (interruptionMode)
        ws.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
      else
        ws.message({
          serverContent: {
            ...(mode === 'input transcript'
              ? { inputTranscription: { text: 'Old input caption' } }
              : {}),
            outputTranscription: { text: BOUNDARY_OLD },
            turnComplete: true,
          },
        });
      remove();
      if (oldDispatch) {
        await oldDispatch;
        gate.release();
      }
      await turnOfEventLoop();
      const afterPacket = boundarySnapshot(h);
      const beforeSuccessorHeight = h.state.height;
      // No extra synthetic old boundary. This is the next reply to the accepted text.
      ws.message({
        serverContent: {
          outputTranscription: { text: 'Handling your new zoom.' },
        },
      });
      ws.message(boundaryZoomCall('typed-successor-call'));
      await h.controller.toolQueue;
      await turnOfEventLoop();
      ws.message({ serverContent: { turnComplete: true } });
      const afterSuccessor = boundarySnapshot(h);
      assert.equal(entered, 1);
      assert.equal(accepted, true);
      assert.equal(
        afterPacket.retiredReplyPending,
        false,
        'received old terminal must settle its retirement',
      );
      assert.equal(afterPacket.retiredBoundaryWait, false);
      assert.equal(afterPacket.typedText, BOUNDARY_NEXT);
      assert.equal(
        h.runnerCalls.filter((x) => x.options.callId === 'typed-successor-call')
          .length,
        1,
        'accepted typed successor must reach the actual runner',
      );
      assert.equal(h.state.height, beforeSuccessorHeight * 0.75);
      assert.equal(afterSuccessor.completions, 1);
      assert.equal(afterSuccessor.replyPending, false);
      assert.equal(
        h.controller.cancelledCalls.has('typed-successor-call'),
        false,
      );
    },
  );
}

for (const terminalAlreadyApplied of [false, true]) {
  test(
    `typed reentry retains a genuinely pending boundary when terminal already applied is ${terminalAlreadyApplied}`,
    options,
    async (t) => {
      const h = nativeIntegrationFixture(t);
      const ws = await h.start();
      h.activity(ws);
      let entered = false;
      const remove = h.session.subscribe((event) => {
        if (
          entered ||
          event.type !== 'transcript' ||
          event.role !== 'assistant' ||
          event.text !== 'Boundary control' ||
          event.final !== terminalAlreadyApplied
        )
          return;
        entered = true;
        assert.equal(h.session.sendText('First typed replacement'), true);
        if (terminalAlreadyApplied)
          assert.equal(h.session.sendText('Second typed replacement'), true);
      });
      ws.message({
        serverContent: {
          outputTranscription: { text: 'Boundary control' },
          ...(terminalAlreadyApplied ? { turnComplete: true } : {}),
        },
      });
      remove();
      assert.equal(entered, true);
      // With no old terminal received, or when that terminal was consumed
      // before the observer, a real predecessor boundary is still outstanding.
      assert.equal(h.controller.retiredReplyPending, true);
      assert.ok(h.controller.retiredBoundaryWait);
      assert.equal(completions(h).length, 0);
      assert.equal(h.runnerCalls.length, 0);
      ws.message({ serverContent: { turnComplete: true } });
      assert.equal(h.controller.retiredReplyPending, false);
      assert.equal(h.controller.retiredBoundaryWait, null);
      await h.tool('after-real-pending-boundary', ws);
      assertSuccessfulZoom(h, ws, 'after-real-pending-boundary', 1000);
      h.complete(ws);
      assert.equal(completions(h).length, 1);
    },
  );
}
