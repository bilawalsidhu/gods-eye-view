import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeIntegrationFixture,
  assertSuccessfulZoom,
  turnOfEventLoop,
} from '../testSupport/geminiIntegrationFixture.mjs';

const options = { concurrency: false, timeout: 5000 };
const resultFor = (h, id) =>
  h.events.filter(
    (event) => event.type === 'action-result' && event.callId === id,
  );
const callFor = (h, id) =>
  h.events.filter(
    (event) => event.type === 'action-call' && event.callId === id,
  );

test(
  'native tool reaches actual common session and camera runner without a caption',
  options,
  async (t) => {
    const h = nativeIntegrationFixture(t);
    const ws = await h.start();
    h.activity(ws); // Native activity is input framing, not transcript admission.
    await h.tool('ordinary', ws);
    assertSuccessfulZoom(h, ws, 'ordinary', 1000);
    assert.equal(h.runnerCalls.length, 1);
    assert.equal(h.runnerCalls[0].options.callId, 'ordinary');
    assert.equal(h.runnerCalls[0].options.signal.aborted, false);
    assert.equal(h.runnerCalls[0].options.isCurrent(), true);
    h.complete(ws);
    assert.equal(h.controller.narration.state().tools, 0);
    assert.equal(h.controller.narration.state().pendingTimers, 0);
  },
);

for (const cancellation of ['stop', 'native interruption']) {
  test(
    `${cancellation} discards a stale completed action result; successor changes camera once`,
    options,
    async (t) => {
      const h = nativeIntegrationFixture(t);
      const oldSocket = await h.start();
      h.activity(oldSocket);
      const gate = h.holdResult('old');
      const oldDispatch = h.tool('old', oldSocket);
      const committedResult = await gate.ready;
      assert.equal(committedResult.ok, true);
      assert.equal(
        h.state.height,
        750,
        'the legitimate first action committed before cancellation',
      );
      assert.equal(callFor(h, 'old').length, 1);
      assert.deepEqual(resultFor(h, 'old'), []);
      assert.deepEqual(h.outputs(oldSocket), []);

      if (cancellation === 'stop') h.session.stop();
      else
        oldSocket.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
      assert.equal(h.runnerCalls[0].options.signal.aborted, true);
      assert.equal(h.runnerCalls[0].options.isCurrent(), false);
      await oldDispatch; // Cancellation must settle before the held result returns.
      gate.release();
      await turnOfEventLoop();
      assert.equal(
        h.state.height,
        750,
        'settling a cancelled result adds no camera mutation',
      );
      assert.equal(h.state.zooms.length, 1);
      assert.deepEqual(resultFor(h, 'old'), []);
      assert.deepEqual(h.outputs(oldSocket), []);
      if (cancellation === 'native interruption')
        assert.ok(h.events.some((event) => event.type === 'interruption'));

      const successorSocket =
        cancellation === 'stop' ? await h.start() : oldSocket;
      h.activity(successorSocket);
      await h.tool('successor', successorSocket);
      assertSuccessfulZoom(h, successorSocket, 'successor', 750);
      assert.equal(h.state.zooms.length, 2);
      assert.equal(h.runnerCalls.length, 2);
      assert.equal(
        h.outputs(successorSocket).some((output) => output.id === 'old'),
        false,
      );
      h.complete(successorSocket);
    },
  );
}

for (const phase of ['common connecting', 'adapter connecting']) {
  test(
    `Stop from ${phase} observer prevents acquisition and permits fresh Start`,
    options,
    async (t) => {
      const h = nativeIntegrationFixture(t);
      let stopped = false;
      const remove = h.session.subscribe((event) => {
        const matchingDetail =
          phase === 'common connecting'
            ? event.detail === undefined
            : typeof event.detail === 'string' && event.detail.length > 0;
        if (
          !stopped &&
          event.type === 'state' &&
          event.state === 'connecting' &&
          matchingDetail
        ) {
          stopped = true;
          h.session.stop();
        }
      });
      await h.session.start();
      remove();
      assert.equal(
        stopped,
        true,
        'the chosen production observer boundary was exercised',
      );
      assert.deepEqual(h.acquisitions, {
        microphone: 0,
        audio: 0,
        token: 0,
        socket: 0,
      });
      assert.equal(h.session.state, 'idle');
      assert.equal(h.controller.narration.state().tools, 0);
      assert.equal(h.controller.narration.state().pendingTimers, 0);
      assert.equal(h.clock.timers.size, 0);
      const ws = await h.start();
      h.activity(ws);
      await h.tool('fresh-after-start-cancel', ws);
      assertSuccessfulZoom(h, ws, 'fresh-after-start-cancel', 1000);
      h.complete(ws);
    },
  );
}

test(
  'Stop from common action-call observer prevents runner and leaves no unhandled rejection',
  options,
  async (t) => {
    const h = nativeIntegrationFixture(t);
    const ws = await h.start();
    const remove = h.session.subscribe((event) => {
      if (event.type === 'action-call' && event.callId === 'cancel-at-call')
        h.session.stop();
    });
    h.activity(ws);
    await h.tool('cancel-at-call', ws);
    // Do not install a swallowing process rejection listener. node:test records
    // an unhandled rejection as a failure; these checkpoints let it surface here.
    await turnOfEventLoop();
    await turnOfEventLoop();
    remove();
    assert.equal(callFor(h, 'cancel-at-call').length, 1);
    assert.deepEqual(resultFor(h, 'cancel-at-call'), []);
    assert.equal(h.runnerCalls.length, 0);
    assert.equal(h.state.height, 1000);
    assert.deepEqual(h.outputs(ws), []);
    assert.equal(h.controller.narration.state().tools, 0);
    assert.equal(h.controller.narration.state().pendingTimers, 0);
    assert.equal(h.clock.timers.size, 0);
    const successor = await h.start();
    h.activity(successor);
    await h.tool('after-call-cancel', successor);
    assertSuccessfulZoom(h, successor, 'after-call-cancel', 1000);
    h.complete(successor);
  },
);

test(
  'Stop from executing observer cannot recreate narration or dispatch the runner',
  options,
  async (t) => {
    const h = nativeIntegrationFixture(t);
    const ws = await h.start();
    let stopped = false;
    const remove = h.session.subscribe((event) => {
      if (!stopped && event.type === 'state' && event.state === 'executing') {
        stopped = true;
        h.session.stop();
      }
    });
    h.activity(ws);
    await h.tool('cancel-at-executing', ws);
    remove();
    assert.equal(stopped, true);
    assert.equal(h.runnerCalls.length, 0);
    assert.deepEqual(callFor(h, 'cancel-at-executing'), []);
    assert.deepEqual(resultFor(h, 'cancel-at-executing'), []);
    assert.equal(h.state.height, 1000);
    assert.deepEqual(h.outputs(ws), []);
    assert.equal(h.controller.narration.state().tools, 0);
    assert.equal(h.controller.narration.state().pendingTimers, 0);
    assert.equal(h.clock.timers.size, 0);
    assert.equal(ws.closed, true);
    assert.ok(h.audios.every((audio) => audio.closed));
    assert.ok(h.tracks.every((track) => track.readyState === 'ended'));
    const before = {
      events: h.events.length,
      wire: ws.sent.length,
      earcon: h.state.earconStarts,
    };
    h.clock.advance(60_000);
    assert.deepEqual(
      {
        events: h.events.length,
        wire: ws.sent.length,
        earcon: h.state.earconStarts,
      },
      before,
    );
    const successor = await h.start();
    h.activity(successor);
    await h.tool('after-executing-cancel', successor);
    assertSuccessfulZoom(h, successor, 'after-executing-cancel', 1000);
    h.complete(successor);
  },
);

test(
  'native idle observer restart remains connecting and public Stop cancels its pending permission',
  options,
  async (t) => {
    const h = nativeIntegrationFixture(t);
    await h.start();
    let grant;
    const permission = new Promise((resolve) => {
      grant = resolve;
    });
    h.controller.getUserMedia = () => permission;
    const states = [];
    let restarted = false;
    let startup;
    const remove = h.session.subscribe((event) => {
      if (event.type === 'state') states.push(event.state);
      if (!restarted && event.type === 'state' && event.state === 'idle') {
        restarted = true;
        startup = h.session.start();
      }
    });
    h.session.stop();
    remove();
    assert.equal(restarted, true);
    assert.equal(states.filter((state) => state === 'idle').length, 1);
    assert.equal(h.session.state, 'connecting');
    assert.equal(h.controller.status, 'connecting');
    assert.equal(
      h.session.isActive(),
      true,
      'the common button/facade must offer Stop',
    );
    h.session.stop();
    assert.equal(h.session.state, 'idle');
    assert.equal(h.controller.status, 'idle');
    const lateTrack = {
      readyState: 'live',
      stopCalls: 0,
      stop() {
        this.stopCalls++;
        this.readyState = 'ended';
      },
    };
    h.tracks.push(lateTrack);
    grant({ getTracks: () => [lateTrack], getAudioTracks: () => [lateTrack] });
    await startup;
    await turnOfEventLoop();
    assert.equal(lateTrack.stopCalls, 1);
    assert.equal(
      h.requests.length,
      1,
      'cancelled restart must not mint another token',
    );
    assert.equal(
      h.sockets.length,
      1,
      'cancelled restart must not open another socket',
    );
    assert.equal(h.session.state, 'idle');
  },
);
