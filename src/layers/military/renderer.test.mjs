// The military logic draws only through its renderer (phase 3 Task 11a): with
// a renderer that is plain data (no Cesium), the layer builds its amber
// fleet, selects a contact on a click through the engine's selection
// dispatcher, tracks and follows it, and releases it on an empty click or
// Escape. This is the seam the Navara renderer (Task 11b) plugs into.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createApplicationMilitary } from '../../app/layers/militaryFlights.js';
import { defaultSurface } from '../../data/surfaceServices.js';
import * as militaryRegistry from '../../data/militaryRegistry.js';
import { missingAircraftRendererMembers } from '../aircraft/render/contract.js';
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
        assert.equal(viewer, null, 'no viewer on an engine without one');
        renderer = recordingAircraftRenderer(given);
        return renderer;
      },
    },
  });
  layer.init(null, { engine });
  assert.deepEqual(missingAircraftRendererMembers(renderer), []);
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
