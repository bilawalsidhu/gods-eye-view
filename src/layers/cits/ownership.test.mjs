import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  CITS_OVERLAY_SOURCE_ID,
  CITS_SELECTED_OVERLAY_SOURCE_ID,
  createCitsLayer,
} from './index.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { bindFakeCesiumScene } from '../../testSupport/fakeCesiumScene.mjs';

const LON = 15.4425;
const LAT = 47.0665;
const tram = {
  id: '00:30:e7:00:06:68',
  kind: 'tram',
  lon: LON + 0.001,
  lat: LAT,
  speedKmh: 23,
  heading: 90,
  line: '6',
  destination: 'St. Peter',
  vehicleNumber: '217',
  lastSeen: new Date().toISOString(),
};
const car = {
  id: 'anon-0123456789abcdef',
  kind: 'car',
  anonymous: true,
  lon: LON - 0.001,
  lat: LAT,
  speedKmh: 48,
  lastSeen: new Date().toISOString(),
};

function harness({ state = { status: 'live', objects: [tram, car] } } = {}) {
  const overlay = { entries: new Map(), visible: new Map() };
  const owners = new Map();
  let pick = null;
  let altitude = 900;
  const pending = [];
  const camera = {
    get positionCartographic() {
      return Cesium.Cartographic.fromDegrees(LON, LAT, altitude);
    },
    get positionWC() {
      return Cesium.Cartesian3.fromDegrees(LON, LAT, altitude);
    },
    pickEllipsoid: () => undefined,
    // Street Traffic's rendered-surface heights read the camera's matrices.
    viewMatrix: Cesium.Matrix4.IDENTITY,
    frustum: {
      fovy: Math.PI / 3,
      projectionMatrix: Cesium.Matrix4.IDENTITY,
    },
  };
  const viewer = {
    camera,
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84, getHeight: () => 0 },
      primitives: { add: (value) => value, remove() {} },
      groundPrimitives: { add: (value) => value, remove() {} },
      preRender: { addEventListener: () => () => {} },
      pickPositionSupported: false,
      pick: () => pick,
      requestRender() {},
    },
  };
  const { draw } = bindFakeCesiumScene(viewer);
  const input = fakeInput(viewer);
  /** The dot set's id, once the layer has made it. */
  let dotSetId = null;
  const source = {
    getState(bounds, { signal }) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve: () => resolve(state), signal });
        signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    },
  };
  const layer = createCitsLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        overlay.entries.set(sourceId, entries);
      },
      setVisible(sourceId, visible) {
        overlay.visible.set(sourceId, visible);
      },
      clearSource(sourceId) {
        overlay.entries.delete(sourceId);
      },
      hitTest: () => null,
    },
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, id) =>
        String(id).startsWith('other-layer:'),
      registerPickOwner: (id, predicate) => owners.set(id, predicate),
      unregisterPickOwner: (id) => owners.delete(id),
    },
    pointer: { isPointerFree: () => true },
    inputFor: () => input.input,
    windowRef: null,
    documentRef: null,
  });
  layer.init(viewer);
  layer.enable(viewer);
  dotSetId = [...draw.sets.values()].find((record) =>
    record.spec.id.endsWith(':dots'),
  ).spec.id;
  return {
    layer,
    draw,
    overlay,
    owners,
    pending,
    /** Our own dots are draw-set items; anything else a sibling's pick. */
    setPick: (id) =>
      (pick = !id
        ? null
        : id.startsWith('cits:')
          ? { id: { set: dotSetId, id } }
          : { id }),
    subscribers: () => input.input.subscriberCount(),
    setAltitude: (value) => (altitude = value),
    async refresh() {
      const update = layer.update(viewer);
      pending.shift()?.resolve();
      return update;
    },
    click: () => input.click({ x: 400, y: 300 }),
  };
}

const selected = (overlay) =>
  overlay.entries.get(CITS_SELECTED_OVERLAY_SOURCE_ID) || [];

test('a tram click publishes one selected card and an empty click clears it', async () => {
  const h = harness();
  assert.equal(await h.refresh(), true);
  h.setPick(`cits:obj:${tram.id}`);
  h.click();
  const cards = selected(h.overlay);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'TRAM · 6 → St. Peter');
  assert.equal(cards[0].variant, 'selected');
  assert.equal(typeof cards[0].position, 'function');
  assert.ok(cards[0].position());
  // The selected tram's ambient label steps aside for the card.
  assert.ok(
    !(h.overlay.entries.get(CITS_OVERLAY_SOURCE_ID) || []).some((entry) =>
      entry.id.includes(tram.id),
    ),
  );
  h.setPick(null);
  h.click();
  assert.deepEqual(selected(h.overlay), []);
});

test('the anonymous car never gets a card', async () => {
  const h = harness();
  await h.refresh();
  h.setPick('cits:anon:0');
  h.click();
  assert.deepEqual(selected(h.overlay), []);
});

test("a sibling layer's pick leaves the selection alone", async () => {
  const h = harness();
  await h.refresh();
  h.setPick(`cits:obj:${tram.id}`);
  h.click();
  h.setPick('other-layer:aircraft');
  h.click();
  assert.equal(selected(h.overlay).length, 1);
});

test('late refresh cannot publish after disable or destroy', async () => {
  const h = harness();
  const update = h.layer.update();
  h.layer.disable();
  h.pending.shift()?.resolve();
  assert.equal(await update, false);
  assert.equal(h.overlay.entries.has(CITS_OVERLAY_SOURCE_ID), false);
  assert.equal(h.overlay.entries.has(CITS_SELECTED_OVERLAY_SOURCE_ID), false);
  assert.equal(h.overlay.visible.get(CITS_SELECTED_OVERLAY_SOURCE_ID), false);
  assert.equal(h.subscribers(), 0);
  assert.equal(h.owners.has('cits'), false);
  h.layer.destroy();
  h.layer.destroy();
});

test('zooming out is guidance, not an error', async () => {
  const h = harness();
  h.setAltitude(200_000);
  assert.equal(await h.layer.update(), true);
  const stats = h.layer.getStats();
  assert.equal(stats.status, 'zoom-in');
  assert.equal(stats.error, null);
  assert.equal(stats.statusMessage, 'Zoom in to load C-ITS stations');
});

test('row controls carry uppercase chips and a kind list with live counts', async () => {
  const h = harness();
  await h.refresh();
  const controls = h.layer.getRowControls();
  for (const chip of controls.chips)
    assert.match(chip.label, /^[A-Z ]+( · .+)?$/, chip.id);
  const trams = controls.list.items.find((item) => item.id === 'kind-tram');
  assert.equal(trams.lead, '1');
  assert.equal(trams.active, true);
  h.layer.setParams(trams.params);
  assert.equal(
    h.layer.getRowControls().list.items.find((item) => item.id === 'kind-tram')
      .active,
    false,
  );
  const range = controls.chips.find(
    (chip) => chip.id === 'range-vehicleRangeKm',
  );
  h.layer.setParams(range.params);
  assert.equal(h.layer.getParams().settings.vehicleRangeKm, 120);
  h.layer.setParams({ resetSettings: true });
  assert.equal(h.layer.getParams().settings.vehicleRangeKm, 60);
});

test('stations draw as point items through the draw port and go with the layer', async () => {
  const h = harness();
  await h.refresh();
  const dots = [...h.draw.sets.values()].find((record) =>
    record.spec.id.endsWith(':dots'),
  );
  assert.equal(dots.kind, 'points');
  assert.equal(dots.show, true);
  const tramDot = dots.items.get(`cits:obj:${tram.id}`);
  assert.ok(tramDot, 'the tram is a point item');
  assert.equal(tramDot.disableDepthTest, 0);
  assert.equal(tramDot.color.length, 4);
  assert.ok(Number.isFinite(tramDot.pos.x));
  // The anonymous car is pooled by slot, never by its id.
  assert.ok(dots.items.has('cits:anon:0'));
  assert.ok(![...dots.items.keys()].some((id) => id.includes(car.id)));
  h.layer.disable();
  assert.equal(dots.items.size, 0);
  assert.equal(dots.show, false);
  h.layer.destroy();
  assert.ok(
    [...h.draw.sets.values()].every((record) => record.disposed),
    'every draw set is disposed with the layer',
  );
});

test('anonymous dots are not claimed, and only public stations are named', async () => {
  const h = harness();
  await h.refresh();
  const owns = h.owners.get('cits');
  assert.equal(owns(`cits:obj:${tram.id}`), true);
  assert.equal(owns('cits:anon:0'), false);
  assert.equal(h.layer.findByQuery('cits:anon:0'), null);
  const found = h.layer.findByQuery(`cits:obj:${tram.id}`);
  assert.equal(found.name, 'TRAM · 6 → St. Peter');
  assert.equal(found.latitude, tram.lat);
});
