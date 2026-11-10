// src/layers/vessels/radarContacts.test.mjs — the vessels the Cockpit bridge
// radar draws: within range, nearest first, without the ship it rides; and
// the ridden ship's own trail, hidden while the bridge holds it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselLayer } from './index.js';
import { vesselTypeCss } from '../../data/vesselLabels.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { recordingRenderer, services } from './testFixtures.mjs';

const noop = () => {};
/** A vessel `northNm` nautical miles north of 54.5°N 10.2°E. */
function record(mmsi, northNm, extra = {}) {
  return {
    mmsi,
    name: `SHIP ${mmsi}`,
    type: '70',
    lat: 54.5 + northNm / 60,
    lon: 10.2,
    speed: 10,
    course: 45,
    heading: 40,
    missedRefreshes: 0,
    ...extra,
  };
}

function layerWith(t, records, options = {}) {
  const engine = createFakeEngine();
  const recording = recordingRenderer(engine);
  const layer = createVesselLayer({
    source: { getSnapshot: noop },
    services: services(recording.renderer),
  });
  layer.testing._setVesselStateForTest({
    engine,
    records,
    ...options,
  });
  t.after(() => {
    layer.destroy(null, { engine });
    engine.destroy();
  });
  return layer;
}

test('radar contacts are within range, nearest first and capped', (t) => {
  const layer = layerWith(t, [
    record('3', 5),
    record('1', 1),
    record('far', 20),
    record('2', 3, { course: null, heading: '', missedRefreshes: 2 }),
  ]);
  const contacts = layer.getRadarContacts(54.5, 10.2, 6 * 1852, 60);
  assert.deepEqual(
    contacts.map((entry) => entry.id),
    ['1', '2', '3'],
  );
  assert.deepEqual(contacts[0], {
    id: '1',
    name: 'SHIP 1',
    latitude: 54.5 + 1 / 60,
    longitude: 10.2,
    course: 45,
    heading: 40,
    type: '70',
    color: vesselTypeCss('70'),
    stale: false,
  });
  assert.equal(contacts[1].course, null);
  assert.equal(contacts[1].heading, null);
  assert.equal(contacts[1].stale, true);
  assert.deepEqual(
    layer.getRadarContacts(54.5, 10.2, 6 * 1852, 2).map((entry) => entry.id),
    ['1', '2'],
  );
});

test('the ship whose bridge the Cockpit rides is not its own contact', (t) => {
  const layer = layerWith(t, [record('own', 0), record('other', 2)]);
  layer.setCockpitSubject('own');
  assert.deepEqual(
    layer.getRadarContacts(54.5, 10.2, 6 * 1852).map((entry) => entry.id),
    ['other'],
  );
  layer.setCockpitSubject(null);
  assert.equal(layer.getRadarContacts(54.5, 10.2, 6 * 1852).length, 2);
});

test('ships with no MMSI each keep a key of their own', (t) => {
  const layer = layerWith(t, [
    record('', 1, { name: 'A' }),
    record('', 2, { name: 'B' }),
  ]);
  const ids = layer.getRadarContacts(54.5, 10.2, 6 * 1852).map((c) => c.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, ids.join(', '));
  assert.ok(ids.every((id) => id.startsWith('unkeyed:')));
});

test("the ridden ship's trail is hidden while the bridge holds it", (t) => {
  const shown = [];
  const trail = {
    setPositions() {},
    clear() {},
    destroy() {},
    setVisible: (visible) => shown.push(visible),
  };
  const layer = layerWith(t, [record('own', 0), record('other', 2)], {
    trail,
    trailMmsi: 'own',
  });
  layer.setCockpitSubject('own');
  assert.deepEqual(shown, [false]);
  layer.setCockpitSubject(null);
  assert.deepEqual(shown, [false, true]);
});

test('a disabled layer has no radar contacts', (t) => {
  const layer = layerWith(t, [record('1', 1)], { enabled: false });
  assert.deepEqual(layer.getRadarContacts(54.5, 10.2, 6 * 1852), []);
});
