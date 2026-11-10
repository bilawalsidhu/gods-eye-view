import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { isOverlayPointVisible } from '../../overlays/worldOverlay.js';
import {
  createEarthquakesLayer,
  createEarthquakeOverlayEntry,
  normalizeEarthquakeSnapshot,
} from './index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const GENERATED_MS = Date.UTC(2026, 0, 2, 12);

const feature = (id, lon, lat, mag, time) => ({
  id,
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat, 10] },
  properties: { mag, place: `Place ${id}`, time },
});

// The USGS all_day feed: one fresh event, one exactly on the window edge
// and one older than the feed's own 24 h window.
const FIXED_SAMPLE = {
  type: 'FeatureCollection',
  metadata: { generated: GENERATED_MS },
  features: [
    feature('us-fresh', 10, 20, 4.1, GENERATED_MS - 60_000),
    feature('us-edge', 11, 21, 3.2, GENERATED_MS - DAY_MS),
    feature('us-expired', 12, 22, 5.5, GENERATED_MS - DAY_MS - 1),
  ],
};

const WITH_DUPLICATE = {
  ...FIXED_SAMPLE,
  features: [
    ...FIXED_SAMPLE.features,
    feature('us-fresh', 10.5, 20.5, 4.4, GENERATED_MS - 30_000),
  ],
};

function layerWith(payloads) {
  const replaced = [];
  const labelSets = [];
  const queue = [...payloads];
  const layer = createEarthquakesLayer({
    source: {
      async getSnapshot() {
        const rows = normalizeEarthquakeSnapshot(queue.shift());
        if (!rows) throw new Error('Malformed USGS response');
        return rows;
      },
    },
    overlayHost: {
      setEntries(_source, entries) {
        labelSets.push(entries.map((entry) => entry.id));
      },
      setVisible() {},
      clearSource() {},
    },
    rendererFactory: () => ({
        setVisible() {},
        replace(discs) {
          replaced.push(discs.map((disc) => disc.stableId));
        },
        destroy() {},
      }),
  });
  return { layer, replaced, labelSets };
}

test('edge:earthquakes: an expired record is dropped and a duplicate never forks the ID set', async () => {
  assert.deepEqual(
    normalizeEarthquakeSnapshot(FIXED_SAMPLE).map((row) => row.stableId),
    ['us-fresh', 'us-edge'],
  );
  // A duplicate ID is a malformed feed: it is rejected whole so the last good
  // snapshot (one disc per ID) stays on screen with the source error shown.
  assert.equal(normalizeEarthquakeSnapshot(WITH_DUPLICATE), null);

  const { layer, replaced, labelSets } = layerWith([
    FIXED_SAMPLE,
    WITH_DUPLICATE,
  ]);
  layer.init(null, { engine: createFakeEngine() });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(await layer.update(), false);
  const ids = ['us-fresh', 'us-edge'];
  assert.deepEqual(replaced, [ids]);
  assert.deepEqual(labelSets.at(-1).toSorted(), ids.toSorted());
  assert.deepEqual(
    layer.getAnalystRecords().map((row) => row.id),
    ids,
  );
  assert.equal(layer.getStats().count, 2);
  assert.match(layer.getStats().error, /Malformed/);
  layer.destroy();
});

test('edge:earthquakes: near the horizon the label of the same ID is kept in front and culled behind', () => {
  const engine = createFakeEngine();
  // 1000 km over (0, 0) looking east at the limb, which lies ~30.2° away.
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, 1_000_000),
    orientation: { heading: Math.PI / 2, pitch: -0.52, roll: 0 },
  });
  const occluder = {
    isPointVisible: (position) => engine.projector.horizonVisible(position),
  };
  const viewport = engine.host.size();
  const rows = normalizeEarthquakeSnapshot({
    features: [
      feature('us-front', 29.5, 0, 4.5, null),
      feature('us-behind', 31.5, 0, 4.5, null),
    ],
  });
  const visible = rows
    .map((row) =>
      createEarthquakeOverlayEntry({
        id: row.stableId,
        position: geo.cartesian3.fromDegrees(row.lon, row.lat),
        magnitude: row.mag,
        accent: '#f00',
      }),
    )
    .filter((entry) => {
      const screen = engine.projector.worldToWindow(entry.position, {});
      // Both anchors project inside the viewport; only the horizon separates them.
      assert.ok(screen && screen.x > 0 && screen.x < viewport.width);
      return isOverlayPointVisible(
        entry,
        entry.position,
        screen,
        viewport,
        occluder,
      );
    })
    .map((entry) => entry.id);
  assert.deepEqual(visible, ['us-front']);
});
