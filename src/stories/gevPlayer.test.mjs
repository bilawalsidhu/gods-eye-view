// A GEV scene's Play waits for the last run to tear down and for the new run
// to finish; a Pause, Seek or Destroy meanwhile must win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevPlayer } from './gevPlayer.js';

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
    subscribeSceneClock: () => () => {},
    stopScene: () => calls.push('stop'),
    whenIdle() {
      return new Promise((resolve) => {
        const check = () => (this.running ? setTimeout(check, 10) : resolve());
        check();
      });
    },

    seekScene: (id, f) => calls.push(`seek ${f}`),
    startScene: () => {
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
  player.pause();
  player.seek(30000);
  director.finishRun();
  await playing;
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

test('Destroy cancels a waiting Play', async () => {
  const director = deferredDirector({ running: true });
  const player = createGevPlayer(director, story);
  const playing = player.play();
  player.destroy();
  director.running = false;
  await playing;
  assert.equal(director.calls.includes('start'), false);
});
