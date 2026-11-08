import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PARAMS,
  SIMULATION_LAYER_ID,
  createSimulationLayer,
} from './index.js';

const bundled = JSON.parse(
  readFileSync(
    new URL('../../../public/scenarios/fleet-week-sf.json', import.meta.url),
    'utf8',
  ),
);

/** Enough of Cesium for the layer; no WebGL. */
function fakeCesium() {
  class Cartesian3 {
    constructor(x, y, z) {
      Object.assign(this, { x, y, z });
    }
    static fromDegrees(lon, lat, height) {
      return new Cartesian3(lon, lat, height);
    }
  }
  class Color {
    constructor(css) {
      this.css = css;
      this.alpha = 1;
    }
    static fromCssColorString(css) {
      return new Color(css);
    }
    withAlpha(alpha) {
      const next = new Color(this.css);
      next.alpha = alpha;
      return next;
    }
  }
  Color.WHITE = new Color('#fff');
  Color.BLACK = new Color('#000');
  class CallbackProperty {
    constructor(fn, constant) {
      this.fn = fn;
      this.constant = constant;
    }
    getValue() {
      return this.fn();
    }
  }
  const simple = (name) =>
    class {
      constructor(...args) {
        this.name = name;
        this.args = args;
      }
    };
  return {
    Cartesian3,
    Color,
    CallbackProperty,
    Cartesian2: simple('Cartesian2'),
    HeadingPitchRoll: simple('HeadingPitchRoll'),
    HeadingPitchRange: simple('HeadingPitchRange'),
    BoundingSphere: simple('BoundingSphere'),
    NearFarScalar: simple('NearFarScalar'),
    PolylineGlowMaterialProperty: simple('PolylineGlow'),
    PolylineDashMaterialProperty: simple('PolylineDash'),
    LabelStyle: { FILL_AND_OUTLINE: 2 },
    VerticalOrigin: { BOTTOM: 1 },
    ArcType: { NONE: 0 },
    ColorBlendMode: { MIX: 1 },
    Math: {
      toRadians: (deg) => (deg * Math.PI) / 180,
      toDegrees: (rad) => (rad * 180) / Math.PI,
    },
    Transforms: {
      headingPitchRollQuaternion: (position, hpr) => ({ position, hpr }),
    },
  };
}

function fakeViewer() {
  const entities = [];
  const preUpdate = new Set();
  const flights = [];
  return {
    entities: {
      items: entities,
      add(options) {
        const entity = { ...options, show: options.show ?? true };
        entities.push(entity);
        return entity;
      },
      remove(entity) {
        const i = entities.indexOf(entity);
        if (i >= 0) entities.splice(i, 1);
        return i >= 0;
      },
    },
    scene: {
      renders: 0,
      requestRender() {
        this.renders += 1;
      },
      preUpdate: {
        addEventListener(fn) {
          preUpdate.add(fn);
          return () => preUpdate.delete(fn);
        },
      },
    },
    camera: {
      flights,
      flyToBoundingSphere(sphere, options) {
        flights.push({ sphere, options });
      },
    },
    tick() {
      for (const fn of preUpdate) fn();
    },
    listeners: preUpdate,
  };
}

function fakeServices() {
  const holds = new Set();
  return {
    holds,
    render: {
      holdContinuousRender: (id) => holds.add(id),
      releaseContinuousRender: (id) => holds.delete(id),
      governorRequestRender: () => {},
    },
  };
}

function harness({ scenario = bundled, wallStart = 50_000 } = {}) {
  let wall = wallStart;
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const services = fakeServices();
  const loads = [];
  const layer = createSimulationLayer({
    services,
    cesium,
    now: () => wall,
    resolveAsset: (url) => `/base${url}`,
    loadScenario: async (id) => {
      loads.push(id);
      if (id === 'missing') throw new Error('HTTP 404');
      return structuredClone(scenario);
    },
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    services,
    loads,
    cesium,
    advance(ms) {
      wall += ms;
    },
  };
}

test('enable loads the scenario, builds three entities per aircraft and holds rendering while playing', async () => {
  const h = harness();
  assert.equal(await h.layer.enable(), true);
  assert.deepEqual(h.loads, ['fleet-week-sf']);
  const aircraft = bundled.aircraft.length;
  assert.equal(h.viewer.entities.items.length, aircraft * 3);
  assert.ok(h.services.holds.has(SIMULATION_LAYER_ID));
  const diagnostics = h.layer.diagnostics();
  assert.equal(diagnostics.scenario, 'fleet-week-sf');
  assert.equal(diagnostics.aircraft.length, aircraft);
  assert.equal(diagnostics.clock.playing, true);
  assert.equal(diagnostics.clock.loop, false, 'one finite approach makes the clock finite');
  assert.ok(diagnostics.clock.durationS > 60);
  assert.deepEqual(h.layer.getStats(), { count: aircraft, error: null, loading: false });

  // Models come from the shared hangar through the asset resolver.
  const heavy = h.viewer.entities.items.find((e) => e.id === 'simulation:united-heavy');
  assert.equal(heavy.model.uri, '/base/models/b789.glb');
  assert.equal(heavy.model.scale, 1);
  const jet = h.viewer.entities.items.find((e) => e.id === 'simulation:angel1');
  assert.equal(jet.model.uri, '/base/models/airplane.glb');
  assert.equal(jet.label.text, 'ANGEL1');

  // Position and orientation are callback properties over the per-frame sample.
  const position = heavy.position.getValue();
  assert.ok(Number.isFinite(position.x) && Number.isFinite(position.z));
  assert.ok(Math.abs(position.x - -122.78) < 1e-6, 'starts at the first waypoint');
  const orientation = heavy.orientation.getValue();
  assert.equal(orientation.position, position);
  assert.ok(orientation.hpr.args[0] > 0, 'heading carries the model offset');

  // The route line is static and the trail follows the clock.
  const route = h.viewer.entities.items.find((e) => e.id === 'simulation:united-heavy:route');
  assert.ok(route.polyline.positions.length > 20);
  assert.equal(route.show, true);
  const trail = h.viewer.entities.items.find((e) => e.id === 'simulation:united-heavy:trail');
  assert.equal(trail.polyline.positions.getValue().length, 1, 'no history at t=0');
  h.advance(30_000);
  h.viewer.tick();
  const after = heavy.position.getValue();
  assert.ok(after.x > position.x, 'the approach moves east over 30 s');
  assert.equal(trail.polyline.positions.getValue().length, 31);
  const targets = h.layer.getTargets();
  assert.equal(targets.length, aircraft);
  assert.equal(targets.find((x) => x.id === 'united-heavy').position, after);

  h.layer.disable();
  assert.equal(h.viewer.entities.items.length, 0);
  assert.equal(h.services.holds.size, 0);
  assert.equal(h.viewer.listeners.size, 0);
});

test('pause releases the render hold and freezes the clock; rates and seeks apply', async () => {
  const h = harness();
  await h.layer.enable();
  h.layer.setParams({ playing: false });
  assert.equal(h.services.holds.size, 0);
  const frozen = h.layer.getClock().timeS;
  h.advance(10_000);
  h.viewer.tick();
  assert.equal(h.layer.getClock().timeS, frozen);
  h.layer.setParams({ playing: true, rate: 4 });
  assert.ok(h.services.holds.has(SIMULATION_LAYER_ID));
  h.advance(1000);
  assert.ok(Math.abs(h.layer.getClock().timeS - (frozen + 4)) < 1e-6);
  h.layer.setParams({ timeS: 42 });
  assert.ok(Math.abs(h.layer.getClock().timeS - 42) < 1e-6);
  assert.deepEqual(h.layer.getParams(), { ...DEFAULT_PARAMS, rate: 4 });
  const controls = h.layer.getRowControls();
  assert.equal(controls.slider.id, 'scenario-time');
  assert.equal(controls.slider.value, 42);
  assert.deepEqual(controls.slider.params('7'), { timeS: 7 });
  assert.equal(controls.segmented.options.find((o) => o.active).id, 'rate-4');
  assert.equal(controls.list.items.length, bundled.aircraft.length);
  assert.equal(controls.info, 'Fleet Week over San Francisco Bay');
});

test('focus flies the camera to an aircraft and marks it in the list', async () => {
  const h = harness();
  await h.layer.enable();
  h.layer.setParams({ focus: 'angel1' });
  assert.equal(h.viewer.camera.flights.length, 1);
  assert.equal(h.viewer.camera.flights[0].sphere.name, 'BoundingSphere');
  assert.equal(
    h.layer.getRowControls().list.items.find((i) => i.active).id,
    'angel1',
  );
  h.layer.setParams({ focus: 'nobody' });
  assert.equal(h.viewer.camera.flights.length, 1);
});

test('routes toggle and trail length are params; sampleAt answers any time', async () => {
  const h = harness();
  await h.layer.enable();
  h.layer.setParams({ routes: false, trailS: 10 });
  const route = h.viewer.entities.items.find((e) => e.id.endsWith(':route'));
  assert.equal(route.show, false);
  h.advance(60_000);
  h.viewer.tick();
  const trail = h.viewer.entities.items.find((e) => e.id === 'simulation:angel1:trail');
  assert.equal(trail.polyline.positions.getValue().length, 11);
  const late = h.layer.sampleAt('united-heavy', 1e6);
  assert.equal(late.done, true);
  assert.equal(h.layer.sampleAt('nobody', 0), null);
  assert.equal(h.layer.getParams().trailS, 10);
  h.layer.setParams({ trailS: 99_999 });
  assert.equal(h.layer.getParams().trailS, 600);
});

test('a failed scenario load reports an error and leaves no entities', async () => {
  const h = harness();
  h.layer.setParams({ scenario: 'missing' });
  assert.equal(await h.layer.enable(), false);
  assert.equal(h.viewer.entities.items.length, 0);
  assert.match(h.layer.getStats().error, /missing.*404/);
  assert.equal(h.services.holds.size, 0);
  // A scenario change while enabled reloads.
  h.layer.setParams({ scenario: 'fleet-week-sf' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.viewer.entities.items.length, bundled.aircraft.length * 3);
  h.layer.setParams({ scenario: '../etc/passwd' });
  assert.equal(h.layer.getParams().scenario, 'fleet-week-sf');
});

test('a disable during the load leaves nothing behind', async () => {
  let release;
  const h = harness();
  const layer = createSimulationLayer({
    services: h.services,
    cesium: h.cesium,
    loadScenario: () =>
      new Promise((resolve) => {
        release = () => resolve(structuredClone(bundled));
      }),
  });
  layer.init(h.viewer);
  const pending = layer.enable();
  layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(h.viewer.entities.items.length, 0);
  assert.equal(h.services.holds.size, 0);
  layer.destroy();
});
