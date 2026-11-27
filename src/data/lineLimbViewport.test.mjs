// Globe-height Inspector read (hemisphere + clipViewport + a measured rect):
// a GeoJSON line whose segment nearest the view centre lies behind the limb,
// but which has another in-rectangle segment on the visible side, still
// counts once, anchored on the visible segment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewSummaryForLayer } from './entityContext.js';
import { CONTEXT_LINES } from './contextGeometry.js';

const path = (pts) => ({
  bounds: {
    west: Math.min(...pts.map((p) => p.lon)),
    east: Math.max(...pts.map((p) => p.lon)),
    south: Math.min(...pts.map((p) => p.lat)),
    north: Math.max(...pts.map((p) => p.lat)),
  },
  points: () => pts,
});

function read(withVisibleSegment, extraPaths = []) {
  // Camera 6,000 km above (0, 0): the horizon is about 59 deg away. The view
  // is tilted, so the ground under the screen middle is (0, 50).
  const paths = [
    path([
      { lat: 0, lon: 60 },
      { lat: 0, lon: 62 },
    ]),
  ]; // behind the limb
  if (withVisibleSegment)
    paths.push(
      path([
        { lat: 0, lon: 30 },
        { lat: 0, lon: 31 },
      ]),
    ); // 30 deg out: visible
  paths.push(...extraPaths);
  const record = {
    key: 'geojson:test:1',
    id: 'geojson:test:1',
    name: 'Line',
    lat: 0,
    lon: 61, // representative vertex, behind the limb
    [CONTEXT_LINES]: paths,
  };
  const dm = {
    isEnabled: () => true,
    layers: new Map([
      ['local-geojson', { module: { getAnalystRecords: () => [record] } }],
    ]),
  };
  return viewSummaryForLayer(
    dm,
    { id: 'local-geojson', enabled: true },
    { west: 20, east: 70, south: -10, north: 10 },
    { lat: 0, lon: 50 },
    {
      hemisphere: true,
      clipViewport: true,
      heightM: 6e6,
      eye: { lat: 0, lon: 0 },
      perLayer: 3,
    },
  );
}

test('a visible farther segment keeps the line in view', () => {
  const out = read(true);
  assert.equal(
    out?.count,
    1,
    'line with a visible in-rectangle segment is dropped',
  );
  assert.ok(
    out.items[0].identity.lon <= 31,
    'row anchored on the visible segment',
  );
});

test('with only the hidden segment the line is not in view', () => {
  assert.equal(read(false)?.count ?? 0, 0);
});

test('a visible line crossing only a viewport corner keeps its clipped anchor', () => {
  const crossing = path([
    { lat: 12, lon: 23 },
    { lat: 8, lon: 19 },
  ]);
  const out = read(false, [crossing]);
  assert.equal(out?.count, 1);
  const { lat, lon } = out.items[0].identity;
  assert.ok(lat <= 10 && lon >= 20 && lon <= 21);
});
