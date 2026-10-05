import test from 'node:test';
import assert from 'node:assert/strict';
import { CockpitViewController } from './cockpitController.js';

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
  const callbacks = new Set();
  const event = {
    addEventListener(fn) {
      callbacks.add(fn);
      return () => callbacks.delete(fn);
    },
  };
  const viewer = {
    scene: {
      preUpdate: event,
      screenSpaceCameraController: { enableInputs: false },
    },
    trackedEntityChanged: event,
    entities: { contains: () => false },
  };
  return {
    viewer,
    callbacks,
    restore() {
      Object.assign(globalThis, original);
    },
  };
}

test('Cockpit subscriptions are released once and retained actions cannot restart it', () => {
  const env = environment();
  try {
    const owner = new CockpitViewController(env.viewer, { services: {} });
    assert.equal(env.callbacks.size, 2);
    owner.dispose();
    owner.dispose();
    assert.equal(env.callbacks.size, 0);
    assert.equal(owner.enter(), false);
    assert.equal(owner.navigateContext(1), false);
    assert.equal(owner.toggleTrackedTr3b(), false);
    assert.equal(owner.update(), false);
    assert.equal(owner.active, false);
  } finally {
    env.restore();
  }
});

test('disposing an active Cockpit releases the supplied render owner without retracking', () => {
  const env = environment();
  try {
    const released = [];
    const owner = new CockpitViewController(env.viewer, {
      services: { releaseContinuousRender: (reason) => released.push(reason) },
    });
    owner.active = true;
    owner.dispose();
    owner.dispose();
    assert.deepEqual(released, ['cockpit']);
    assert.equal(
      env.viewer.scene.screenSpaceCameraController.enableInputs,
      true,
    );
    assert.equal(env.viewer.trackedEntity, undefined);
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
    const owner = new CockpitViewController(env.viewer, {
      services: {
        flightsLayer: { getTrackedInfo: () => civilian },
        militaryFlightsLayer: { getTrackedInfo: () => military },
      },
    });
    env.viewer.trackedEntity = { gevTrackedId: 'military:def456' };
    assert.deepEqual(owner.readAircraftInfo(), military);
    env.viewer.trackedEntity = { gevTrackedId: 'flights:abc123' };
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
    const owner = new CockpitViewController(env.viewer, {
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
    const owner = new CockpitViewController(env.viewer, {
      services: {
        releaseContinuousRender: (reason) => released.push(reason),
      },
    });
    owner.active = true;
    owner.stop();
    assert.equal(env.callbacks.size, 0);
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
    env.viewer.scene.screenSpaceCameraController.enableInputs = true;
    window.setTimeout = (callback) => {
      frames.set(++next, callback);
      return next;
    };
    window.clearTimeout = (id) => frames.delete(id);
    const owner = new CockpitViewController(env.viewer, {
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
