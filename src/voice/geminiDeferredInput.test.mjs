import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeIntegrationFixture,
  assertSuccessfulZoom,
} from '../testSupport/geminiIntegrationFixture.mjs';

const options = { concurrency: false, timeout: 5000 };
const OLD_PCM = 'BAAFAA==';
const TEXT = 'Zoom in for the owned typed successor';

function exposeCapture(h) {
  const createAudio = h.controller.createAudio;
  h.controller.createAudio = (callbacks) => {
    const audio = createAudio(callbacks);
    audio.captureCallbacks = callbacks;
    return audio;
  };
}

async function startManual(h) {
  await h.session.start({ pushToTalk: true });
  assert.equal(h.session.state, 'listening');
  assert.equal(h.controller.input.pushToTalkMode, true);
  assert.equal(Boolean(h.controller.input.pushToTalkKeyHeld), false);
  return h.sockets.at(-1);
}

// Explicit fake worklet callbacks retain the native physical-capture path;
// this helper does not populate controller queues or ownership fields itself.
function speakAndRelease(h, data) {
  const c = h.controller;
  const audio = h.audios.at(-1);
  c.input.pushToTalkKeyHeld = true;
  c.input.setMicrophoneEnabled(true);
  const metadata = audio.metadata;
  assert.ok(Number.isSafeInteger(metadata?.captureId));
  audio.captureCallbacks.onAudioStart(metadata);
  audio.captureCallbacks.onAudio(
    { data, mimeType: 'audio/pcm;rate=16000' },
    metadata,
  );
  c.input.pushToTalkKeyHeld = false;
  c.input.setMicrophoneEnabled(false);
  audio.captureCallbacks.onAudioEnd(metadata);
  return metadata;
}

async function prepareDeferredPtt(h) {
  exposeCapture(h);
  const socket = await startManual(h);
  speakAndRelease(h, 'AAABAA=='); // A is submitted and awaits its reply.
  speakAndRelease(h, 'AgADAA=='); // B is submitted, retiring A.
  const wireBeforeC = socket.sent.length;
  const metadata = speakAndRelease(h, OLD_PCM); // C waits behind A's boundary.
  const owner = h.controller.deferredInput;
  assert.equal(owner?.kind, 'push-to-talk');
  assert.equal(owner.captureId, metadata.captureId);
  assert.equal(
    socket.sent.length,
    wireBeforeC,
    'C must still be wholly deferred',
  );
  assert.deepEqual(
    owner.messages.map((message) =>
      message.realtimeInput?.activityStart
        ? 'start'
        : message.realtimeInput?.audio
          ? 'audio'
          : message.realtimeInput?.activityEnd
            ? 'end'
            : 'other',
    ),
    ['start', 'audio', 'end'],
  );
  return { socket, owner, metadata };
}

async function assertHealthySuccessor(h, socket, callId) {
  const beforeHeight = h.state.height;
  await h.tool(callId, socket);
  assertSuccessfulZoom(h, socket, callId, beforeHeight);
  assert.equal(h.controller.pendingTools, 0);
  h.complete(socket); // Native post-tool response boundary, with no output PCM.
  assert.equal(h.controller.narration.state().tools, 0);
  assert.equal(h.session.state, 'listening');
}

for (const mode of ['typed replacement', 'Stop', 'Stop+restart']) {
  test(
    `F04-5 deferred PTT flush loses its owner on ${mode}`,
    options,
    async (t) => {
      const h = nativeIntegrationFixture(t);
      const { socket: oldSocket, owner } = await prepareDeferredPtt(h);
      const oldAudio = h.audios.at(-1);
      let observed = 0;
      let sentAtObserverReturn;
      let restart;
      let stateAtObserverReturn;
      const unsubscribe = h.session.subscribe((event) => {
        if (
          event.type !== 'transcript' ||
          event.role !== 'user' ||
          event.text !== '' ||
          observed
        )
          return;
        observed++;
        if (mode === 'typed replacement') {
          assert.equal(h.session.sendText(TEXT), true);
        } else {
          h.session.stop();
          if (mode === 'Stop+restart')
            restart = h.session.start({ pushToTalk: true });
        }
        sentAtObserverReturn = oldSocket.sent.length;
        stateAtObserverReturn = {
          epoch: h.controller.epoch,
          turn: h.controller.turn,
          replyPending: h.controller.replyPending,
          forwardedActivityOpen: h.controller.forwardedActivityOpen,
        };
      });
      t.after(unsubscribe);

      h.complete(oldSocket); // A's boundary starts flushing C. C's start emits.
      assert.equal(
        observed,
        1,
        'must enter the actual flush/onset observer boundary',
      );
      assert.ok(
        stateAtObserverReturn,
        'observer must complete its replacement action',
      );
      assert.deepEqual(
        oldSocket.sent.slice(sentAtObserverReturn),
        [],
        'retired C must send neither queued PCM nor an extra end after the observer returns',
      );
      assert.deepEqual(
        {
          epoch: h.controller.epoch,
          turn: h.controller.turn,
          replyPending: h.controller.replyPending,
          forwardedActivityOpen: h.controller.forwardedActivityOpen,
        },
        stateAtObserverReturn,
        'old flush must not write successor state',
      );
      assert.equal(h.controller.deferredInput, null);
      assert.equal(
        h.controller.typedIntent?.text ?? null,
        mode === 'typed replacement' ? TEXT : null,
      );

      let successorSocket;
      if (mode === 'typed replacement') {
        assert.equal(h.controller.epoch, owner.epoch);
        assert.notEqual(h.controller.turn, owner.turn);
        assert.equal(
          oldSocket.sent.some(
            (message) => message.realtimeInput?.audio?.data === OLD_PCM,
          ),
          false,
        );
        const typedIndex = oldSocket.sent.findIndex((message) =>
          message.clientContent?.turns?.some((turn) =>
            turn.parts?.some((part) => part.text === TEXT),
          ),
        );
        assert.ok(
          typedIndex >= 0,
          'owned replacement must actually reach transport',
        );
        // The replacement legitimately closes the already-forwarded C start once.
        assert.ok(oldSocket.sent[typedIndex - 1]?.realtimeInput?.activityEnd);
        h.complete(oldSocket); // B's remaining retired boundary, deliberately separate.
        assert.equal(h.controller.retiredReplyPending, false);
        assert.equal(h.controller.replyPending, true);
        successorSocket = oldSocket;
      } else {
        assert.equal(oldAudio.closed, true);
        assert.equal(oldSocket.closed, true);
        if (!restart) restart = h.session.start({ pushToTalk: true });
        await restart;
        successorSocket = h.sockets.at(-1);
        assert.notEqual(successorSocket, oldSocket);
        assert.equal(
          successorSocket.sent.some((message) => message.realtimeInput?.audio),
          false,
        );
        assert.equal(
          successorSocket.sent.some(
            (message) => message.realtimeInput?.activityEnd,
          ),
          false,
        );
        assert.equal(h.session.sendText(TEXT), true);
      }
      await assertHealthySuccessor(
        h,
        successorSocket,
        `healthy-after-deferred-${mode}`,
      );
    },
  );
}

test(
  'F04-5 deferred typed onSent cannot resurrect replyPending after Stop+restart',
  options,
  async (t) => {
    const h = nativeIntegrationFixture(t);
    const oldSocket = await h.start();
    assert.equal(h.session.sendText('A'), true);
    assert.equal(h.session.sendText('B'), true);
    assert.equal(h.session.sendText('C deferred text'), true);
    assert.equal(h.controller.deferredInput?.kind, 'user-text');
    let restart;
    let observed = 0;
    const unsubscribe = h.session.subscribe((event) => {
      if (
        event.type !== 'transcript' ||
        event.role !== 'user' ||
        event.text !== 'C deferred text'
      )
        return;
      observed++;
      h.session.stop();
      restart = h.session.start();
    });
    t.after(unsubscribe);
    h.complete(oldSocket);
    assert.equal(observed, 1);
    assert.equal(
      h.controller.replyPending,
      false,
      'old onSent wrapper must not resurrect a stopped reply',
    );
    await restart;
    assert.equal(h.controller.replyPending, false);
    const socket = h.sockets.at(-1);
    assert.equal(
      socket.sent.length,
      1,
      'replacement connection should contain setup only',
    );
    assert.equal(h.session.sendText(TEXT), true);
    await assertHealthySuccessor(h, socket, 'healthy-after-deferred-text');
  },
);

test(
  'F04-5 ordinary deferred PTT flush preserves start, PCM and end exactly once',
  options,
  async (t) => {
    const h = nativeIntegrationFixture(t);
    const { socket } = await prepareDeferredPtt(h);
    const before = socket.sent.length;
    h.complete(socket);
    assert.deepEqual(
      socket.sent
        .slice(before)
        .map((message) =>
          message.realtimeInput?.activityStart
            ? 'start'
            : message.realtimeInput?.audio?.data === OLD_PCM
              ? 'audio'
              : message.realtimeInput?.activityEnd
                ? 'end'
                : 'other',
        ),
      ['start', 'audio', 'end'],
    );
    assert.equal(h.controller.deferredInput, null);
    assert.equal(h.controller.replyPending, true);
    assert.equal(h.controller.retiredReplyPending, true);
    h.complete(socket); // B's boundary; C remains the owned submitted input.
    assert.equal(h.controller.retiredReplyPending, false);
    assert.equal(h.controller.replyPending, true);
    await assertHealthySuccessor(h, socket, 'healthy-ordinary-deferred');
  },
);
