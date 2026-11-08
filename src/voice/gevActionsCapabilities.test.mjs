import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { getActiveCameraMotion, releaseCameraVerbs } from '../cameraVerbs.js';
import { createGevActionRunner, UNAVAILABLE_ON_ENGINE } from './gevActions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

globalThis.window ||= { setTimeout, clearTimeout, requestIdleCallback: null };

const route = {
  type: 'route',
  label: 'walk',
  path: [
    { lat: 30, lon: 10 },
    { lat: 30.01, lon: 10 },
  ],
};

function fixture(t, kind, { native = kind === 'cesium' } = {}) {
  const engine = createFakeEngine({
    kind,
    canvas: new EventTarget(),
    visualStyles: { thermal: [] },
    bloom: true,
    contactSonar: true,
  });
  let viewer;
  if (native) {
    const scene = {
      canvas: Object.assign(new EventTarget(), {
        clientWidth: 1280,
        clientHeight: 800,
      }),
      drawingBufferWidth: 1280,
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
    camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(10, 30, 5000),
    });
    viewer = { scene, camera, clock: { onTick: new Cesium.Event() } };
  }
  const calls = [];
  const annotations = {
    attached: true,
    list: () => [route],
    annotate: async (...args) => {
      calls.push(['annotate', ...args]);
      return { drawn: 1, failed: 0, results: [{ ok: true }] };
    },
    clear: () => calls.push(['clear']),
  };
  const styleManager = {
    runImmediateNavigation: (noun, navigate) => navigate(),
    setStyle: (style) => {
      calls.push(['style', style]);
      if (!native && style !== 'normal')
        engine.render.setStyle(style, { intensity: 1 });
    },
    setBloom: (options) => {
      calls.push(['bloom', options]);
      if (!native) engine.render.setBloom({ enabled: options.enabled });
      return { ok: true, bloom: options };
    },
    setSharpen: (options) => {
      calls.push(['sharpen', options]);
      engine.render.setSharpen({ enabled: options.enabled });
      return { ok: true, sharpen: options };
    },
    setCyberSonar: (options) => {
      calls.push(['sonar', options]);
      if (!native) engine.render.setContactSonar(options);
      return { ok: true, ...options };
    },
  };
  const build = (options = {}) =>
    createGevActionRunner({
      viewer,
      engine,
      annotations,
      styleManager,
      dataManager: { layers: new Map() },
      ...options,
      floorServices: { cachedGroundFloor: () => 0, warmGroundFloor: () => {} },
    });
  t.after(() => releaseCameraVerbs(engine));
  return { engine, viewer, annotations, styleManager, calls, build };
}

const cases = [
  [
    'annotate_map',
    { annotations: [{ type: 'pin', latitude: 30, longitude: 10 }] },
    'annotate',
  ],
  ['clear_annotations', {}, 'clear'],
  ['move_camera', { motion: 'pan', direction: 'left' }, null],
  ['fly_route', {}, null],
  ['set_visual_style', { style: 'thermal' }, 'style'],
  [
    'set_post_processing',
    { bloom: { enabled: true }, sharpen: { enabled: true } },
    'bloom',
  ],
  ['set_cyber_sonar', { enabled: true }, 'sonar'],
];

for (const kind of ['cesium', 'navara']) {
  for (const [action, args, call] of cases) {
    test(`${kind}: ${action} runs with its capability and reports the engine`, async (t) => {
      const f = fixture(t, kind);
      assert.ok(GEV_REALTIME_TOOLS.some((tool) => tool.name === action));
      const result = await f.build()(action, args);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.engine, kind);
      // The camera verbs drive the engine on both.
      if (call) assert.equal(f.calls[0][0], call);
      if (action === 'set_post_processing') {
        assert.deepEqual(
          f.calls.map(([name]) => name),
          ['bloom', 'sharpen'],
        );
        assert.equal(result.effects.bloom.ok, true);
        assert.equal(result.effects.sharpen.ok, true);
      }
      if (!f.viewer && action === 'set_cyber_sonar')
        assert.equal(f.engine.render.contactSonar().enabled, true);
      if (!f.viewer && action === 'set_visual_style')
        assert.equal(f.engine.render.style('thermal').intensity, 1);
    });

    test(`${kind}: ${action} refuses a missing capability without side effects`, async (t) => {
      const f = fixture(t, kind);
      if (action === 'annotate_map') delete f.annotations.annotate;
      if (action === 'clear_annotations') delete f.annotations.clear;
      if (action === 'fly_route') delete f.annotations.list;
      if (action === 'move_camera') f.engine.destroy();
      if (action === 'set_visual_style') {
        if (f.viewer) delete f.styleManager.setStyle;
        else delete f.engine.render.setStyle;
      }
      if (action === 'set_post_processing') {
        if (f.viewer) {
          delete f.styleManager.setBloom;
          delete f.styleManager.setSharpen;
        } else {
          delete f.engine.render.setBloom;
          delete f.engine.render.setSharpen;
        }
      }
      if (action === 'set_cyber_sonar') {
        if (f.viewer) delete f.styleManager.setCyberSonar;
        else delete f.engine.render.setContactSonar;
      }
      const run = f.build();
      f.engine.fake.resetCalls();
      const result = await run(action, args);
      assert.equal(result.ok, false);
      assert.equal(result.code, UNAVAILABLE_ON_ENGINE);
      assert.equal(result.unavailable, true);
      assert.equal(result.engine, kind);
      assert.equal(result.suggestion, '?engine=cesium');
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.engine.fake.calls, []);
    });
  }

  for (const action of ['annotate_map', 'clear_annotations', 'fly_route']) {
    test(`${kind}: ${action} refuses a detached annotation board`, async (t) => {
      const f = fixture(t, kind);
      f.annotations.attached = false;
      const result = await f.build()(
        action,
        cases.find(([name]) => name === action)[1],
      );
      assert.equal(result.code, UNAVAILABLE_ON_ENGINE);
      assert.deepEqual(f.calls, []);
    });
  }

  test(`${kind}: fly_route also requires camera verbs`, async (t) => {
    const f = fixture(t, kind);
    f.engine.destroy();
    assert.equal((await f.build()('fly_route')).code, UNAVAILABLE_ON_ENGINE);
  });

  test(`${kind}: control_scene requires an attached director`, async (t) => {
    const f = fixture(t, kind);
    const missing = await f.build()('control_scene', { action: 'status' });
    assert.equal(missing.code, UNAVAILABLE_ON_ENGINE);
    assert.equal(missing.engine, kind);
    const result = await f.build({
      sceneDirector: {
        getPlaybackStatus: () => ({ running: false }),
      },
    })('control_scene', { action: 'status' });
    assert.equal(result.ok, true);
    assert.equal(result.engine, kind);
    assert.equal(result.running, false);
  });

  for (const missing of ['bloom', 'sharpen']) {
    test(`${kind}: post-processing reports unsupported ${missing} and applies the other effect`, async (t) => {
      const f = fixture(t, kind);
      const method = missing === 'bloom' ? 'setBloom' : 'setSharpen';
      delete (f.viewer ? f.styleManager : f.engine.render)[method];
      const result = await f.build()('set_post_processing', {
        bloom: { enabled: true },
        sharpen: { enabled: true },
      });
      const supported = missing === 'bloom' ? 'sharpen' : 'bloom';
      assert.equal(result.ok, false);
      assert.equal(result.partial, true);
      assert.equal(result.engine, kind);
      assert.equal(result.effects[missing].code, UNAVAILABLE_ON_ENGINE);
      assert.equal(result.effects[supported].ok, true);
      assert.match(result.error, new RegExp(missing));
      assert.deepEqual(
        f.calls.map(([name]) => name),
        [supported],
      );
    });
  }
}

test('Navara refuses a style absent from its visualStyles list', async (t) => {
  const f = fixture(t, 'navara');
  assert.equal(
    (await f.build()('set_visual_style', { style: 'anime' })).code,
    UNAVAILABLE_ON_ENGINE,
  );
  assert.deepEqual(f.calls, []);
});

test('post-processing keeps a controller failure when the next effect succeeds', async (t) => {
  const f = fixture(t, 'navara');
  f.styleManager.setBloom = () => ({ ok: false, error: 'Bloom failed' });
  const result = await f.build()('set_post_processing', {
    bloom: { enabled: true },
    sharpen: { enabled: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.error, 'Bloom failed');
  assert.equal(result.effects.sharpen.ok, true);
});
