import test from 'node:test';
import assert from 'node:assert/strict';
import { withToolCatalog } from './gevRealtime.js';
import { createVoiceSession } from './session.js';
import { RealtimeRadio } from './realtimeRadio.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('cancelled and stale query calls do not dispatch after a shared deferred catalog loads', async (t) => {
  for (const cancel of ['signal', 'isCurrent']) {
    await t.test(cancel, async () => {
      const loaded = deferred();
      const controller = new AbortController();
      let current = true;
      const calls = [];
      let fallbackCalls = 0;
      const run = withToolCatalog(
        async () => {
          fallbackCalls++;
        },
        () => loaded.promise,
      );
      const old = run(
        'get_weather',
        { owner: 'old' },
        {
          signal: controller.signal,
          isCurrent: () => current,
        },
      );
      const successorSignal = new AbortController().signal;
      const successor = run(
        'get_weather',
        { owner: 'new' },
        { signal: successorSignal },
      );
      if (cancel === 'signal') controller.abort();
      else current = false;
      loaded.resolve({
        get: () => ({}),
        async call(name, args, options) {
          calls.push({ name, args, signal: options.signal });
          return { summary: 'Live successor', data: args };
        },
      });
      await assert.rejects(old, { name: 'AbortError' });
      assert.deepEqual(await successor, {
        ok: true,
        tool: 'get_weather',
        summary: 'Live successor',
        data: { owner: 'new' },
      });
      assert.deepEqual(calls, [
        {
          name: 'get_weather',
          args: { owner: 'new' },
          signal: successorSignal,
        },
      ]);
      assert.equal(fallbackCalls, 0);
    });
  }
});

test('a query cancelled before entry never starts the loader or fallback', async () => {
  let loads = 0;
  let fallbackCalls = 0;
  const run = withToolCatalog(
    async () => {
      fallbackCalls++;
    },
    async () => {
      loads++;
    },
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(run('get_weather', {}, { signal: aborted.signal }), {
    name: 'AbortError',
  });
  await assert.rejects(run('get_weather', {}, { isCurrent: () => false }), {
    name: 'AbortError',
  });
  assert.equal(loads, 0);
  assert.equal(fallbackCalls, 0);
});

test('a live signal cannot publish a catalog result after its call ownership becomes stale', async () => {
  const pending = deferred();
  const signal = new AbortController().signal;
  let current = true;
  let forwarded;
  const run = withToolCatalog(
    async () => assert.fail('unexpected fallback'),
    async () => ({
      get: () => ({}),
      call(_name, _args, options) {
        forwarded = options.signal;
        return pending.promise;
      },
    }),
  );
  const result = run('get_weather', {}, { signal, isCurrent: () => current });
  await Promise.resolve();
  assert.equal(forwarded, signal);
  current = false;
  pending.resolve({ summary: 'Stale', data: {} });
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(signal.aborted, false);
});

test('late catalog results cannot publish through the real session after interruption', async (t) => {
  const result = deferred();
  const calls = [];
  let hooks;
  const events = [];
  const session = createVoiceSession({
    runner: withToolCatalog(
      async () => assert.fail('unexpected action fallback'),
      async () => ({
        get: () => ({}),
        call(name, args, options) {
          calls.push({ name, args, signal: options.signal });
          return args.owner === 'old'
            ? result.promise
            : Promise.resolve({ summary: 'Successor', data: args });
        },
      }),
    ),
    createAdapter(options) {
      hooks = options;
      return {
        start: () => hooks.emit({ type: 'state', state: 'listening' }),
        stop() {},
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  t.after(() => session.destroy());
  session.subscribe((event) => events.push(event));
  await session.start();
  const old = hooks.runAction('get_weather', { owner: 'old' });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  hooks.emit({ type: 'interruption' });
  assert.equal(
    calls[0].signal.aborted,
    true,
    'catalog received the common action signal',
  );
  const successor = await hooks.runAction('get_weather', { owner: 'new' });
  assert.equal(successor.summary, 'Successor');
  result.resolve({ summary: 'Stale result', data: { owner: 'old' } });
  await assert.rejects(old, { name: 'AbortError' });
  assert.deepEqual(
    events
      .filter((event) => event.type === 'action-result')
      .map((event) => event.result.summary),
    ['Successor'],
  );
  assert.equal(calls[1].signal.aborted, false);
});

function radioFixture(t) {
  let observer;
  const resumed = [];
  const stopped = [];
  const settings = { pushToTalk: false, voice: 'alloy' };
  const channel = { readyState: 'open' };
  let active = true;
  const layer = {
    subscribePlaybackControls(listener) {
      observer = listener;
      return () => {
        observer = null;
      };
    },
    setVoiceDucked() {},
    playForVoice: async () => true,
    stopPlayback() {},
  };
  let radio;
  radio = new RealtimeRadio({
    readRadioLayer: () => layer,
    readDataManager: () => null,
    readChannel: () => channel,
    readUserTurnPending: () => false,
    readSessionId: () => 7,
    operations: {
      isActive: () => active,
      stop(options) {
        stopped.push(options);
        active = false;
        radio.stopHandoff(options);
      },
      readVoiceResumeSettings: () => settings,
      resumeVoice: (options) => {
        resumed.push(options);
        active = true;
      },
      debugLog() {},
    },
  });
  radio.observe();
  t.after(() => radio.detachObservers());
  return {
    radio,
    resumed,
    stopped,
    settings,
    emit: (event) => observer?.(event),
    async handoff() {
      radio.setPendingPlayback({ ok: true, radioPlaybackRequested: true });
      await radio.startPendingRadioHandoff();
      assert.ok(
        radio.radioVoiceResume,
        'actual ready handoff acquired a voice resume lease',
      );
      assert.deepEqual(stopped.at(-1), { preserveRadioPlayback: true });
      return radio.radioVoiceResume.attemptId;
    },
  };
}

test('Radio pause and stop resume voice only for the matching handoff lease and only once', async (t) => {
  for (const action of ['pause', 'stop']) {
    for (const matching of [true, false]) {
      await t.test(
        `${action}: ${matching ? 'matching' : 'different'} attempt`,
        async (t) => {
          const f = radioFixture(t);
          const attemptId = await f.handoff();
          f.emit({
            action,
            origin: 'user',
            attemptId: matching ? attemptId : 'manual-radio',
          });
          f.emit({ action, origin: 'user', attemptId });
          await Promise.resolve();
          assert.deepEqual(f.resumed, matching ? [f.settings] : []);
          assert.equal(f.radio.radioVoiceResume, null);
        },
      );
    }
  }
});

test('each manual Radio replacement revokes the old voice resume lease', async (t) => {
  for (const action of ['play-request', 'play', 'select', 'tune']) {
    await t.test(action, async (t) => {
      const f = radioFixture(t);
      const attemptId = await f.handoff();
      const epoch = f.radio.radioVoiceResumeEpoch;
      f.emit({ action, origin: 'user', attemptId: 'manual-radio' });
      assert.equal(f.radio.radioVoiceResume, null);
      assert.ok(f.radio.radioVoiceResumeEpoch > epoch);
      f.emit({ action: 'pause', origin: 'user', attemptId });
      await Promise.resolve();
      assert.deepEqual(f.resumed, []);
    });
  }
});

test('explicit voice off and teardown defeat a Radio resume already queued by Pause', async (t) => {
  for (const cancel of ['voice-off', 'detach']) {
    await t.test(cancel, async (t) => {
      const f = radioFixture(t);
      const attemptId = await f.handoff();
      f.emit({ action: 'pause', origin: 'user', attemptId });
      if (cancel === 'voice-off') f.radio.stopHandoff();
      else f.radio.detachObservers();
      await Promise.resolve();
      assert.deepEqual(f.resumed, []);
      assert.equal(f.radio.radioVoiceResume, null);
    });
  }
});

test('provider cleanup controls do not consume the user Radio pause resume lease', async (t) => {
  const f = radioFixture(t);
  const attemptId = await f.handoff();
  f.emit({ action: 'pause', origin: 'voice-duck', attemptId });
  f.emit({ action: 'stop', origin: 'voice-cleanup', attemptId });
  await Promise.resolve();
  assert.deepEqual(f.resumed, []);
  assert.equal(f.radio.radioVoiceResume.attemptId, attemptId);
  f.emit({ action: 'pause', origin: 'user', attemptId });
  await Promise.resolve();
  assert.deepEqual(f.resumed, [f.settings]);
});
