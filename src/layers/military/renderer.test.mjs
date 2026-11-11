// The military logic draws only through its renderer: with a renderer that
// is plain data (no Cesium), the layer builds its amber fleet, selects a
// contact on a click through the engine's selection dispatcher, tracks and
// follows it, and releases it on an empty click or Escape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createApplicationMilitary } from '../../app/layers/militaryFlights.js';
import { defaultSurface } from '../../data/surfaceServices.js';
import * as militaryRegistry from '../../data/militaryRegistry.js';
import { Rgba } from '../shared/color.js';
import { MIL_ICON_COLOR, TRACKED_ICON_COLOR } from './policy.js';
import { recordingAircraftRenderer } from '../../testSupport/aircraftRecordingRenderer.mjs';

const keyListeners = new Set();
globalThis.window ||= {};
globalThis.window.dispatchEvent ||= () => true;
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.CustomEvent ||= class CustomEvent extends Event {
  constructor(type, init) {
    super(type);
    this.detail = init?.detail;
  }
};
globalThis.document ||= {
  body: { classList: { contains: () => false } },
  addEventListener(type, listener) {
    if (type === 'keydown') keyListeners.add(listener);
  },
  removeEventListener(type, listener) {
    if (type === 'keydown') keyListeners.delete(listener);
  },
};

/** A military snapshot (the source's record shape) of `ids`, now. */
function militarySnapshotOf(ids, nowMs = Date.now()) {
  return {
    source: 'Fixture military',
    complete: true,
    observedAtMs: nowMs,
    records: ids.map((id, index) => ({
      id,
      callsign: `RCH${index}`,
      latitude: 30.3,
      longitude: -97.6 + index * 0.1,
      onGround: false,
      baroAltitudeM: 9_000,
      courseDeg: 90,
      speedMps: 200,
      positionTimeMs: nowMs - 2_000,
      contactTimeMs: nowMs - 2_000,
    })),
  };
}

const click = (engine) => {
  engine.fake.input('down', { position: { x: 10, y: 10 } });
  engine.fake.input('up', { position: { x: 10, y: 10 } });
  engine.fake.input('click', { position: { x: 10, y: 10 } });
};

test('the military logic draws, selects and follows only through its renderer', async () => {
  const engine = createFakeEngine();
  let renderer = null;
  const layer = createApplicationMilitary({
    surface: defaultSurface,
    source: {
      label: 'Fixture military',
      getSnapshot: async () => militarySnapshotOf(['ae0001', 'ae0002']),
    },
    militaryRegistry,
    renderer: {
      create: ({ viewer, engine: given }) => {
        assert.equal(
          viewer,
          undefined,
          'the renderer receives only the engine',
        );
        renderer = recordingAircraftRenderer(given);
        return renderer;
      },
    },
  });
  layer.init(null, { engine });
  layer.enable();
  try {
    await layer.update(null);
    assert.equal(renderer.sprites.size, 2, 'one sprite per contact');
    const sprite = [...renderer.sprites].find(({ id }) => id === 'ae0001');
    assert.ok(sprite.color instanceof Rgba, 'colours are engine-neutral');
    assert.ok(sprite.color.equals(MIL_ICON_COLOR), 'the fleet is amber');
    assert.equal(layer.getAllPositions().length, 2);

    // A click on a contact: the engine's pick, through the dispatcher.
    engine.fake.script('pick', () => ({ id: 'ae0002' }));
    engine.fake.script('drillPick', () => [{ id: 'ae0002' }]);
    click(engine);
    assert.equal(layer.getTrackedInfo()?.icao24, 'ae0002');
    const created = renderer.calls.filter(
      ([name]) => name.startsWith('tracked') || name.startsWith('follow'),
    );
    assert.deepEqual(created, [
      ['tracked.create', 'tracked-1'],
      ['follow.start', 'tracked-1'],
    ]);
    // The tracked glyph is the lighter amber.
    const trackedSpec = renderer.follow.current().spec;
    assert.ok(trackedSpec.color().equals(TRACKED_ICON_COLOR));

    // Clicking the tracked visual itself is a no-op.
    engine.fake.script('pick', () => ({ id: 'tracked-1' }));
    engine.fake.script('drillPick', () => [{ id: 'tracked-1' }]);
    click(engine);
    assert.equal(layer.getTrackedInfo()?.icao24, 'ae0002');

    // Empty space releases the follow and removes the tracked visual.
    engine.fake.script('pick', () => undefined);
    engine.fake.script('drillPick', () => []);
    click(engine);
    assert.equal(layer.getTrackedInfo(), null);
    assert.ok(
      renderer.calls.some(([name]) => name === 'follow.release') &&
        renderer.calls.some(
          ([name, id]) => name === 'tracked.remove' && id === 'tracked-1',
        ),
    );

    // Escape releases too.
    engine.fake.script('pick', () => ({ id: 'ae0001' }));
    engine.fake.script('drillPick', () => [{ id: 'ae0001' }]);
    click(engine);
    assert.equal(layer.getTrackedInfo()?.icao24, 'ae0001');
    for (const listener of keyListeners) listener({ key: 'Escape' });
    assert.equal(layer.getTrackedInfo(), null);
  } finally {
    layer.disable();
    layer.destroy(null);
  }
  assert.ok(renderer.calls.some(([name]) => name === 'destroy'));
  assert.equal(keyListeners.size, 0, 'the dispatcher left the keyboard');
});

test('the military logic draws and follows on the aircraft display; the follow passes between flights and military', async () => {
  const { createAircraftDisplay, aircraftAtlasLayout } =
    await import('../aircraft/render/display.js');
  const { createApplicationFlights } =
    await import('../../app/layers/flights.js');
  const { openSkySnapshot } = await import('../../sources/live/aircraft.js');
  const layout = aircraftAtlasLayout();
  const drawAtlas = async () => ({
    canvas: { width: layout.width, height: layout.height },
    cells: layout.cells,
  });
  const engine = createFakeEngine();
  const renderers = {};
  const navara = (layerId, order) => ({
    create: ({ engine: given }) =>
      (renderers[layerId] = createAircraftDisplay(given, {
        layerId,
        order,
        headingOffsetDeg: 180,
        drawAtlas,
      })),
  });
  const military = createApplicationMilitary({
    surface: defaultSurface,
    source: {
      label: 'Fixture military',
      getSnapshot: async () => militarySnapshotOf(['ae0001', 'ae0002']),
    },
    militaryRegistry,
    renderer: navara('military', 7),
  });
  const nowSec = Math.floor(Date.now() / 1000);
  const flights = createApplicationFlights({
    surface: defaultSurface,
    source: {
      label: 'Fixture aircraft',
      getSnapshot: async () =>
        openSkySnapshot({
          time: nowSec,
          states: [
            [
              'abc123',
              'TST0 ',
              'United States',
              nowSec,
              nowSec,
              -97.9,
              30.4,
              10_668,
              false,
              250,
              95,
              5,
              null,
              10_700,
              null,
              null,
              null,
              5,
            ],
          ],
        }),
    },
    militaryRegistry,
    renderer: navara('flights', 8),
  });
  military.init(null, { engine });
  flights.init(null, { engine });
  military.enable();
  flights.enable();
  const awareness = [];
  const listen = (event) => awareness.push([event.type, event.detail]);
  const realDispatch = globalThis.window.dispatchEvent;
  globalThis.window.dispatchEvent = (event) => {
    listen(event);
    return true;
  };
  try {
    await renderers.military.whenReady();
    await renderers.flights.whenReady();
    await military.update(null);
    await flights.update(null);
    await Promise.resolve();
    const sprites = engine.movers
      .list()
      .filter(({ id }) => id.startsWith('military-sprites'));
    assert.equal(sprites.length, 1);
    assert.equal(sprites[0].count, 2);
    const drawn = military.qaDrawn();
    assert.deepEqual(drawn.map((row) => row.id).sort(), ['ae0001', 'ae0002']);
    // The fleet's colour reaches the engine as the layer's amber.
    const { store } = engine.fake.moverSet(sprites[0].id);
    assert.deepEqual([...store.pickIds.slice(0, 2)].sort(), [
      'ae0001',
      'ae0002',
    ]);

    // A click on a military contact selects it; the engine follows.
    engine.fake.script('pick', () => ({ id: 'ae0002' }));
    engine.fake.script('drillPick', () => [{ id: 'ae0002' }]);
    click(engine);
    assert.equal(military.getTrackedInfo()?.icao24, 'ae0002');
    assert.equal(engine.camera.following()?.label?.id, 'military:ae0002');
    engine.fake.frame();
    assert.equal(
      engine.movers.list().find(({ id }) => id.startsWith('military-tracked'))
        .count,
      1,
    );

    // A click on a civil flight takes the follow: military lets go, with
    // the new owner's origin (as Cesium's trackedEntityChanged gives it).
    engine.fake.script('pick', () => ({ id: 'abc123' }));
    engine.fake.script('drillPick', () => [{ id: 'abc123' }]);
    click(engine);
    assert.equal(flights.getTrackedInfo()?.icao24, 'abc123');
    assert.equal(military.getTrackedInfo(), null);
    assert.equal(engine.camera.following()?.label?.id, 'flights:abc123');
    const cleared = awareness.find(
      ([type, detail]) =>
        type === 'gev:awareness-subject-cleared' &&
        detail.layerId === 'military',
    );
    assert.equal(cleared?.[1].origin, 'user');

    // And back: tracking a military contact by voice releases flights.
    assert.equal(military.trackById('ae0001', { origin: 'voice' }), true);
    assert.equal(flights.getTrackedInfo(), null);
    assert.equal(engine.camera.following()?.label?.id, 'military:ae0001');

    // A camera command ends the follow; tracking it again follows it again.
    engine.camera.setView({
      destination: engine.camera.pose().position,
    });
    assert.equal(engine.camera.following(), null);
    assert.equal(military.getTrackedInfo()?.icao24, 'ae0001');
    assert.equal(military.trackById('ae0001', { origin: 'voice' }), true);
    assert.equal(engine.camera.following()?.label?.id, 'military:ae0001');
    assert.equal(military.stopTracking(), true);
    assert.equal(engine.camera.following(), null);
  } finally {
    globalThis.window.dispatchEvent = realDispatch;
    flights.disable();
    military.disable();
    flights.destroy(null);
    military.destroy(null);
  }
  assert.equal(engine.movers.list().length, 0, 'no mover set left behind');
  engine.destroy();
});

test('military classification and the selected aircraft survive an update between scenes', async () => {
  const first = createFakeEngine(),
    second = createFakeEngine();
  let polls = 0,
    binding;
  const layer = createApplicationMilitary({
    surface: defaultSurface,
    militaryRegistry,
    source: {
      getSnapshot: async () =>
        militarySnapshotOf(['ae0001'], 1700000000000 + ++polls * 1000),
    },
    renderer: {
      create: ({ engine }) => (binding = recordingAircraftRenderer(engine)),
    },
  });
  try {
    layer.init(null);
    layer.enable();
    await layer.update(null);
    assert.equal(layer.hasContact('AE0001'), true);
    assert.equal(layer.getAnalystRecords().length, 1);
    layer.attachRenderer({ engine: first });
    assert.equal(layer.trackById('ae0001'), true);
    layer.detachRenderer();
    assert.equal(binding.follow.current(), undefined);
    assert.equal(militaryRegistry.isMilitaryLayerActive(), true);
    assert.equal(layer.getTrackedInfo().icao24, 'ae0001');
    await layer.update(null);
    layer.attachRenderer({ engine: second });
    assert.ok(binding.follow.current());
    assert.equal(layer.getStats().lastUpdate, 1700000002000);
    assert.equal(polls, 2);
    layer.disable();
    assert.equal(militaryRegistry.isMilitaryLayerActive(), false);
    assert.equal(layer.hasContact('ae0001'), null);
  } finally {
    layer.destroy(null);
    first.destroy();
    second.destroy();
  }
});
