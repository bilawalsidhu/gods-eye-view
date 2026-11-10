import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneRunner, engineSwitchingRefusal } from './sceneRunner.js';

const engine = (kind) => createFakeEngine({ kind });

function runnerFor(log) {
  return (scene) => {
    const run = async (name, args, options) => {
      log.push({ name, kind: scene.engine.kind, signal: options.signal });
      return { ok: true, action: name };
    };
    run.dispose = () => log.push({ disposed: scene.engine.kind });
    run.resetConversation = () => log.push({ reset: scene.engine.kind });
    return run;
  };
}

test('calls run on the attached engine and say which engine answered', async () => {
  const log = [];
  const run = createSceneRunner({ build: runnerFor(log) });
  run.attach({ engine: engine('cesium') });
  assert.deepEqual(await run('set_layer', {}), {
    ok: true,
    action: 'set_layer',
    engine: 'cesium',
  });
  run.attach({ engine: engine('navara') });
  assert.equal((await run('set_layer', {})).engine, 'navara');
  assert.deepEqual(log[1], { disposed: 'cesium' });
  assert.equal(run.engineKind(), 'navara');
});

test('a call during a switch waits for the next engine and runs there', async () => {
  const log = [];
  let switching = false;
  const run = createSceneRunner({
    build: runnerFor(log),
    isSwitching: () => switching,
  });
  run.attach({ engine: engine('cesium') });
  switching = true;
  const pending = run('set_layer', {});
  run.detach();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(log.filter((entry) => entry.name).length, 0);
  run.attach({ engine: engine('navara') });
  const result = await pending;
  assert.equal(result.engine, 'navara');
  switching = false;
});

test('a call refused when no engine attaches in time names ENGINE_SWITCHING', async () => {
  const run = createSceneRunner({
    build: runnerFor([]),
    isSwitching: () => true,
    switchWaitMs: 10,
  });
  run.attach({ engine: engine('cesium') });
  run.detach();
  const result = await run('annotate_map', {});
  assert.deepEqual(result, engineSwitchingRefusal('annotate_map'));
  assert.equal(result.code, 'ENGINE_SWITCHING');
});

test('a switch that settles without a new engine lets waiting calls run', async () => {
  const log = [];
  let switching = true;
  const run = createSceneRunner({
    build: runnerFor(log),
    isSwitching: () => switching,
  });
  run.attach({ engine: engine('cesium') });
  const pending = run('set_layer', {});
  switching = false;
  run.wake();
  assert.equal((await pending).engine, 'cesium');
});

test('the attachment signal aborts calls in flight when the engine detaches', async () => {
  let seen;
  const run = createSceneRunner({
    build: () => async (name, args, options) => {
      seen = options.signal;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: !options.signal.aborted };
    },
  });
  run.attach({ engine: engine('cesium') });
  const pending = run('fly_to_location', {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  run.detach();
  assert.equal(seen.aborted, true);
  assert.equal((await pending).ok, false);
});

test('a disposed runner refuses and wakes its waiting calls', async () => {
  const run = createSceneRunner({
    build: runnerFor([]),
    isSwitching: () => true,
  });
  const pending = run('set_layer', {});
  run.dispose();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal((await run('set_layer', {})).cancelled, true);
});
