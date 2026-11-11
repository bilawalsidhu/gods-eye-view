import test from 'node:test';
import assert from 'node:assert/strict';
import { CockpitViewController } from './cockpitController.js';
import { COCKPIT_MIN_GROUND_CLEARANCE_M } from './cockpitPresentation.js';
import * as geo from '../geo/index.js';
import { createCockpitEngine } from '../testSupport/cockpitEngine.mjs';

function environment() {
  const original = { document: globalThis.document, window: globalThis.window };
  const document = Object.assign(new EventTarget(), {
    getElementById: () => null,
    querySelectorAll: () => [],
    body: { classList: { remove() {} } },
  });
  const window = Object.assign(new EventTarget(), { clearTimeout, setTimeout });
  globalThis.document = document;
  globalThis.window = window;
  const cockpit = createCockpitEngine();
  const { engine } = cockpit;
  // The Cockpit's frame and follow subscriptions.
  const subscriptions = () =>
    engine.frames.preUpdate.numberOfListeners +
    engine.camera.followChanged.numberOfListeners;
  return {
    engine,
    cockpit,
    subscriptions,
    restore() {
      engine.destroy();
      Object.assign(globalThis, original);
    },
  };
}

test('Cockpit subscriptions are released once and retained actions cannot restart it', () => {
  const env = environment();
  try {
    const before = env.subscriptions();
    const owner = new CockpitViewController(env.engine, { services: {} });
    assert.equal(env.subscriptions(), before + 2);
    let doubleClicks = 0;
    owner.onSceneDoubleClick = () => {
      doubleClicks++;
    };
    env.engine.fake.input('doubleClick', { position: { x: 1, y: 1 } });
    assert.equal(doubleClicks, 1);
    owner.dispose();
    owner.dispose();
    assert.equal(env.subscriptions(), before);
    env.engine.fake.input('doubleClick', { position: { x: 1, y: 1 } });
    assert.equal(doubleClicks, 1, 'the double-click route is released');
    assert.equal(owner.enter(), false);
    assert.equal(owner.navigateContext(1), false);
    assert.equal(owner.toggleTrackedTr3b(), false);
    assert.equal(owner.update(), false);
    assert.equal(owner.active, false);
  } finally {
    env.restore();
  }
});

test('orbital entry is offered through the engine without a native viewer', () => {
  const env = environment();
  try {
    const owner = new CockpitViewController(env.engine, {
      services: {
        flightsLayer: { getTrackedInfo: () => null },
        militaryFlightsLayer: { getTrackedInfo: () => null },
        satellitesLayer: {
          getCockpitSubject: () => ({ noradId: 25544, layerId: 'satellites' }),
          setCockpitSubject: () => true,
        },
        isTr3b: () => false,
      },
      isOrbitEntryAllowed: () => true,
    });
    owner.syncEntry();
    assert.equal(owner.presence.entryAvailable, true);
    assert.equal(owner.presence.entryKind, 'satellite');
    assert.equal(owner.orbital, null);
    assert.equal(env.engine.input.cameraInputsEnabled(), true);
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('disposing an active Cockpit releases the supplied render owner without retracking', () => {
  const env = environment();
  try {
    const released = [];
    const owner = new CockpitViewController(env.engine, {
      services: { releaseContinuousRender: (reason) => released.push(reason) },
    });
    const ridden = env.cockpit.aircraft();
    owner.host.inputs(false);
    ridden.show = false;
    Object.assign(owner, { active: true, trackedEntity: ridden });
    owner.dispose();
    owner.dispose();
    assert.deepEqual(released, ['cockpit']);
    assert.equal(env.engine.fake.cameraInputsEnabled, true);
    assert.equal(ridden.show, true, 'the ridden glyph is shown again');
    assert.equal(env.engine.camera.following(), null, 'and not followed');
    assert.equal(owner.active, false);
  } finally {
    env.restore();
  }
});

test('aircraft identity is read from the supplied layer instances', () => {
  const env = environment();
  try {
    const civilian = {
      icao24: 'abc123',
      layerId: 'flights',
      callsign: 'CIVIL',
    };
    const military = {
      icao24: 'def456',
      layerId: 'military',
      callsign: 'MILITARY',
    };
    const owner = new CockpitViewController(env.engine, {
      services: {
        flightsLayer: { getTrackedInfo: () => civilian },
        militaryFlightsLayer: { getTrackedInfo: () => military },
        // A follow change syncs the entry and its TR-3B chip.
        isTr3b: () => false,
      },
    });
    env.cockpit.ride(env.cockpit.aircraft({ gevTrackedId: 'military:def456' }));
    assert.deepEqual(owner.readAircraftInfo(), military);
    env.cockpit.ride(env.cockpit.aircraft({ gevTrackedId: 'flights:abc123' }));
    assert.deepEqual(owner.readAircraftInfo(), civilian);
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('an obsolete regional briefing cannot publish after Cockpit disposal', async () => {
  const env = environment();
  try {
    let finish;
    let signal;
    const owner = new CockpitViewController(env.engine, {
      services: {
        regionalDistanceM: () => Infinity,
        fetchRegionalBrief: (_lat, _lon, options) => {
          signal = options.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        releaseContinuousRender() {},
      },
    });
    const published = [];
    owner.renderRegionalBrief = (payload) => published.push(payload);
    owner.active = true;
    owner.maybeRefreshRegionalBrief({
      layerId: 'flights',
      icao24: 'abc123',
      latitude: 30,
      longitude: -97,
    });
    owner.dispose();
    assert.equal(signal.aborted, true);
    finish({ articles: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(published, []);
    assert.equal(owner.regionalBriefAbort, null);
  } finally {
    env.restore();
  }
});

test('stopping Cockpit revokes camera actions before deferred disposal releases rendering', () => {
  const env = environment();
  try {
    const released = [];
    const before = env.subscriptions();
    const owner = new CockpitViewController(env.engine, {
      services: {
        releaseContinuousRender: (reason) => released.push(reason),
      },
    });
    owner.active = true;
    owner.stop();
    assert.equal(env.subscriptions(), before);
    assert.equal(owner.update(), false);
    assert.equal(owner.navigateContext(1), false);
    assert.deepEqual(released, []);
    owner.dispose();
    assert.deepEqual(released, ['cockpit']);
    assert.equal(owner.active, false);
  } finally {
    env.restore();
  }
});

test('stopped Cockpit cannot rearm briefing rotation or request a fresh region', () => {
  const env = environment();
  try {
    const frames = new Map();
    let next = 0;
    let fetches = 0;
    let paints = 0;
    window.setTimeout = (callback) => {
      frames.set(++next, callback);
      return next;
    };
    window.clearTimeout = (id) => frames.delete(id);
    const owner = new CockpitViewController(env.engine, {
      services: {
        regionalDistanceM: () => Infinity,
        fetchRegionalBrief: () => {
          fetches++;
          return Promise.resolve({ articles: [] });
        },
        releaseContinuousRender() {},
      },
    });
    owner.active = true;
    owner.showBriefPage = () => {
      paints++;
    };
    owner.setBriefAutoRotate(true);
    assert.equal(frames.size, 1);
    const queued = [...frames.values()][0];
    owner.stop();
    assert.equal(frames.size, 0);
    queued();
    owner.setBriefAutoRotate(true);
    owner.startBriefRotation();
    owner.maybeRefreshRegionalBrief({ latitude: 30, longitude: -97 });
    assert.equal(frames.size, 0);
    assert.equal(paints, 0);
    assert.equal(fetches, 0);
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('the weather toggle flips from its own state, however fast it is pressed', () => {
  const env = environment();
  try {
    const toggle = new EventTarget();
    document.getElementById = (id) =>
      id === 'cockpit-weather-toggle' ? toggle : null;
    const requested = [];
    window.addEventListener('gev:cockpit-weather-toggle', (event) =>
      requested.push(event.detail.enabled),
    );
    const published = [];
    const owner = new CockpitViewController(env.engine, {
      services: {},
      publish: { context: (view) => published.push(view.weather) },
    });
    // Two presses before any view renders still alternate.
    toggle.dispatchEvent(new Event('click'));
    toggle.dispatchEvent(new Event('click'));
    assert.deepEqual(requested, [true, false]);
    assert.deepEqual(published, [true, false]);
    // The effects owner reports its state; the next press flips that.
    window.dispatchEvent(
      new CustomEvent('gev:cockpit-weather-state', {
        detail: { enabled: true },
      }),
    );
    toggle.dispatchEvent(new Event('click'));
    assert.deepEqual(requested, [true, false, false]);
    assert.deepEqual(published, [true, false, true, false]);
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('the cockpit eye stays above the engine surface when the aircraft reads below it', () => {
  const env = environment();
  try {
    // A landing contact whose reported height is 13 m under the terrain, on
    // a cell the ground floors have not sampled yet. Cesium lifts a camera
    // under its globe every frame, between the cockpit's 20 Hz updates, so
    // an eye below the surface jumped up and down.
    const SURFACE_M = 120;
    const place = { longitude: -1.7047, latitude: 0.5268 };
    const aircraft = geo.cartesian3.fromRadians(
      place.longitude,
      place.latitude,
      107,
    );
    env.engine.fake.script('terrainHeight', SURFACE_M);
    const entity = env.cockpit.aircraft({ position: aircraft });
    const owner = new CockpitViewController(env.engine, {
      services: {
        cachedGroundFloor: () => undefined,
        GROUND_FLOOR_LIFT_M: 1.5,
      },
    });
    Object.assign(owner, {
      active: true,
      trackedEntity: entity,
      readAircraftInfo: () => ({
        latitude: geo.math.toDegrees(place.latitude),
        longitude: geo.math.toDegrees(place.longitude),
        track: 180,
        velocityMps: 70,
        onGround: false,
      }),
      _adoptTrackedEntity() {},
      updateHud() {},
    });
    owner.update();
    const views = env.engine.fake
      .callsOf('camera.setView')
      .map(
        ({ args: [{ destination }] }) =>
          geo.cartographic.fromCartesian(destination).height,
      );
    assert.equal(views.length, 1);
    assert.ok(
      views[0] >= SURFACE_M + COCKPIT_MIN_GROUND_CLEARANCE_M - 1e-6,
      `eye at ${views[0]} m, surface at ${SURFACE_M} m`,
    );
    owner.active = false;
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('locale changes relocalize the cockpit until it is disposed', async () => {
  const { getLocale, setLocale } = await import('../i18n/index.js');
  const locale = getLocale();
  const env = environment();
  const owner = new CockpitViewController(env.engine, { services: {} });
  let updates = 0;
  owner.relocalize = () => updates++;
  try {
    setLocale(locale === 'de' ? 'en' : 'de');
    assert.equal(updates, 1);
    owner.dispose();
    setLocale(locale);
    assert.equal(updates, 1);
  } finally {
    owner.dispose();
    setLocale(locale);
    env.restore();
  }
});
