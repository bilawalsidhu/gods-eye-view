import {
  countTextDocument,
  recordingContext,
} from '../testSupport/countPaintFakes.mjs';
import { clickCard } from './pickRegistry.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalGeoJsonLayer } from './localGeojsonCore.js';
import { createInfrastructureLayers } from './infrastructure.js';
import { localClusterCells } from './localClusters.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
import { fromDegrees } from '../geo/ellipsoid.js';
import { cross, distance } from '../geo/vector.js';

// Five data centres about 345 m apart near Ashburn, and one 560 km west.
const CLUSTER_LON = -77.488;
const CLUSTER_LAT = 39.03;
const CAMPUS = [0, 1, 2, 3, 4].map((i) => ({
  id: `dc-${i}`,
  lon: CLUSTER_LON + i * 0.004,
  lat: CLUSTER_LAT,
}));
const LONE = { id: 'dc-lone', lon: -84, lat: CLUSTER_LAT };

/** A small square footprint at a site, as OSM maps a building. */
function footprint({ id, lon, lat }) {
  const d = 0.0005;
  return {
    type: 'Feature',
    id,
    properties: { name: `Site ${id}` },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon - d, lat - d],
          [lon + d, lat - d],
          [lon + d, lat + d],
          [lon - d, lat + d],
          [lon - d, lat - d],
        ],
      ],
    },
  };
}

const services = (overrides = {}) => ({
  overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
  registerEntityContext() {},
  selectEntityContext() {},
  clearSelectedEntityContextForLayer() {},
  removeEntityContextsForLayer() {},
  governorRequestRender() {},
  ...overrides,
});

/** A canvas text measurer for the count painter, which sizes each label. */
function stubDocument(t) {
  globalThis.document = countTextDocument();
  t.after(() => delete globalThis.document);
}

/**
 * A clustered data-centre layer over the fake renderer, enabled, with the
 * click handler, the camera holds and the count painter it registered.
 */
async function clusteredLayer(
  t,
  {
    eye,
    sampleHeight = false,
    features = [...CAMPUS, LONE].map(footprint),
    serviceOverrides = {},
    beforeEnable = null,
  } = {},
) {
  stubDocument(t);
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye,
    sampleHeight,
    surface: () => 80,
  });
  t.after(fake.unbind);
  const input = { clicks: [], holds: 0, released: 0 };
  const lanes = [];
  const layer = createLocalGeoJsonLayer(
    {
      id: 'local-datacenters',
      name: 'Datacenters',
      color: '#00ffff',
      markers: 'clusters',
      loadFeatures: async () => features,
      projectToWindow: () => ({ x: 400, y: 300 }),
      inputFor: () => ({
        onClick: (fn) => {
          input.clicks.push(fn);
          return () => {};
        },
        suspendCamera: () => {
          input.holds++;
          return () => input.released++;
        },
      }),
    },
    services({
      registerPaintLane: (_lane, painter, options) => {
        const lane = {
          painter,
          id: options.id,
          active: options.active,
          unregistered: false,
        };
        lanes.push(lane);
        return {
          requestPaint() {},
          setActive(active) {
            lane.active = active;
          },
          unregister() {
            lane.unregistered = true;
          },
        };
      },
      ...serviceOverrides,
    }),
  );
  beforeEnable?.(fake);
  await layer.enable(viewer);
  t.after(() => layer.destroy(viewer));
  /** One walk after a settled camera move. */
  const settle = () => {
    fake.moveEnd.raise();
    fake.preRender.raise();
  };
  return { layer, viewer, fake, input, lanes, settle };
}

/** The view-projection matrix the world overlay hands its painters, for a pose. */
function viewProjection(pose, width, height) {
  const { position: e, direction: d, up: u } = pose;
  const r = cross(d, u);
  const tanY = Math.tan(pose.fovy / 2);
  const tanX = tanY * pose.aspectRatio;
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const m = new Float64Array(16);
  // Column-major rows: x clip, y clip, unused z, and w as the depth.
  [m[0], m[4], m[8], m[12]] = [
    r.x / tanX,
    r.y / tanX,
    r.z / tanX,
    -dot(r, e) / tanX,
  ];
  [m[1], m[5], m[9], m[13]] = [
    u.x / tanY,
    u.y / tanY,
    u.z / tanY,
    -dot(u, e) / tanY,
  ];
  [m[3], m[7], m[11], m[15]] = [d.x, d.y, d.z, -dot(d, e)];
  return { ctx: recordingContext(), width, height, viewProjectionMatrix: m };
}

const markerItems = (fake) => [...fake.set('markers').items.values()];
const shownIds = (items) =>
  items
    .filter((item) => item.show)
    .map((item) => item.id)
    .sort();

test('far out, nearby data centres draw one count and a lone one its own marker', async (t) => {
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON, lat: CLUSTER_LAT, height: 2_000_000 },
  });
  env.settle();
  const diagnostics = env.layer.getLodDiagnostics();
  assert.equal(diagnostics.sites, 6);
  assert.equal(diagnostics.counts, 1);
  // The lone site is a marker, never a "1" count.
  assert.equal(diagnostics.lone, 1);
  assert.deepEqual(shownIds(markerItems(env.fake)), ['dc-lone']);
  // Its footprint shows with it; the counted sites' footprints hide.
  assert.deepEqual(shownIds([...env.fake.set('fills').items.values()]), [
    'dc-lone',
  ]);
  // No stems, no dots.
  assert.equal(env.fake.set('stems'), undefined);
  assert.equal(env.fake.set('dots'), undefined);
  const marker = env.fake.set('markers').items.get('dc-lone');
  assert.equal(marker.height, 'clampGround');
  assert.equal(marker.meta.layerId, 'local-datacenters');
  assert.equal(marker.meta.record.id, 'dc-lone');
});

test('close in, every data centre is its own ground marker with its footprint', async (t) => {
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON + 0.008, lat: CLUSTER_LAT, height: 3_000 },
  });
  env.settle();
  const diagnostics = env.layer.getLodDiagnostics();
  assert.equal(diagnostics.counts, 0);
  assert.deepEqual(shownIds(markerItems(env.fake)), [
    'dc-0',
    'dc-1',
    'dc-2',
    'dc-3',
    'dc-4',
  ]);
  assert.deepEqual(shownIds([...env.fake.set('fills').items.values()]), [
    'dc-0',
    'dc-1',
    'dc-2',
    'dc-3',
    'dc-4',
  ]);
});

test('clustered sites never sample ground heights or arm a retry', async (t) => {
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON + 0.008, lat: CLUSTER_LAT, height: 3_000 },
    sampleHeight: true,
  });
  env.settle();
  env.settle();
  assert.equal(env.fake.sampleCalls.count, 0);
  assert.equal(env.layer.getLodDiagnostics().computed, true);
  const marker = env.fake.set('markers').items.get('dc-0');
  // It stands on the footprint's centre, clamped to the ground.
  assert.ok(Math.abs(marker.pos.lon - CAMPUS[0].lon) < 1e-6);
  assert.ok(Math.abs(marker.pos.lat - CAMPUS[0].lat) < 1e-6);
  assert.equal(marker.height, 'clampGround');
});

test('grouping reruns on a settled move or material motion, not every frame', async (t) => {
  let clock = 10_000;
  t.mock.method(performance, 'now', () => clock);
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON, lat: CLUSTER_LAT, height: 2_000_000 },
  });
  env.settle();
  assert.equal(env.layer.getLodDiagnostics().counts, 1);
  const writes = env.fake.set('markers').writes;
  // The eye drops to the campus without a moveEnd: frames before the motion
  // probe's window keep the last grouping.
  env.fake.setEye(CLUSTER_LON + 0.008, CLUSTER_LAT, 3_000);
  clock += 500;
  env.fake.preRender.raise();
  assert.equal(env.layer.getLodDiagnostics().counts, 1);
  assert.equal(env.fake.set('markers').writes, writes);
  // Once the probe sees the eye has travelled, it groups again.
  clock += 600;
  env.fake.preRender.raise();
  assert.equal(env.layer.getLodDiagnostics().counts, 0);
  assert.equal(env.layer.getLodDiagnostics().lone, 5);
  // A parked camera groups no more.
  const after = env.fake.set('markers').writes;
  for (let i = 0; i < 5; i++) {
    clock += 1_100;
    env.fake.preRender.raise();
  }
  assert.equal(env.fake.set('markers').writes, after);
});

test('clicking a count flies to frame its members and holds camera input meanwhile', async (t) => {
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON, lat: CLUSTER_LAT, height: 2_000_000 },
  });
  env.settle();
  assert.equal(env.lanes.length, 1);
  const pose = env.fake.renderer.camera.pose();
  const frame = viewProjection(pose, 800, 600);
  env.lanes[0].painter(frame);
  const label = frame.ctx.labels.find((painted) => painted.text === '5');
  assert.ok(label, 'the count of five is painted');
  // A click inside the marker, above the count; nothing else is under it.
  env.input.clicks[0]({
    screenPosition: { x: label.x, y: label.y - 10 },
    drawHit: null,
    topHit: null,
    gesture: { travelPx: 0, durationMs: 50 },
  });
  assert.equal(env.input.holds, 1);
  assert.equal(env.fake.flights.length, 1);
  const { sphere, options } = env.fake.flights[0];
  assert.equal(options.offset.pitch, -Math.PI / 2);
  const eye = pose.position;
  assert.ok(options.offset.range < distance(eye, sphere.center) / 1.9);
  // Every member lies in the frame from above at the flight's range.
  const halfSpanM = options.offset.range * Math.tan(pose.fovy / 2);
  for (const site of CAMPUS)
    assert.ok(
      distance(fromDegrees(site.lon, site.lat, 0), sphere.center) < halfSpanM,
    );
  options.onComplete();
  assert.equal(env.input.released, 1);

  // A click away from any count falls through to the scene pick.
  env.input.clicks[0]({
    screenPosition: { x: 5, y: 5 },
    drawHit: null,
    topHit: null,
    gesture: { travelPx: 0, durationMs: 50 },
  });
  assert.equal(env.fake.flights.length, 1);
});

test('picking a lone marker selects its feature context as a stem did', async (t) => {
  const selected = [];
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON + 0.008, lat: CLUSTER_LAT, height: 3_000 },
    features: CAMPUS.map(footprint),
    serviceOverrides: {
      selectEntityContext: (carrier) => selected.push(carrier),
    },
  });
  env.settle();
  const marker = env.fake.set('markers').items.get('dc-2');
  assert.equal(marker.show, true);
  assert.equal(marker.meta.show, true, 'its context is active');
  env.input.clicks[0]({
    screenPosition: { x: 400, y: 300 },
    drawHit: { set: env.fake.set('markers').spec.id, id: 'dc-2' },
    topHit: {},
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0], marker.meta);
  assert.equal(selected[0].record.context.label, 'Site dc-2');
});

test('the cluster grouping keeps sites apart below the least cell size', () => {
  const sites = CAMPUS.map(({ id, lon, lat }) => ({
    id,
    lon,
    lat,
    base: fromDegrees(lon, lat, 0),
  }));
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: CLUSTER_LON + 0.008, lat: CLUSTER_LAT, height: 200 },
  });
  try {
    const pose = fake.renderer.camera.pose();
    const { cells } = localClusterCells(sites, {
      pose,
      width: 800,
      height: 600,
    });
    // At 200 m a cell would be under LOCAL_CLUSTER_MIN_CELL_M: every site
    // in view stands alone under its own key.
    assert.ok(cells.length > 0);
    for (const cell of cells) {
      assert.equal(cell.count, 1);
      assert.match(cell.key, /^near:/);
    }
    // From far away the same sites share one ground cell.
    fake.setEye(CLUSTER_LON, CLUSTER_LAT, 500_000);
    const far = localClusterCells(sites, {
      pose: fake.renderer.camera.pose(),
      width: 800,
      height: 600,
    });
    assert.deepEqual(
      far.cells.map((cell) => cell.count),
      [5],
    );
    assert.equal(far.cells[0].winner.id, 'dc-0');
  } finally {
    fake.unbind();
  }
});

test('dams keep their stems while data centres cluster', async (t) => {
  stubDocument(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(footprint(CAMPUS[0])),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: CLUSTER_LON, lat: CLUSTER_LAT, height: 50_000 },
  });
  t.after(fake.unbind);
  // The layers take clicks through the shared dispatcher's input port.
  fake.renderer.input = { on: () => () => {}, behaviours: {} };
  const [datacenters, dams] = createInfrastructureLayers(services());
  for (const layer of [datacenters, dams]) {
    await layer.enable(viewer);
    t.after(() => layer.destroy(viewer));
  }
  fake.moveEnd.raise();
  fake.preRender.raise();
  const live = (prefix, role) =>
    fake
      .liveSets()
      .find(
        (set) =>
          set.spec.id.startsWith(`${prefix}:`) &&
          set.spec.id.endsWith(`:${role}`),
      );
  assert.ok(live('local-dams', 'stems'));
  assert.ok(live('local-dams', 'dots'));
  assert.equal(live('local-dams', 'markers'), undefined);
  assert.equal('sites' in dams.getLodDiagnostics(), false);
  assert.equal(live('local-dams', 'stems').items.size, 1);
  assert.equal(live('local-datacenters', 'stems'), undefined);
  assert.equal(live('local-datacenters', 'dots'), undefined);
  assert.equal(live('local-datacenters', 'markers').items.size, 1);
});

test('high-ground sites split once their terrain loads, without a camera move', async (t) => {
  let progress;
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON, lat: CLUSTER_LAT, height: 1_700 },
    features: ['a', 'b'].map((id, i) => ({
      type: 'Feature',
      id,
      properties: {},
      geometry: {
        type: 'Point',
        coordinates: [CLUSTER_LON + i * 0.0001, CLUSTER_LAT],
      },
    })),
    beforeEnable(fake) {
      fake.renderer.globe.on = (event, cb) => {
        if (event === 'progress') progress = cb;
        return () => {
          progress = null;
        };
      };
    },
  });
  env.settle();
  assert.equal(env.layer.getLodDiagnostics().counts, 1);
  env.fake.globe.terrain = () => 1_600;
  progress({ terrainPending: 2 });
  progress({ terrainPending: 0 });
  env.fake.preRender.raise();
  assert.equal(env.layer.getLodDiagnostics().counts, 0);
  assert.deepEqual(shownIds(markerItems(env.fake)), ['a', 'b']);
  env.layer.disable(env.viewer);
  assert.equal(progress, null);
});

test('disable drops the counts and their click claim; enable restores them; destroy lets the lane go', async (t) => {
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON, lat: CLUSTER_LAT, height: 2_000_000 },
  });
  const fonts = new Set();
  globalThis.document.fonts = {
    addEventListener: (_t, fn) => fonts.add(fn),
    removeEventListener: (_t, fn) => fonts.delete(fn),
  };
  env.settle();
  const lane = env.lanes[0];
  assert.equal(lane.active, true);
  assert.equal(fonts.size, 1);
  const pose = env.fake.renderer.camera.pose();
  const frame = viewProjection(pose, 800, 600);
  lane.painter(frame);
  const label = frame.ctx.labels.find((painted) => painted.text === '5');
  assert.ok(label);
  const click = () => ({
    screenPosition: { x: label.x, y: label.y - 10 },
    drawHit: null,
    topHit: null,
    gesture: { travelPx: 0, durationMs: 50 },
  });
  assert.equal(clickCard(click())?.sourceId, 'local-datacenters:count');
  env.layer.disable(env.viewer);
  assert.equal(lane.active, false);
  assert.equal(clickCard(click()), null);
  assert.equal(env.layer.getLodDiagnostics().counts, 0);
  await env.layer.enable(env.viewer);
  env.settle();
  assert.equal(env.layer.getLodDiagnostics().counts, 1);
  lane.painter(viewProjection(pose, 800, 600));
  assert.equal(clickCard(click())?.sourceId, 'local-datacenters:count');
  assert.equal(env.lanes.length, 1);
  env.layer.destroy(env.viewer);
  assert.equal(lane.unregistered, true);
  assert.equal(fonts.size, 0);
});

test('replaceFeatures in clusters mode regroups the new sites', async (t) => {
  const env = await clusteredLayer(t, {
    eye: { lon: CLUSTER_LON + 0.008, lat: CLUSTER_LAT, height: 3_000 },
  });
  env.settle();
  await env.layer.replaceFeatures(
    env.viewer,
    CAMPUS.slice(0, 3).map(footprint),
  );
  env.settle();
  assert.deepEqual(shownIds(markerItems(env.fake)), ['dc-0', 'dc-1', 'dc-2']);
  assert.deepEqual(env.layer.getLodDiagnostics(), {
    sites: 3,
    lone: 3,
    counts: 0,
    computed: true,
  });
});
