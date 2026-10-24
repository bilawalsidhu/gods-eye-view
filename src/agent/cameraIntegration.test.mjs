import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createAgentSession } from './agentLoop.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import {
  getActiveCameraMotion,
  interruptCameraMotion,
} from '../cameraVerbs.js';
import { GLOBE_VIEW } from '../locations.js';
import { buildAgentInstructions } from '../../server/providers/agent/instructions.js';

// Real Cesium camera and shipped action runner, without GPU/imagery. Only
// model replies are scripted: these tests do not certify live model routing.
function cameraHarness(
  t,
  { height = GLOBE_VIEW.heightM, width = 1280, reset } = {},
) {
  let now = 0;
  const performance = globalThis.performance;
  globalThis.performance = { now: () => now };
  const canvas = Object.assign(new EventTarget(), {
    width,
    height: 800,
    clientWidth: width,
    clientHeight: 800,
  });
  const scene = {
    canvas,
    drawingBufferWidth: width,
    drawingBufferHeight: 800,
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    mapProjection: new Cesium.GeographicProjection(),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    tweens: [],
    requestRender() {},
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  const setHeight = (value) =>
    camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(0, 15, value),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  setHeight(height);
  const viewer = {
    camera,
    scene,
    trackedEntityChanged: new Cesium.Event(),
    clock: { onTick: new Cesium.Event() },
  };
  const calls = [];
  const runner = createGevActionRunner({
    viewer,
    dataManager: { layers: new Map() },
    styleManager: {
      runImmediateNavigation: (_noun, navigate) => navigate(),
      resetToGlobeView:
        reset ||
        (() => {
          setHeight(GLOBE_VIEW.heightM);
          return { ok: true, action: 'zoom_to_globe' };
        }),
    },
  });
  const runAction = async (...args) => {
    calls.push(args[0]);
    return runner(...args);
  };
  t.after(() => {
    interruptCameraMotion('cleanup');
    globalThis.performance = performance;
  });
  return {
    camera,
    canvas,
    calls,
    runAction,
    setHeight,
    tick: () => {
      now += 100;
      viewer.clock.onTick.raiseEvent(viewer.clock);
    },
  };
}

const call = (name, args = {}) => ({ name, args });
const spin = (args = {}) =>
  call('move_camera', { motion: 'rotate_globe', ...args });
function relay(batches) {
  const posts = [];
  return Object.assign(
    async (_url, init) => {
      posts.push(JSON.parse(init.body));
      const batch = batches.shift();
      assert.ok(batch, 'unexpected inference after terminal refusal');
      if (typeof batch === 'string')
        return Response.json({
          message: { role: 'assistant', content: batch },
          toolCalls: [],
        });
      const toolCalls = batch.map((entry, i) => ({
        ...entry,
        id: `call-${posts.length}-${i}`,
      }));
      return Response.json({
        message: {
          role: 'assistant',
          content: 'Camera already moved!',
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        toolCalls,
      });
    },
    { posts },
  );
}
const results = (session) =>
  session.transcript
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(m.content));
const position = (camera) => Cesium.Cartesian3.clone(camera.positionWC);
const distance = (camera, before) =>
  Cesium.Cartesian3.distance(camera.positionWC, before);

test('typed rotation changes real camera direction/speed, then explicit stop freezes its resulting pose', async (t) => {
  const h = cameraHarness(t);
  const fetchImpl = relay([
    [spin()],
    'Rotating right.',
    [spin({ direction: 'left', speed: 'slow' })],
    'Rotating left slowly.',
    [spin({ direction: 'left', speed: 'fast' })],
    'Rotating left fast.',
    [call('move_camera', { motion: 'stop' })],
    'Camera stopped.',
  ]);
  const session = createAgentSession({ runAction: h.runAction, fetchImpl });
  const send = (text) =>
    session.send(text, { provider: 'chatgpt', model: 'fixture' });
  await send('Rotate the globe');
  assert.equal(results(session).at(-1).mode, 'continuous');
  const before = position(h.camera);
  h.tick();
  assert.ok(distance(h.camera, before) > 0);
  const right = position(h.camera);
  await send('Ahora hacia la izquierda, despacio');
  assert.equal(results(session).at(-1).direction, 'left');
  h.tick();
  const slowDistance = distance(h.camera, right);
  const slowDelta = Cesium.Cartesian3.subtract(
    h.camera.positionWC,
    right,
    new Cesium.Cartesian3(),
  );
  const rightDelta = Cesium.Cartesian3.subtract(
    right,
    before,
    new Cesium.Cartesian3(),
  );
  assert.ok(Cesium.Cartesian3.dot(slowDelta, rightDelta) < 0);
  await send('Más rápido hacia la izquierda');
  const fastStart = position(h.camera);
  h.tick();
  assert.ok(distance(h.camera, fastStart) > slowDistance);
  await send('Detené la cámara');
  assert.equal(results(session).at(-1).stopped, true);
  assert.equal(getActiveCameraMotion(), null);
  const stopped = position(h.camera);
  h.tick();
  assert.equal(distance(h.camera, stopped), 0);
  assert.ok(
    distance(h.camera, before) > 0,
    'stop must not undo prior movement',
  );
  assert.equal(fetchImpl.posts.at(-1).messages.at(-1).role, 'tool');
});

for (const [width, reason, guidance] of [
  [1280, 'globe-view-required', /Reset to Globe View/],
  [4000, 'globe-reset-unavailable', /Zoom out further/],
])
  test(`typed refusal at width ${width} blocks sibling reset and all later inference`, async (t) => {
    const h = cameraHarness(t, { height: 1000, width });
    const before = position(h.camera);
    const batches = [[spin(), call('zoom_to_globe'), spin()]];
    const fetchImpl = relay(batches);
    const session = createAgentSession({ runAction: h.runAction, fetchImpl });
    const events = [];
    const reply = await session.send('Rotate the globe', {
      onEvent: (event) => events.push(event),
    });
    assert.equal(reply.ok, false);
    assert.match(reply.content, guidance);
    assert.equal(results(session)[0].reason, reason);
    assert.deepEqual(h.calls, ['move_camera']);
    assert.equal(results(session).length, 3);
    assert.ok(
      results(session)
        .slice(1)
        .every((r) => r.skipped),
    );
    assert.equal(distance(h.camera, before), 0);
    assert.equal(fetchImpl.posts.length, 1);
    assert.ok(
      !events.some((e) => e.message?.content === 'Camera already moved!'),
    );
    assert.equal(session.transcript.find((m) => m.tool_calls)?.content, '');
    // Only a fresh explicit user command releases the terminal refusal.
    if (width === 1280) {
      batches.push([call('zoom_to_globe'), spin()], 'Rotating.');
      assert.equal(
        (await session.send('Reset to Globe View and rotate the globe')).ok,
        true,
      );
      assert.deepEqual(h.calls, [
        'move_camera',
        'zoom_to_globe',
        'move_camera',
      ]);
    }
  });

test('explicit reset-and-rotate awaits successful reset in a separate model round', async (t) => {
  const h = cameraHarness(t, { height: 1000 });
  const fetchImpl = relay([[call('zoom_to_globe')], [spin()], 'Rotating.']);
  const session = createAgentSession({ runAction: h.runAction, fetchImpl });
  assert.equal(
    (await session.send('Reset to Globe View and rotate the globe')).ok,
    true,
  );
  assert.deepEqual(h.calls, ['zoom_to_globe', 'move_camera']);
  const before = position(h.camera);
  h.tick();
  assert.ok(distance(h.camera, before) > 0);
});

for (const outcome of ['failed', 'cancelled', 'thrown'])
  test(`a ${outcome} reset blocks same-response rotation and model retries`, async (t) => {
    const h = cameraHarness(t, {
      reset: () => {
        if (outcome === 'thrown') throw new Error('reset failed');
        return {
          ok: outcome === 'cancelled',
          cancelled: outcome === 'cancelled',
          action: 'zoom_to_globe',
        };
      },
    });
    const session = createAgentSession({
      runAction: h.runAction,
      fetchImpl: relay([[call('zoom_to_globe'), spin()]]),
    });
    const reply = await session.send(
      'Reset to Globe View and rotate the globe',
    );
    assert.equal(reply.ok, false);
    assert.match(reply.content, /reset did not finish/);
    assert.deepEqual(h.calls, ['zoom_to_globe']);
    assert.equal(getActiveCameraMotion(), null);
  });

for (const navigation of [
  call('zoom_to_globe'),
  call('adjust_camera_zoom', { direction: 'out', amount: 'little' }),
]) {
  test(`typed ${navigation.name} interrupts rotation before navigating`, async (t) => {
    const h = cameraHarness(t);
    const session = createAgentSession({
      runAction: h.runAction,
      fetchImpl: relay([
        [spin()],
        'Rotating.',
        [navigation],
        'Navigation finished.',
      ]),
    });
    await session.send('Rotate the globe');
    assert.ok(getActiveCameraMotion());
    await session.send('Zoom out');
    assert.equal(getActiveCameraMotion(), null);
  });
}

test('manual camera input interrupts rotation started from text', async (t) => {
  const h = cameraHarness(t);
  const session = createAgentSession({
    runAction: h.runAction,
    fetchImpl: relay([[spin()], 'Rotating.']),
  });
  await session.send('Rotate the globe');
  h.canvas.dispatchEvent(new Event('pointerdown'));
  assert.equal(getActiveCameraMotion(), null);
});

test('STOP during a pending reset propagates abort and prevents its dependent rotation', async (t) => {
  let finish;
  const h = cameraHarness(t, {
    reset: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  let options;
  const session = createAgentSession({
    runAction: (...args) => {
      options = args[2];
      return h.runAction(...args);
    },
    fetchImpl: relay([[call('zoom_to_globe'), spin()]]),
  });
  const pending = session.send('Reset to Globe View and rotate the globe');
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  session.abort();
  assert.equal(options.signal.aborted, true);
  assert.equal(options.isCurrent(), false);
  finish({ ok: true, action: 'zoom_to_globe' });
  assert.match((await pending).error, /cancelled/);
  assert.deepEqual(h.calls, ['zoom_to_globe']);
  assert.equal(results(session).length, 2);
  assert.equal(getActiveCameraMotion(), null);
});

test('STOP after rotation admission prevents siblings but leaves completed movement to explicit camera stop', async (t) => {
  const h = cameraHarness(t);
  const session = createAgentSession({
    runAction: h.runAction,
    fetchImpl: relay([[spin(), call('zoom_to_globe')]]),
  });
  const reply = await session.send('Rotate the globe', {
    onEvent: (event) => {
      if (event.type === 'tool-result' && event.result.ok) {
        h.tick();
        session.abort();
      }
    },
  });
  assert.match(reply.error, /cancelled/);
  assert.deepEqual(h.calls, ['move_camera']);
  assert.ok(
    getActiveCameraMotion(),
    'inference STOP cannot undo an admitted continuous motion',
  );
  await h.runAction('move_camera', { motion: 'stop' });
  assert.equal(getActiveCameraMotion(), null);
});

test('text manual preserves globe refusal, explicit-reset and resulting-state guidance', () => {
  const instructions = buildAgentInstructions();
  assert.match(instructions, /plain Rotate/);
  assert.match(instructions, /never from your own plan/);
  assert.match(instructions, /await reset success/);
  assert.match(instructions, /Confirm with the RESULTING state/);
});
