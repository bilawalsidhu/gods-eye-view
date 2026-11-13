// A GEV scene's Play waits for the last run to tear down and for the new run
// to start; a Pause, Seek or Destroy meanwhile must win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevPlayer } from './gevPlayer.js';

const story = {
  sceneId: 'scene-1',
  durationMs: 60000,
  chapters: [{ wallMs: 0 }, { wallMs: 30000 }],
};

/** A director whose start resolves when the test says so. */
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
      return new Promise((resolve) => {
        release = () => {
          director.running = true;
          resolve({ started: true });
        };
      });
    },
    finishStart: () => release?.(),
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

test('a Pause while the run is starting is applied once it has started', async () => {
  const director = deferredDirector();
  const player = createGevPlayer(director, story);
  const playing = player.play();
  await turns();
  assert.deepEqual(director.calls, ['start']);
  player.pause();
  director.finishStart();
  await playing;
  // Pause seeks once when pressed, and again after the late start.
  assert.equal(director.calls.filter((c) => c.startsWith('seek')).length, 2);
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
