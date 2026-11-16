// A GEV scene's Play waits for the last run to tear down and for the new run
// to finish; a Pause, Seek or Destroy meanwhile must win.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGevPlayer,
  directorSettled,
  SETTLE_LIMIT_MS,
} from './gevPlayer.js';

const story = {
  sceneId: 'scene-1',
  durationMs: 60000,
  chapters: [{ wallMs: 0 }, { wallMs: 30000 }],
};

/** A director whose run starts immediately and ends when the test says so. */
function deferredDirector({ running = false } = {}) {
  const calls = [];
  let release = null;
  const director = {
    running,
    calls,
    listShots: () => [{ id: 'a' }, { id: 'b' }],
    // The scene clock's listener, so a test can publish as the director
    // does after a seek or at a run's end.
    subscribeSceneClock: (fn) => {
      director.publish = (snap) => fn({ sceneId: 'scene-1', ...snap });
      return () => {};
    },
    stopScene: () => calls.push('stop'),
    whenIdle() {
      return new Promise((resolve) => {
        const check = () => (this.running ? setTimeout(check, 10) : resolve());
        check();
      });
    },

    seekScene: (id, f) => calls.push(`seek ${f}`),
    startScene: (_id, options) => {
      director.startOptions = options;
      calls.push('start');
      director.running = true;
      return new Promise((resolve) => {
        release = () => {
          director.running = false;
          resolve({ started: true });
        };
      });
    },
    finishRun: () => release?.(),
  };
  return director;
}
const turns = async (n = 4) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

test('Pause straight after Play stops the Play from starting', async () => {
  const director = deferredDirector();
  const states = [];
  const player = createGevPlayer(director, story, {
    onTick: (s) => states.push(s.playing),
  });
  const playing = player.play();
  player.pause();
  await playing;
  assert.equal(director.calls.includes('start'), false);
  assert.equal(states.at(-1), false);
});

test('a Seek during the last run’s teardown cancels the waiting Play', async () => {
  const director = deferredDirector({ running: true });
  const player = createGevPlayer(director, story);
  const playing = player.play();
  player.seek(30000);
  director.running = false; // the old run finishes tearing down
  await playing;
  assert.equal(director.calls.includes('start'), false);
  assert.equal(player.state.playing, false);
  assert.equal(player.state.wallMs, 30000);
});

test('a stopped run’s completion does not repeat a newer seek', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  const playing = player.play();
  await turns();
  assert.deepEqual(director.calls, ['start']);
  assert.equal(director.running, true);
  const oldClock = {
    sceneElapsedSec: 0,
    running: false,
  };
  const recordSeek = director.seekScene;
  let settleSeek;
  director.seekScene = (id, progress) => {
    recordSeek(id, progress);
    director.publish({ ...oldClock, stopped: true });
    return new Promise((resolve) => {
      if (progress === 0.5) settleSeek = resolve;
      else resolve(false);
    });
  };
  player.pause();
  player.seek(30000);
  assert.equal(
    player.state.wallMs,
    30000,
    'Share can read the new time immediately',
  );
  await turns();
  director.publish(oldClock);
  director.publish({ ...oldClock, seeking: true });
  assert.equal(
    player.state.wallMs,
    30000,
    'old teardown cannot move the timeline',
  );
  director.finishRun();
  await playing;
  director.publish({ running: false, seeking: true, sceneElapsedSec: 30 });
  settleSeek(true);
  await turns();
  assert.deepEqual(director.calls, ['start', 'seek 0', 'seek 0.5']);
  assert.equal(player.state.playing, false);
  assert.equal(player.state.wallMs, 30000);
});

test('a paused seek keeps its exact position near the end of a story', () => {
  const director = deferredDirector();
  let publishClock;
  director.subscribeSceneClock = (listener) => {
    publishClock = listener;
    return () => {};
  };
  const player = createGevPlayer(director, story);
  player.seek(59800);
  publishClock({
    sceneId: story.sceneId,
    sceneElapsedSec: 59.8,
    sceneDurationSec: 60,
    running: false,
    seeking: true,
  });
  assert.equal(player.state.wallMs, 59800);
  assert.equal(player.state.playing, false);
});

test('Play from a paused link in the final quarter-second stays in the final shot', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  player.seek(59800); // 200 ms before the end of a two-shot scene
  const playing = player.play();
  await turns();
  assert.equal(
    player.state.wallMs,
    59800,
    'the link is not treated as complete',
  );
  assert.equal(
    director.startOptions.fromProgress,
    59800 / 60000,
    'resume at the same moment of the final shot',
  );
  director.finishRun();
  await playing;
});

test('Play after the actual end still starts the scene from shot one', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  player.seek(60000);
  const playing = player.play();
  await turns();
  assert.equal(player.state.wallMs, 0);
  assert.equal(director.startOptions.fromProgress, 0);
  director.finishRun();
  await playing;
});

test('Destroy cancels a waiting Play', async () => {
  const director = deferredDirector({ running: true });
  const player = createGevPlayer(director, story);
  const playing = player.play();
  player.destroy();
  director.running = false;
  await playing;
  assert.equal(director.calls.includes('start'), false);
});

test('in the director’s order, a paused link near the end resumes in its final shot', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  player.seek(59800);
  // The director reports a seek as seeking, even once it has settled.
  director.publish({
    sceneDurationSec: 60,
    sceneElapsedSec: 59.8,
    shotIndex: 1,
    running: false,
    seeking: true,
  });
  assert.equal(player.state.wallMs, 59800, 'not rounded to the end');
  const playing = player.play();
  await turns();
  assert.equal(
    director.startOptions.fromProgress,
    59800 / 60000,
    'resume at the same moment of the final shot',
  );
  director.finishRun();
  await playing;
});

test('a run that ends on its own is rounded to the end, and Play then starts over', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  // The director reports a run's natural end as stopped, not seeking.
  director.publish({
    sceneDurationSec: 60,
    sceneElapsedSec: 59.9,
    shotIndex: 1,
    running: false,
  });
  assert.equal(player.state.wallMs, 60000, 'rounded to the end');
  const playing = player.play();
  await turns();
  assert.equal(player.state.wallMs, 0);
  assert.equal(director.startOptions.fromProgress, 0, 'from the start');
  director.finishRun();
  await playing;
});

test('Play after Pause goes on from the paused moment, not the shot’s start', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  const playing = player.play();
  await turns();
  // The run is 42 s in, 12 s into the second shot, when it is paused.
  director.publish({
    sceneDurationSec: 60,
    sceneElapsedSec: 42,
    shotIndex: 1,
    running: true,
  });
  player.pause();
  director.finishRun();
  await playing;
  assert.equal(player.state.wallMs, 42000);
  const again = player.play();
  await turns();
  assert.equal(director.startOptions.fromProgress, 42000 / 60000);
  director.finishRun();
  await again;
});

test('Play after a seek goes on from the time sought', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  player.seek(12345);
  const playing = player.play();
  await turns();
  assert.equal(director.startOptions.fromProgress, 12345 / 60000);
  assert.equal(director.startOptions.afterShotId, undefined);
  director.finishRun();
  await playing;
});

test('Play from a paused link goes on from the link’s time', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  // Opening a paused link seeks to its time, and the director reports it.
  player.seek(17500);
  director.publish({
    sceneDurationSec: 60,
    sceneElapsedSec: 17.5,
    shotIndex: 0,
    running: false,
    seeking: true,
  });
  const playing = player.play();
  await turns();
  assert.equal(director.startOptions.fromProgress, 17500 / 60000);
  director.finishRun();
  await playing;
});

test('a teardown that outlasts the limit is told apart, and loses its say over layers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warn = console.warn;
  console.warn = () => {};
  let revoked = 0;
  const director = {
    whenIdle: () => new Promise(() => {}),
    revokeSceneRelease: () => revoked++,
  };
  try {
    const settled = directorSettled(director);
    await turns();
    assert.equal(revoked, 0, 'nothing is revoked while waiting');
    t.mock.timers.tick(SETTLE_LIMIT_MS);
    assert.equal(await settled, false, 'a timeout is not settlement');
    assert.equal(revoked, 1, 'the stale cleanup is revoked before going on');
  } finally {
    console.warn = warn;
  }
});

test('a teardown that finishes settles without revoking anything', async () => {
  let revoked = 0;
  const director = {
    whenIdle: async () => {},
    revokeSceneRelease: () => revoked++,
  };
  assert.equal(await directorSettled(director), true);
  assert.equal(revoked, 0);
});
