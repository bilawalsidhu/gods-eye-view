// The flights logic draws only through its renderer: with a renderer that
// is plain data (no Cesium), the layer builds its fleet, selects a contact
// on a click through the engine's selection dispatcher, tracks and follows
// it, and releases it on an empty click; then the same through its display
// on the fake engine and on the Cesium engine.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createApplicationFlights } from '../../app/layers/flights.js';
import { defaultSurface } from '../../data/surfaceServices.js';
import * as militaryRegistry from '../../data/militaryRegistry.js';
import { openSkySnapshot } from '../../sources/live/aircraft.js';
import { Rgba } from '../shared/color.js';
import { recordingAircraftRenderer as recordingRenderer } from '../../testSupport/aircraftRecordingRenderer.mjs';

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
  addEventListener() {},
  removeEventListener() {},
};

function snapshotOf(ids) {
  const nowSec = Math.floor(Date.now() / 1000);
  return openSkySnapshot({
    time: nowSec,
    states: ids.map((id, index) => [
      id,
      `TST${index} `,
      'United States',
      nowSec,
      nowSec,
      -97.6 + index * 0.1,
      30.3,
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
    ]),
  });
}

test('the flights logic draws, selects and follows only through its renderer', async () => {
  const engine = createFakeEngine();
  let renderer = null;
  const layer = createApplicationFlights({
    surface: defaultSurface,
    source: {
      label: 'Fixture aircraft',
      getSnapshot: async () => snapshotOf(['abc123', 'def456']),
    },
    militaryRegistry,
    renderer: {
      create: ({ viewer, engine: given }) => {
        assert.equal(
          viewer,
          undefined,
          'the renderer receives only the engine',
        );
        renderer = recordingRenderer(given);
        return renderer;
      },
    },
  });
  layer.init(null, { engine });
  layer.enable();
  try {
    await layer.update(null);
    assert.equal(renderer.sprites.size, 2, 'one sprite per contact');
    const [sprite] = renderer.sprites;
    assert.ok(sprite.color instanceof Rgba, 'colours are engine-neutral');
    assert.equal(sprite.id, 'abc123');
    assert.equal(layer.getAllPositions().length, 2);

    // A click on a contact: the engine's pick, through the dispatcher.
    engine.fake.script('pick', () => ({ id: 'def456' }));
    engine.fake.script('drillPick', () => [{ id: 'def456' }]);
    const click = () => {
      engine.fake.input('down', { position: { x: 10, y: 10 } });
      engine.fake.input('up', { position: { x: 10, y: 10 } });
      engine.fake.input('click', { position: { x: 10, y: 10 } });
    };
    click();
    assert.equal(layer.getTrackedInfo()?.icao24, 'def456');
    assert.deepEqual(
      renderer.calls.filter(
        ([name]) => name.startsWith('tracked') || name.startsWith('follow'),
      ),
      [
        ['tracked.create', 'tracked-1'],
        ['follow.start', 'tracked-1'],
      ],
    );

    // Clicking the tracked visual itself is a no-op.
    engine.fake.script('pick', () => ({ id: 'tracked-1' }));
    engine.fake.script('drillPick', () => [{ id: 'tracked-1' }]);
    click();
    assert.equal(layer.getTrackedInfo()?.icao24, 'def456');

    // Empty space releases the follow and removes the tracked visual.
    engine.fake.script('pick', () => undefined);
    engine.fake.script('drillPick', () => []);
    click();
    assert.equal(layer.getTrackedInfo(), null);
    assert.ok(
      renderer.calls.some(([name]) => name === 'follow.release') &&
        renderer.calls.some(
          ([name, id]) => name === 'tracked.remove' && id === 'tracked-1',
        ),
    );
  } finally {
    layer.disable();
    layer.destroy(null);
  }
  assert.ok(renderer.calls.some(([name]) => name === 'destroy'));
});

test('the flights logic draws and follows on the aircraft display (fake engine)', async () => {
  const { createAircraftDisplay, aircraftAtlasLayout } =
    await import('../aircraft/render/display.js');
  const layout = aircraftAtlasLayout();
  const engine = createFakeEngine();
  let renderer = null;
  const layer = createApplicationFlights({
    surface: defaultSurface,
    source: {
      label: 'Fixture aircraft',
      getSnapshot: async () => snapshotOf(['abc123', 'def456']),
    },
    militaryRegistry,
    renderer: {
      create: ({ engine: given }) =>
        (renderer = createAircraftDisplay(given, {
          layerId: 'flights',
          order: 8,
          headingOffsetDeg: 180,
          drawAtlas: async () => ({
            canvas: { width: layout.width, height: layout.height },
            cells: layout.cells,
          }),
        })),
    },
  });
  layer.init(null, { engine });
  layer.enable();
  try {
    await renderer.whenReady();
    await layer.update(null);
    await Promise.resolve();
    const sprites = engine.movers
      .list()
      .filter(({ id }) => id.startsWith('flights-sprites'));
    assert.equal(sprites.length, 1);
    assert.equal(sprites[0].count, 2);
    const { store } = engine.fake.moverSet(sprites[0].id);
    assert.deepEqual([...store.pickIds.slice(0, 2)].sort(), [
      'abc123',
      'def456',
    ]);
    // What it draws, as the QA probe reads it (the same on every engine).
    const drawn = layer.qaDrawn();
    assert.deepEqual(drawn.map((row) => row.id).sort(), ['abc123', 'def456']);
    assert.ok(drawn.every((row) => row.show && row.image.startsWith('data:')));
    // A click on a contact selects it; the engine follows with its label.
    engine.fake.script('pick', () => ({ id: 'def456' }));
    engine.fake.script('drillPick', () => [{ id: 'def456' }]);
    engine.fake.input('down', { position: { x: 10, y: 10 } });
    engine.fake.input('up', { position: { x: 10, y: 10 } });
    engine.fake.input('click', { position: { x: 10, y: 10 } });
    assert.equal(layer.getTrackedInfo()?.icao24, 'def456');
    const following = engine.camera.following();
    assert.equal(following?.label?.id, 'flights:def456');
    engine.fake.frame();
    const tracked = engine.movers
      .list()
      .find(({ id }) => id.startsWith('flights-tracked'));
    assert.equal(tracked.count, 1);
    assert.equal(layer.getAllPositions().length, 2);
    // A camera command ends the engine's follow; the contact stays selected
    // (as on Cesium after a search flight), and tracking it again follows.
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-97.7, 30.2, 50_000),
    });
    assert.equal(engine.camera.following(), null);
    assert.equal(layer.getTrackedInfo()?.icao24, 'def456');
    assert.equal(layer.trackById('def456', { origin: 'voice' }), true);
    assert.equal(engine.camera.following()?.label?.id, 'flights:def456');
    assert.equal(layer.stopTracking(), true);
    assert.equal(engine.camera.following(), null);
    assert.equal(
      engine.movers.list().find(({ id }) => id.startsWith('flights-tracked'))
        .count,
      0,
    );
  } finally {
    layer.disable();
    layer.destroy(null);
  }
  assert.equal(engine.movers.list().length, 0, 'no mover set left behind');
  engine.destroy();
});

test('a failed engine switch, its rollback and the retry re-follow the tracked aircraft as a restore', async () => {
  const { createCesiumMoversEngine } =
    await import('../../testSupport/cesiumMoversEngine.mjs');
  const { createFlightsDisplay } = await import('./render/display.js');
  const { aircraftAtlasLayout } = await import('../aircraft/render/display.js');
  const layout = aircraftAtlasLayout();
  // The shell's navigation stamp (LayerBindings.observeCamera): a follow
  // Cesium announces through trackedEntityChanged is new navigation unless
  // it rebinds the session's own subject. A new navigation supersedes the
  // switch's share restore, which then clears the selection.
  const navigations = [];
  const cesium = () => {
    const made = createCesiumMoversEngine();
    made.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-97.5, 30.3, 400_000),
    });
    made.viewer.trackedEntityChanged.addEventListener((entity) => {
      if (entity && !entity.gevRestoring) navigations.push(entity.gevTrackedId);
    });
    return made;
  };
  const working = cesium();
  let display = null;
  const layer = createApplicationFlights({
    surface: defaultSurface,
    source: {
      label: 'Fixture aircraft',
      getSnapshot: async () => snapshotOf(['abc123', 'def456']),
    },
    militaryRegistry,
    renderer: {
      create: ({ engine: given }) =>
        (display = createFlightsDisplay(given, {
          drawAtlas: async () => ({
            canvas: { width: layout.width, height: layout.height },
            cells: layout.cells,
          }),
        })),
    },
  });
  layer.init(working.viewer, { engine: working.engine });
  layer.enable();
  const candidate = createFakeEngine();
  let retried = null;
  try {
    await display.whenReady();
    await layer.update(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The person's own selection is navigation.
    assert.equal(layer.trackById('def456', { origin: 'user' }), true);
    assert.deepEqual(navigations, ['flights:def456']);
    navigations.length = 0;
    // The switch: the working engine detaches; the candidate attaches the
    // layer, then fails and releases what it attached.
    layer.detachRenderer(working.viewer);
    layer.attachRenderer({ engine: candidate });
    assert.equal(candidate.camera.following()?.label?.id, 'flights:def456');
    layer.detachRenderer(null);
    // The rollback: the working engine attaches again and follows the same
    // aircraft, announced as a restore.
    layer.attachRenderer({ engine: working.engine });
    assert.equal(layer.getTrackedInfo()?.icao24, 'def456');
    assert.equal(working.viewer.trackedEntity?.gevTrackedId, 'flights:def456');
    assert.deepEqual(navigations, [], 'the rollback is not new navigation');
    // The retry onto a new Cesium engine.
    layer.detachRenderer(working.viewer);
    retried = cesium();
    layer.attachRenderer({ engine: retried.engine });
    assert.equal(layer.getTrackedInfo()?.icao24, 'def456');
    assert.equal(retried.viewer.trackedEntity?.gevTrackedId, 'flights:def456');
    assert.equal(
      retried.engine.camera.following()?.label?.id,
      'flights:def456',
    );
    assert.deepEqual(navigations, [], 'the retry is not new navigation');
  } finally {
    layer.disable();
    layer.destroy(retried?.viewer ?? working.viewer);
  }
  for (const engine of [working.engine, candidate, retried?.engine])
    engine?.destroy();
});
