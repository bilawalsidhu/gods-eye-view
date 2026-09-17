import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlaybackQueue, playSceneQueue } from './playback.js';

const scenes = [
  { id: 'a', title: 'A', shots: [{ id: 'a1' }, { id: 'a2' }] },
  { id: 'empty', shots: [] },
  { id: 'b', title: 'B', shots: [{ id: 'b1' }] },
];
const phases = [
  'selectShot',
  'applyVisual',
  'applyLayers',
  'travel',
  'settle',
  'hold',
  'completeShot',
];

function fixture(overrides = {}) {
  const events = [];
  const abort = new AbortController();
  const token = { cancelled: false, signal: abort.signal };
  const adapter = {
    ...Object.fromEntries(
      phases.map((phase) => [
        phase,
        ({ shot, token: received }) => {
          assert.equal(received, token);
          events.push(`${shot.id}:${phase}`);
        },
      ]),
    ),
    releaseScene(scene, received) {
      events.push(`release:${scene.id}:${received ? 'handoff' : 'cleanup'}`);
      return true;
    },
    complete() {
      events.push('complete');
    },
    ...overrides,
  };
  return { events, abort, token, adapter };
}

test('queues rotate scenes, skip empty scenes, preserve shot identity and support a single scene', () => {
  const queue = buildPlaybackQueue(scenes, 'b');
  assert.deepEqual(
    queue.map(({ shot }) => shot.id),
    ['b1', 'a1', 'a2'],
  );
  assert.equal(queue[0].shot, scenes[2].shots[0]);
  assert.deepEqual(buildPlaybackQueue(scenes, 'empty', { single: true }), []);
  assert.deepEqual(buildPlaybackQueue([], 'missing'), []);
  assert.deepEqual(
    buildPlaybackQueue(scenes, 'missing').map(({ shot }) => shot.id),
    ['a1', 'a2', 'b1'],
  );
});

test('playback sequences phases, releases only at scene changes, then releases the final scene', async () => {
  const f = fixture();
  const result = await playSceneQueue(buildPlaybackQueue(scenes, 'a'), f);
  assert.deepEqual(result, { status: 'completed', completedShots: 3 });
  assert.deepEqual(f.events, [
    ...phases.map((phase) => `a1:${phase}`),
    ...phases.map((phase) => `a2:${phase}`),
    'release:a:cleanup',
    ...phases.map((phase) => `b1:${phase}`),
    'complete',
    'release:b:cleanup',
  ]);
});

for (const phase of phases) {
  for (const cancellation of ['flag', 'signal']) {
    test(`${cancellation} cancellation while awaiting ${phase} stops subsequent work and releases resources`, async () => {
      let entered;
      let resume;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const pending = new Promise((resolve) => {
        resume = resolve;
      });
      const f = fixture({
        [phase]: async () => {
          entered();
          await pending;
        },
      });
      const run = playSceneQueue(buildPlaybackQueue(scenes, 'a'), f);
      await started;
      if (cancellation === 'flag') f.token.cancelled = true;
      else f.abort.abort();
      resume();
      assert.deepEqual(await run, { status: 'cancelled', completedShots: 0 });
      assert.deepEqual(f.events, [
        ...phases.slice(0, phases.indexOf(phase)).map((name) => `a1:${name}`),
        'release:a:cleanup',
      ]);
    });
  }
  test(`failure in ${phase} propagates after release, without later shots`, async () => {
    const failure = new Error('adapter failed');
    const f = fixture({
      [phase]: () => {
        throw failure;
      },
    });
    await assert.rejects(
      playSceneQueue(buildPlaybackQueue(scenes, 'a'), f),
      (error) => error === failure,
    );
    assert.equal(f.events.at(-1), 'release:a:cleanup');
    assert.ok(
      !f.events.some(
        (event) => event.startsWith('a2:') || event === 'complete',
      ),
    );
  });
}

test('empty and pre-aborted runs never acquire or release adapter resources', async () => {
  const f = fixture();
  assert.deepEqual(await playSceneQueue([], f), {
    status: 'completed',
    completedShots: 0,
  });
  f.abort.abort();
  assert.deepEqual(
    await playSceneQueue(buildPlaybackQueue(scenes, 'a'), {
      ...f,
      previousScene: scenes[2],
    }),
    { status: 'cancelled', completedShots: 0 },
  );
  assert.deepEqual(f.events, []);
});

test('a prior scene must release before playback; a refused handoff starts no shot', async () => {
  const f = fixture();
  await playSceneQueue(buildPlaybackQueue(scenes, 'a', { single: true }), {
    ...f,
    previousScene: scenes[2],
  });
  assert.equal(f.events[0], 'release:b:handoff');
  const refused = fixture({ releaseScene: () => false });
  await assert.rejects(
    playSceneQueue(buildPlaybackQueue(scenes, 'a'), {
      ...refused,
      previousScene: scenes[2],
    }),
    /Could not leave scene: B/,
  );
  assert.deepEqual(refused.events, []);
});

test('cancellation during an inter-scene release never acquires the next scene', async () => {
  const f = fixture();
  const release = f.adapter.releaseScene;
  f.adapter.releaseScene = (...args) => {
    f.abort.abort();
    return release(...args);
  };
  const result = await playSceneQueue(buildPlaybackQueue(scenes, 'a'), f);
  assert.deepEqual(result, { status: 'cancelled', completedShots: 2 });
  assert.equal(f.events.at(-1), 'release:a:cleanup');
  assert.equal(
    f.events.filter((event) => event.startsWith('release')).length,
    1,
  );
});

test('non-preview playback retains the final scene but still releases preceding scenes', async () => {
  const f = fixture();
  await playSceneQueue(buildPlaybackQueue(scenes, 'a'), {
    ...f,
    releaseOnFinish: false,
  });
  assert.deepEqual(
    f.events.filter((event) => event.startsWith('release')),
    ['release:a:cleanup'],
  );
});

test('a cleanup failure rejects for the caller to restore its own controls', async () => {
  const failure = new Error('cleanup failed');
  const f = fixture({
    releaseScene: () => {
      throw failure;
    },
  });
  await assert.rejects(
    playSceneQueue(buildPlaybackQueue(scenes, 'a', { single: true }), f),
    (error) => error === failure,
  );
});
