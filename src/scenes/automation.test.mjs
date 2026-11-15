// Pins for the dev-only window.__gevDirector automation handle.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIRECTOR_FINISHED_EVENT,
  createDirectorAutomation,
} from './automation.js';

function fakeDirector({ importResult = true } = {}) {
  let finishRun;
  const director = {
    running: false,
    imported: null,
    stopped: [],
    _presentation: { status: 'Import failed: bad version' },
    _lastRun: null,
    async importProjectFile(file) {
      this.imported = { name: file.name, text: await file.text() };
      return importResult;
    },
    listScenes() {
      return [{ id: 'scene-1', title: 'One' }];
    },
    getPlaybackStatus() {
      return { running: this.running };
    },
    startScene(sceneId) {
      this.running = true;
      this.startedWith = sceneId;
      return new Promise((resolve) => {
        finishRun = (cancelled) => {
          this.running = false;
          this._lastRun = {
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:05.000Z',
            estimatedDurationSec: 5,
            wasCancelled: cancelled,
          };
          resolve({ started: true, shots: 2 });
        };
      });
    },
    stopScene(reason) {
      this.stopped.push(reason);
      if (this.running) finishRun(true);
    },
  };
  return { director, finish: (cancelled = false) => finishRun(cancelled) };
}

test('importScene wraps a JSON object as a File for importProjectFile', async () => {
  const { director } = fakeDirector();
  const api = createDirectorAutomation(director, { target: new EventTarget() });
  const scenes = await api.importScene({ version: 4, scenes: [] });
  assert.equal(director.imported.name, 'automation-scene.json');
  assert.deepEqual(JSON.parse(director.imported.text), {
    version: 4,
    scenes: [],
  });
  assert.deepEqual(scenes, [{ id: 'scene-1', title: 'One' }]);
});

test('importScene rejects with the director status when import fails', async () => {
  const { director } = fakeDirector({ importResult: false });
  const api = createDirectorAutomation(director, { target: new EventTarget() });
  await assert.rejects(api.importScene('{}'), /bad version/);
});

test('play resolves and dispatches the finished event when the run ends', async () => {
  const { director, finish } = fakeDirector();
  const target = new EventTarget();
  const api = createDirectorAutomation(director, { target });
  const events = [];
  target.addEventListener(DIRECTOR_FINISHED_EVENT, (event) =>
    events.push(event.detail),
  );
  const run = api.play('scene-1');
  assert.equal(api.running, true);
  assert.equal(api.play(), run, 'a second play() joins the current run');
  assert.equal(api.whenFinished(), run);
  finish(false);
  const result = await run;
  assert.equal(result.started, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.endedAt, '2026-01-01T00:00:05.000Z');
  assert.deepEqual(events, [result]);
  assert.equal(await api.whenFinished(), result);
});

test('stop cancels the run and resolves with a cancelled result', async () => {
  const { director } = fakeDirector();
  const api = createDirectorAutomation(director, { target: new EventTarget() });
  const run = api.play();
  const result = await api.stop();
  assert.equal(director.stopped.length, 1);
  assert.equal(result.cancelled, true);
  assert.equal(await run, result);
});
