// Edge case for ais-live-vessels from docs/migration/planet-separation/layers.md:
// a vessel crosses into the next area cell while AIS is interrupted. There is
// never a second request in flight and the card comes back by MMSI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import * as selection from '../../data/selectionDispatcher.js';
import * as picking from '../../data/pickRegistry.js';
import { createVesselLayer } from './index.js';

const noop = () => {};
const RAD = Math.PI / 180;

function recordingRenderer(engine) {
  const sprites = new Set();
  const moveEnd = new Set();
  const camera = {
    positionWC: { x: 0, y: 0, z: 6_500_000 },
    // 60 km up: the layer asks for a 60 km area around the camera.
    positionCartographic: {
      latitude: 40.6 * RAD,
      longitude: -73.9 * RAD,
      height: 60_000,
    },
    rightWC: { x: 1, y: 0, z: 0 },
    upWC: { x: 0, y: 1, z: 0 },
    heading: 0,
    pitch: 0,
    roll: 0,
  };
  let attached = false;
  return {
    sprites,
    camera,
    moveTo(lat, lon) {
      camera.positionCartographic = {
        latitude: lat * RAD,
        longitude: lon * RAD,
        height: 60_000,
      };
      for (const listener of moveEnd) listener();
    },
    renderer: {
      kind: 'plain',
      engine,
      view: {
        camera,
        scene: { canvas: { clientWidth: 0, clientHeight: 0 } },
        horizon: () => ({ isPointVisible: () => true }),
        worldToWindow: () => undefined,
        canvasSize: () => ({ width: 1280, height: 800 }),
        requestRender: noop,
        on(event, listener) {
          if (event !== 'moveEnd') return noop;
          moveEnd.add(listener);
          return () => moveEnd.delete(listener);
        },
      },
      fleet: {
        collection: null,
        attached: () => attached,
        attach() {
          attached = true;
        },
        setVisible: noop,
        add(spec) {
          const sprite = { ...spec };
          sprites.add(sprite);
          return sprite;
        },
        remove: (sprite) => sprites.delete(sprite),
        detach() {
          attached = false;
        },
      },
      pickedRecord: (picked) =>
        picked?.id && typeof picked.id === 'object' ? picked.id : null,
      follow: { onChanged: () => noop, active: () => false },
      trails: { create: () => null },
      destroy: noop,
    },
  };
}

function services(renderer) {
  return {
    context: {
      clearSelectedEntityContextForLayer: noop,
      registerEntityContext: () => null,
      selectEntityContext: noop,
    },
    trails: { createTrail: null },
    labels: {},
    picking,
    overlay: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
      hitTestWorldOverlay: () => null,
    },
    geoid: { ensureGeoidReady: () => new Promise(noop), geoidHeight: () => 0 },
    sprites: {
      registerSpriteCollection: noop,
      restoreSpriteOrder: noop,
      restoreSpriteOrderOnEnable: noop,
    },
    focus: {
      focusNowMs: (now) => now,
      getFocusTarget: () => null,
      focusPassIsNeeded: () => false,
      forgetSpriteFocus: noop,
    },
    worldFocus: { requestWorldFocus: noop },
    render: {
      holdContinuousRender: noop,
      releaseContinuousRender: noop,
      governorRequestRender: noop,
    },
    selection,
    renderer: { create: () => renderer },
  };
}

const row = (mmsi, latitude, longitude, observedAtMs) => ({
  id: mmsi,
  reference: mmsi,
  latitude,
  longitude,
  name: `SHIP ${mmsi}`,
  type: 'Cargo',
  observedAtMs,
  speedMps: 6,
  headingDeg: 90,
  courseDeg: 90,
});

test('edge:ais-live-vessels: a vessel crossing into the next cell during an AIS gap keeps one request and its card by MMSI', async (t) => {
  const engine = createFakeEngine();
  const recorder = recordingRenderer(engine);
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: () => null,
  });
  t.after(() => {
    globalThis.document = previousDocument;
  });
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const responses = [
    // Cell A: the vessel is in view.
    {
      records: [row('111', 40.6, -73.9, 1_000)],
      complete: true,
      transportStatus: 'live',
      rawRowCount: 1,
      observedAtMs: 1_000,
      freshness: 'current',
    },
    // AIS gap: the upstream socket is reconnecting and nothing arrives.
    {
      records: [],
      complete: false,
      transportStatus: 'reconnecting',
      rawRowCount: 0,
      observedAtMs: null,
      freshness: 'stale',
      stale: true,
      reconnectAttempt: 1,
    },
    // Cell B, after the gap: the same MMSI, now across the boundary.
    {
      records: [row('111', 41.2, -73.0, 90_000)],
      complete: true,
      transportStatus: 'live',
      rawRowCount: 1,
      observedAtMs: 90_000,
      freshness: 'current',
    },
  ];
  let release = null;
  const layer = createVesselLayer({
    services: services(recorder.renderer),
    source: {
      async getSnapshot(query) {
        requests.push(query.area ?? null);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          // The gap response is held until the camera has moved on.
          if (requests.length === 2)
            await new Promise((resolve) => {
              release = resolve;
            });
          return {
            source: 'AIS fixture',
            ...responses[Math.min(requests.length, responses.length) - 1],
          };
        } finally {
          inFlight -= 1;
        }
      },
      getTrack: async () => ({ records: [] }),
    },
  });
  t.after(() => layer.destroy());
  layer.init(null, { engine });
  await layer.enable();
  assert.ok(layer.selectById('111'));
  const record = [...recorder.sprites].find(({ id }) => id?.mmsi === '111')?.id;
  assert.ok(record, 'the vessel is drawn in cell A');

  const gap = layer.update();
  // The followed vessel leaves cell A while the gap request is still open:
  // the move must not open a second request beside it.
  recorder.moveTo(41.2, -73.0);
  assert.equal(requests.length, 2);
  release();
  await gap;
  assert.equal(
    layer.getSelectedInfo()?.mmsi,
    '111',
    'the card survives the gap',
  );

  // The next poll asks for cell B and finds the vessel there.
  await layer.update();
  assert.equal(requests.length, 3);
  assert.equal(maxInFlight, 1, 'never two requests at once');
  assert.ok(requests.at(-1), 'the request names an area');
  assert.ok(
    Math.abs(requests.at(-1).lat - 41.2) < 1e-6,
    'the request asks for the new cell',
  );
  const info = layer.getSelectedInfo();
  assert.equal(info?.mmsi, '111', 'the card is restored by MMSI');
  assert.equal(info.latitude, 41.2);
  const drawn = [...recorder.sprites].filter(({ id }) => id?.mmsi === '111');
  assert.equal(drawn.length, 1, 'one chevron for the vessel');
  assert.equal(drawn[0].id, record, 'the same record, not a new contact');
});
