// FIRMS click routes: sprite AND card must both select for detail and hand the
// camera over (pre-launch defect #4 + P1-3). Driven through the production
// click handler and the production card-render path; only the viewer, the
// event handler, the overlay host and the world→window projection are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createFirmsHeatmapLayer,
  applyFirmsOverlayPolicy,
  buildCellCard,
} from './firmsHeatmap.js';
import { fireDetectionKey } from './firmsLabels.js';
import {
  isUnderOtherCard,
  registerPickOwner,
  setClickCardHitTest,
  unregisterPickOwner,
} from './pickRegistry.js';
import { getSelectedEntityContext } from './contextStore.js';
import { setLocale } from '../i18n/index.js';
import { shownEntityLabel } from '../voice/speech.js';
import { WORLD_FOCUS_REQUEST_EVENT } from '../worldFocus.js';
import { readLayerSource } from '../testSupport/readLayerSource.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeInput } from '../input/testDoubles.mjs';
import { bindFakeCesiumScene } from '../testSupport/fakeCesiumScene.mjs';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import { fakeGlobePort } from '../testSupport/fakeGlobePort.mjs';
import { bindRenderer } from '../render/rendererOf.js';
import { HEAT_REBUILD_MS } from '../layers/firms/policy.js';
import { registerStyleStages } from '../styles/styleStages.js';
import { sensorPickPosition } from '../input/sensorPick.js';

const LAYER_SOURCE = readLayerSource(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'firmsHeatmap.js'),
  'utf8',
);

function makeFire(overrides = {}) {
  return {
    index: 7,
    lat: 30.51,
    lon: -98.21,
    frp: 1520.4,
    confidence: 0.9,
    satellite: 'N21',
    sensor: 'VIIRS',
    acqMs: 1_753_600_000_000,
    ...overrides,
  };
}

/** A pick of the layer's glow `id`, as the renderer reports one of its icons. */
const glowPick = (id) => ({ glow: id });

/**
 * Stand the layer up far enough to drive one click. `cardHit` is what the
 * overlay host reports under the click position — the real host only publishes
 * rects for `interactive` entries, so a stub hit is the contract a painted,
 * actionable card presents.
 */
function harness({
  fires = [makeFire()],
  picked = null,
  cardHit = null,
  topCard = null,
  cameraPosition = null,
  withDataSource = false,
  withGlobe = false,
  feed = null,
  drilled = null,
  firstClick = null,
} = {}) {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorProjection = Cesium.SceneTransforms.worldToWindowCoordinates;
  const windowTarget = new EventTarget();
  globalThis.window = windowTarget;
  // Spread projections so the greedy screen-separation declutter accepts every
  // seeded detection; co-located fires would otherwise collide by design.
  let projected = 0;
  Cesium.SceneTransforms.worldToWindowCoordinates = () => {
    projected += 1;
    return { x: 200 * projected, y: 300 };
  };

  const published = [];
  const overlayHost = {
    setEntries: (sourceId, entries) => published.push(...entries),
    setVisible() {},
    clearSource() {},
    hitTest: (_x, _y, { sourceId } = {}) =>
      !sourceId && topCard
        ? topCard
        : cardHit
          ? { sourceId: 'firms', entryId: cardHit }
          : null,
  };
  // The card on top at a click, as the host answers the pick registry.
  setClickCardHitTest((x, y) => overlayHost.hitTest(x, y));
  const layer = createFirmsHeatmapLayer({
    ...(feed ? { feed } : {}),
    id: 'firms-test',
    name: 'Fires',
    overlayHost,
  });

  const draw = fakeDrawPort();
  // A glow pick names the layer's own icon set, as the renderer's pick does.
  const pick = () =>
    picked?.glow
      ? {
          primitive: {},
          id: {
            set: [...draw.sets.values()].find(
              (record) => record.kind === 'icons' && !record.disposed,
            )?.spec.id,
            id: picked.glow,
          },
        }
      : picked;
  const viewer = {
    scene: {
      pick,
      ...(drilled ? { drillPick: () => drilled } : {}),
      canvas: { clientWidth: 1280, clientHeight: 800 },
      camera: cameraPosition ? { positionWC: cameraPosition } : undefined,
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    dataSources: { add() {}, remove() {} },
  };
  // The camera the fade and the bands read, when the test places one.
  if (cameraPosition)
    viewer.camera = {
      positionWC: cameraPosition,
      positionCartographic: Cesium.Cartographic.fromCartesian(cameraPosition),
    };
  // The heatmap drapes through the globe port, for the tests that give one.
  const globe = fakeGlobePort();
  {
    const { unbind, ...ports } = bindFakeCesiumScene(viewer, { draw });
    unbind();
    bindRenderer(viewer, withGlobe ? { ...ports, globe } : ports);
  }
  // Without one, the map stack has nowhere to drape imagery.
  if (!withGlobe)
    layer.attachShellServices({ imageryHost: () => ({ kind: 'none' }) });
  const input = fakeInput(viewer);
  // A subscriber that runs before the layer's own (an aircraft layer).
  if (firstClick) input.input.onClick(firstClick);
  // The LOD rebuild (and with it the context-registration sweep) is inert
  // without a data source, so tests that drive a real refresh need one.
  if (withDataSource) layer.init(viewer);
  layer._bindInteractionForTest(viewer, fires);

  const requests = [];
  windowTarget.addEventListener(WORLD_FOCUS_REQUEST_EVENT, (e) =>
    requests.push(e.detail),
  );

  return {
    layer,
    viewer,
    windowTarget,
    requests,
    published,
    fires,
    globe,
    /** The live glow icon set. */
    icons: () =>
      [...draw.sets.values()].find(
        (record) => record.kind === 'icons' && !record.disposed,
      ),
    click: () => input.click({ x: 400, y: 300 }),
    cover: (hit) => {
      topCard = hit;
    },
    setPicked: (next) => {
      picked = next;
    },
    cleanup() {
      setClickCardHitTest(null);
      Cesium.SceneTransforms.worldToWindowCoordinates = priorProjection;
      if (hadWindow) globalThis.window = priorWindow;
      else delete globalThis.window;
    },
  };
}

test('fire detection key survives a refetch that renumbers the index', () => {
  const fire = makeFire();
  assert.equal(
    fireDetectionKey(fire),
    fireDetectionKey({ ...fire, index: 999 }),
  );
  // Different pass over the same pixel is a different detection.
  assert.notEqual(
    fireDetectionKey(fire),
    fireDetectionKey({ ...fire, acqMs: fire.acqMs + 1 }),
  );
  assert.notEqual(
    fireDetectionKey(fire),
    fireDetectionKey({ ...fire, lat: 31.0 }),
  );
  assert.match(fireDetectionKey({}), /^firms:x:x:0:x$/);
});

test('two satellites over the same pixel at the same time stay distinct', () => {
  // The proxy merges NOAA-20 + NOAA-21 without dedup and their orbits overlap,
  // so position and time alone are NOT unique. Collapsing them let a restored
  // selection land on the other satellite's record. Archived Suomi NPP (`N`)
  // rows must stay distinct too.
  const base = makeFire({ satellite: 'N20' });
  const twin = makeFire({ satellite: 'N21' });
  const suomi = makeFire({ satellite: 'N' });
  assert.notEqual(fireDetectionKey(base), fireDetectionKey(twin));
  assert.notEqual(fireDetectionKey(base), fireDetectionKey(suomi));
  assert.notEqual(fireDetectionKey(twin), fireDetectionKey(suomi));
  // Satellite naming variants normalize to one identity, not three.
  assert.equal(
    fireDetectionKey(base),
    fireDetectionKey(makeFire({ satellite: 'NOAA-20' })),
  );
  assert.equal(
    fireDetectionKey(suomi),
    fireDetectionKey(makeFire({ satellite: 'Suomi NPP' })),
  );
  // A record with no satellite falls back to its sensor, not to a shared blank.
  const sensorOnly = makeFire({ satellite: '', sensor: 'MODIS' });
  assert.notEqual(
    fireDetectionKey(sensorOnly),
    fireDetectionKey(makeFire({ satellite: '', sensor: 'VIIRS' })),
  );
});

test('duplicate-coordinate detections get their own cards and focus targets', () => {
  const n20 = makeFire({ index: 0, satellite: 'N20' });
  const n21 = makeFire({ index: 1, satellite: 'N21' });
  const h = harness({
    fires: [n20, n21],
    picked: { primitive: {}, content: {}, featureId: 0 },
    cardHit: `fire:${fireDetectionKey(n21)}`,
  });
  try {
    const cardIds = h.published
      .filter((e) => e.id.startsWith('fire:'))
      .map((e) => e.id);
    assert.equal(
      new Set(cardIds).size,
      2,
      'co-located detections must not collapse to one card',
    );
    h.click();
    assert.equal(h.requests.length, 1);
    assert.equal(
      h.requests[0].id,
      fireDetectionKey(n21),
      'the clicked card wins, not its twin',
    );
  } finally {
    h.cleanup();
  }
});

test('selection restoration uses the same key the cards and focus use', () => {
  // Restoration ran on raw lat/lon/acqMs, which collapses co-located
  // detections from different satellites — the selection could come back on
  // the wrong record. Reachable only through the 30-minute refetch, so this is
  // a source contract; the key's own behavior is proven above.
  const match = LAYER_SOURCE.match(
    /function findMatchingFire\(previous\) \{([\s\S]*?)\n  \}\n/,
  );
  assert.ok(match, 'findMatchingFire is missing');
  assert.match(match[1], /fireDetectionKey\(previous\)/);
  assert.match(match[1], /fireDetectionKey\(fire\) === key/);
  assert.doesNotMatch(match[1], /fire\.acqMs === previous\.acqMs/);
});

test('painted detection cards are keyed by the stable detection key', () => {
  const h = harness();
  try {
    const card = h.published.find((entry) => entry.id.startsWith('fire:'));
    assert.ok(card, 'a detection card was painted');
    assert.equal(card.id, `fire:${fireDetectionKey(h.fires[0])}`);
    assert.equal(
      card.interactive,
      true,
      'a detection card must publish a hit rect',
    );
    assert.match(card.accessibilityLabel, /^Focus fire detection /);
    assert.equal(card.activate(), true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].id, fireDetectionKey(h.fires[0]));
  } finally {
    h.cleanup();
  }
});

test('an aggregated cell card is never actionable — it is not one fire', () => {
  const cell = buildCellCard(
    {
      cell: {
        count: 14,
        maxFrp: 210,
        newestAcqMs: 0,
        latCell: 30,
        lonCell: -98,
      },
      position: {},
    },
    Date.now(),
  );
  assert.equal(applyFirmsOverlayPolicy(cell, 1e6).interactive, false);
});

test('far-side detections cannot consume the bounded ambient-card cohort', () => {
  const front = makeFire({ index: 1, lat: 30.51, lon: -98.21, frp: 100 });
  const rear = makeFire({ index: 2, lat: -30.51, lon: 81.79, frp: 1000 });
  const cameraPosition = Cesium.Cartesian3.fromDegrees(
    front.lon,
    front.lat,
    10_000_000,
  );
  const h = harness({ fires: [rear, front], cameraPosition });
  try {
    const cardIds = h.published
      .filter((entry) => entry.id.startsWith('fire:'))
      .map((entry) => entry.id);
    assert.deepEqual(cardIds, [`fire:${fireDetectionKey(front)}`]);
  } finally {
    h.cleanup();
  }
});

test('clicking a fire sprite selects it and requests the camera transfer', () => {
  const fire = makeFire();
  const h = harness({
    fires: [fire],
    picked: glowPick('firms-7'),
    topCard: { sourceId: 'earthquakes', entryId: 'quake:cover' },
  });
  try {
    // Under another layer's card the sprite is that card's click.
    h.click();
    assert.equal(h.requests.length, 0, 'covered: the card takes it');
    h.cover(null);
    h.click();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].kind, 'fire');
    assert.equal(h.requests[0].id, fireDetectionKey(fire));
    assert.ok(h.requests[0].position, 'the transfer needs a world position');
  } finally {
    h.cleanup();
  }
});

test('an item named like a fire in another draw set is not a fire', () => {
  const h = harness({
    fires: [makeFire()],
    picked: {
      primitive: {},
      id: { set: 'other-layer:1:icons', id: 'firms-7' },
    },
  });
  try {
    h.click();
    assert.equal(h.requests.length, 0);
  } finally {
    h.cleanup();
  }
});

test('clicking a fire CARD behaves exactly like clicking its sprite', () => {
  const fire = makeFire();
  // The click lands on the card, but the scene pick returns the 3D-Tiles
  // surface behind it — the case that used to clear the selection.
  const h = harness({
    fires: [fire],
    picked: { primitive: {}, content: {}, featureId: 0 },
    cardHit: `fire:${fireDetectionKey(fire)}`,
  });
  try {
    h.click();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].kind, 'fire');
    assert.equal(h.requests[0].id, fireDetectionKey(fire));
  } finally {
    h.cleanup();
  }
});

test('a covered fire card does not act, and keeps an existing selection', () => {
  const fire = makeFire();
  const h = harness({
    fires: [fire],
    cardHit: `fire:${fireDetectionKey(fire)}`,
  });
  try {
    // Covered by another layer's card from the start: nothing selects or flies.
    h.cover({ sourceId: 'earthquakes', entryId: 'quake:cover' });
    h.click();
    assert.equal(h.requests.length, 0);
    assert.equal(h.layer.getSelectedInfo(), null);
    // Uncovered, the card selects; covered again, the click is the other
    // layer's and leaves that selection alone.
    h.cover(null);
    h.click();
    assert.equal(h.requests.length, 1);
    const selected = h.layer.getSelectedInfo();
    assert.ok(selected);
    h.cover({ sourceId: 'earthquakes', entryId: 'quake:cover' });
    h.click();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.layer.getSelectedInfo(), selected);
  } finally {
    h.cleanup();
  }
});

// The voice model reads these labels as data (track_entity, get_entity_context,
// pointer_context); the voice card translates them where it shows them.
test('fire labels stay English data in a translated interface', () => {
  const h = harness({ fires: [makeFire()], picked: glowPick('firms-7') });
  try {
    setLocale('ru');
    h.click();
    assert.equal(getSelectedEntityContext().label, 'Fire · FRP 1520 MW');
    // The card's pattern must match what the producer actually writes.
    assert.equal(
      shownEntityLabel(getSelectedEntityContext().label),
      'Пожар · FRP 1520 МВт',
    );
    assert.equal(h.layer.getSelectedInfo().label, 'Fire · FRP 1520 MW');
    assert.equal(h.layer.getStrongestFire().label, 'Fire · FRP 1520 MW');
  } finally {
    h.cleanup();
    setLocale('en');
  }
});

test('a click on neither sprite nor card clears without moving the camera', () => {
  const h = harness({ picked: { primitive: {}, content: {}, featureId: 0 } });
  try {
    h.click();
    assert.equal(h.requests.length, 0);
  } finally {
    h.cleanup();
  }
});

// Sibling layers surface heterogeneous pick shapes. Whatever is drawn under
// it, the fire card painted on top takes the click (those layers stand aside
// under another layer's card, so one click does one thing).
const SIBLING_PICKS = [
  ['flights', 'a1b2c3', { id: 'a1b2c3' }],
  ['flights', 'a1b2c3', { primitive: { id: 'a1b2c3' } }],
  ['ais-live-vessels', '353136000', { id: '353136000' }],
  ['cctv', 'atx-cam-3', { id: { id: 'atx-cam-3', name: 'entity-like' } }],
  ['satellites', '25544', { id: 25544 }],
];

for (const [layerId, ownedId, picked] of SIBLING_PICKS) {
  test(`a fire card wins over a ${layerId} pick shaped ${JSON.stringify(picked)}`, () => {
    const fire = makeFire();
    registerPickOwner(layerId, (pickedId) => pickedId === ownedId);
    const h = harness({
      fires: [fire],
      picked,
      cardHit: `fire:${fireDetectionKey(fire)}`,
    });
    try {
      h.click();
      assert.equal(h.requests.length, 1, 'the card on top acts');
    } finally {
      h.cleanup();
      unregisterPickOwner(layerId);
    }
  });
}

// A passive owner's pick (a directions route, a flight trail) acts for nobody:
// a fire card over it still takes the click, and with no card the pick is
// still not empty space, so the selection stays.
test('a fire card acts over a passive pick; the bare pick leaves the selection', () => {
  const fire = makeFire();
  registerPickOwner('test-route', (pickedId) => pickedId === 'route:line');
  const carded = harness({
    fires: [fire],
    picked: { id: 'route:line' },
    cardHit: `fire:${fireDetectionKey(fire)}`,
  });
  try {
    carded.click();
    assert.equal(carded.requests.length, 1, 'the card acts over the route');
    assert.ok(carded.layer.getSelectedInfo());
  } finally {
    carded.cleanup();
  }
  const bare = harness({ fires: [fire], picked: { id: 'route:line' } });
  try {
    bare.click();
    assert.equal(bare.requests.length, 0);
    assert.equal(
      bare.layer.getSelectedInfo(),
      null,
      'nothing to clear or pick',
    );
  } finally {
    bare.cleanup();
    unregisterPickOwner('test-route');
  }
});

// A coarse tap on a fire card finds an aircraft nearby through the shared
// touch contact. The card on top takes it; the aircraft layer stands aside.
test('a fire card takes a tap over a touch contact its layer acts on', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const fire = makeFire();
  registerPickOwner('test-planes', (pickedId) => pickedId === 'plane:1');
  t.after(() => unregisterPickOwner('test-planes'));
  const h = harness({
    fires: [fire],
    drilled: [{ id: 'plane:1' }],
    cardHit: `fire:${fireDetectionKey(fire)}`,
  });
  try {
    h.click();
    assert.equal(h.requests.length, 1, 'the card takes the tap');
    assert.ok(h.layer.getSelectedInfo());
  } finally {
    h.cleanup();
  }
});

// A touch contact whose layer acts only on exact hits does not take the tap
// from our card; with no card, a coarse tap near an aircraft still clears.
test('a fire card keeps a tap whose contact does not act; bare taps still clear', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const fire = makeFire();
  registerPickOwner('test-cameras', (pickedId) => pickedId === 'cam:1');
  registerPickOwner('test-planes', (pickedId) => pickedId === 'plane:1');
  t.after(() => {
    unregisterPickOwner('test-cameras');
    unregisterPickOwner('test-planes');
  });
  const carded = harness({
    fires: [fire],
    drilled: [{ id: 'cam:1' }],
    cardHit: `fire:${fireDetectionKey(fire)}`,
  });
  try {
    carded.click();
    assert.equal(carded.requests.length, 1, 'the card acts');
  } finally {
    carded.cleanup();
  }
  const bare = harness({
    fires: [fire],
    picked: glowPick('firms-7'),
    drilled: [{ id: 'plane:1' }],
  });
  try {
    bare.click();
    assert.ok(bare.layer.getSelectedInfo(), 'a fire is selected');
    // Nothing exact now; the touch contact is an aircraft, with no card.
    bare.setPicked(null);
    bare.click();
    assert.equal(bare.layer.getSelectedInfo(), null, 'the bare tap clears');
  } finally {
    bare.cleanup();
  }
});

// The aircraft layer runs first. Under the fire card painted over its plane
// it stands aside, so the card takes the click: one action, in either order.
test('a fire card over an aircraft takes the click; the aircraft does not track', (t) => {
  const fire = makeFire();
  let tracked = null;
  registerPickOwner('test-planes', (pickedId) => pickedId === 'plane:9');
  t.after(() => unregisterPickOwner('test-planes'));
  const h = harness({
    fires: [fire],
    picked: { id: 'plane:9' },
    cardHit: `fire:${fireDetectionKey(fire)}`,
    firstClick: (event) => {
      if (isUnderOtherCard(event)) return;
      if (event.hit?.id === 'plane:9') tracked = 'plane:9';
    },
  });
  try {
    h.click();
    assert.equal(tracked, null, 'the aircraft does not track');
    assert.equal(h.requests.length, 1, 'the fire card acts');
    assert.ok(h.layer.getSelectedInfo());
  } finally {
    h.cleanup();
  }
});

test('a stale card id resolves to nothing instead of an arbitrary fire', () => {
  const h = harness({
    picked: { primitive: {}, content: {}, featureId: 0 },
    cardHit: 'fire:firms:1.0000:1.0000:1:N20',
  });
  try {
    h.click();
    assert.equal(h.requests.length, 0);
  } finally {
    h.cleanup();
  }
});

test('a refresh that drops the selected fire emits an eviction the readout can act on', async () => {
  // Behavioral, not a source pin: the tag was present and correct while the
  // event never fired, because the LOD rebuild deletes the selected context
  // record first and the clear then fails its ownership guard silently.
  const kept = makeFire({ index: 0 });
  const dropped = makeFire({
    index: 1,
    lat: 31.77,
    lon: -99.02,
    acqMs: 1_753_600_100_000,
    satellite: 'N20',
  });
  const h = harness({
    fires: [dropped, kept],
    cardHit: `fire:${fireDetectionKey(dropped)}`,
    withDataSource: true,
  });
  const cleared = [];
  h.windowTarget.addEventListener('gev:entity-selection-cleared', (e) =>
    cleared.push(e.detail),
  );
  const priorFetch = globalThis.fetch;

  try {
    h.click();
    assert.equal(
      h.requests.length,
      1,
      'the click must select the fire we are about to drop',
    );
    assert.equal(h.requests[0].id, fireDetectionKey(dropped));
    assert.deepEqual(cleared, [], 'selecting must not clear anything yet');

    // A normal, NON-EMPTY refresh that simply no longer carries that detection.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        fetchedAt: Date.now(),
        stale: false,
        fires: [
          {
            lat: kept.lat,
            lon: kept.lon,
            frp: kept.frp,
            confidence: 'h',
            brightness: 330,
            daynight: 'D',
            acqDate: '2025-07-27',
            acqTime: '0412',
            instrument: 'VIIRS',
            satellite: kept.satellite,
          },
        ],
      }),
    });
    await h.layer.update();

    assert.equal(
      cleared.length,
      1,
      'a vanished selection must reach consumers as an event, not as silence',
    );
    assert.equal(cleared[0].layerId, 'firms-test');
    assert.equal(
      cleared[0].reason,
      'evicted',
      'the detection left the feed — it was not deselected',
    );
  } finally {
    if (priorFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = priorFetch;
    h.cleanup();
  }
});

test('disable cancels a pending source and a late response cannot repopulate the layer', async () => {
  let resolve, signal;
  const h = harness({
    withDataSource: true,
    feed: {
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
  });
  try {
    const before = h.layer.getStats();
    const pending = h.layer.update();
    h.layer.disable();
    assert.equal(signal.aborted, true);
    resolve({ fires: [], fetchedAt: Date.now() });
    await pending;
    assert.equal(h.layer.getStats().count, before.count);
    assert.equal(h.layer.getStats().lastUpdate, before.lastUpdate);
    assert.equal(h.layer.getStats().loading, false);
  } finally {
    h.layer.destroy(h.viewer);
    h.cleanup();
  }
});

test('the heatmap is preloaded under the markers before the first zoom-out', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const priorDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        createImageData: (w, hh) => ({
          data: new Uint8ClampedArray(w * hh * 4),
        }),
        putImageData() {},
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {},
      }),
      toDataURL: () => 'data:image/png;base64,AAAA',
    }),
  };
  const h = harness({
    withDataSource: true,
    withGlobe: true,
    cameraPosition: Cesium.Cartesian3.fromDegrees(-98, 30, 1_000_000),
  });
  const added = h.globe.added;
  try {
    h.layer.attachShellServices({ imageryHost: () => ({ kind: 'globe' }) });
    h.layer._renderLodForTest('close');
    assert.equal(added.length, 0, 'the markers paint first; the build trails');
    t.mock.timers.tick(HEAT_REBUILD_MS);
    assert.equal(added.length, 1, 'then the heatmap is draped');
    assert.equal(added[0].alpha, 0, 'invisible until the hand-off');
    assert.equal(added[0].show, true, 'but mapped onto the globe tiles');
  } finally {
    h.layer.destroy(h.viewer);
    h.cleanup();
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});

test('far zoom drapes one heatmap and the hand-off cross-fades it with the markers', () => {
  // A canvas stub for the heat drape and the detection glow sprites.
  const priorDocument = globalThis.document;
  const restoreDocument = () => {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  };
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        createImageData: (w, hh) => ({
          data: new Uint8ClampedArray(w * hh * 4),
        }),
        putImageData() {},
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {},
      }),
      toDataURL: () => 'data:image/png;base64,AAAA',
    }),
  };
  const h = harness({
    fires: [makeFire(), makeFire({ index: 8, lat: 30.6, lon: -98.3, frp: 12 })],
    withDataSource: true,
    withGlobe: true,
    cameraPosition: Cesium.Cartesian3.fromDegrees(-98, 30, 12_000_000),
  });
  const added = h.globe.added;
  // The fade and the bands read the camera height.
  const setHeight = (height) => {
    h.viewer.camera.positionCartographic.height = height;
  };
  const markers = () => h.icons();
  const glow = (i) => [...markers().items.values()][i];
  try {
    h.layer.attachShellServices({ imageryHost: () => ({ kind: 'globe' }) });
    h.layer._renderLodForTest('global');
    assert.equal(added.length, 1, 'one heat imagery layer');
    assert.equal(added[0].show, true);
    assert.equal(added[0].alpha, 1);
    assert.equal(h.layer._entityCountForTest(), 0, 'no rectangle entities');
    assert.ok(h.published.length > 0, 'the far band still paints cards');
    assert.equal(
      markers().items.size,
      2,
      'the markers are built under the heatmap',
    );
    assert.equal(
      markers().show,
      false,
      'and hidden while the heatmap is whole',
    );

    h.layer._renderLodForTest('regional');
    assert.equal(added.length, 1, 'switching far bands reuses the raster');

    setHeight(1_000_000);
    h.layer._renderLodForTest('close');
    assert.equal(added.length, 1, 'the markers band keeps the same heat layer');
    assert.equal(added[0].show, true, 'still mapped onto the globe tiles');
    assert.equal(added[0].alpha, 0, 'faded out under the markers');
    assert.equal(markers().show, true);
    assert.equal(glow(0).alpha, 1);

    // Mid hand-off both are drawn, half each, in either band.
    setHeight(4_500_000);
    h.layer._applyHandoffFadeForTest();
    assert.equal(added[0].alpha, 0.5);
    assert.equal(markers().show, true);
    assert.equal(glow(0).alpha, 0.5);
    h.layer._renderLodForTest('regional');
    assert.equal(added[0].alpha, 0.5);
    assert.equal(glow(1).alpha, 0.5, 'rebuilt markers get the fade');

    // An application drawing the detections in their place hides both.
    h.layer.setMarkerStandIn({ hitTest: () => null });
    assert.equal(added[0].show, false, 'a stand-in hides the heatmap');
    assert.equal(markers().show, false, 'and the markers');
    h.layer._renderLodForTest('global');
    assert.equal(added[0].show, false, 'through a rebuild too');
    h.layer.setMarkerStandIn(null);
    assert.equal(added[0].show, true);
    assert.equal(markers().show, true);

    h.layer.disable();
    assert.equal(added[0].show, false, 'disable hides the heatmap');

    h.layer.destroy(h.viewer);
    assert.equal(added[0].removed, true);
    assert.equal(h.globe.imagery.list().length, 0);
  } finally {
    h.cleanup();
    restoreDocument();
  }
});

test('a click on a fire an application draws in place of the markers selects it as a marker click does', () => {
  const fire = makeFire();
  const other = makeFire({ index: 8, lat: 31.2, lon: -97.9, frp: 40 });
  // The application's records come from the same source, adapted on their own.
  let answer = { ...fire };
  const asked = [];
  const h = harness({ fires: [fire, other], picked: glowPick('firms-8') });
  try {
    h.layer.setMarkerStandIn({
      hitTest: (screen) => {
        asked.push(screen);
        return answer;
      },
    });
    assert.equal(h.icons().show, false, 'the glows are hidden');
    h.published.length = 0;
    h.click();
    assert.deepEqual(asked, [{ x: 400, y: 300 }]);
    assert.equal(h.requests.length, 1, 'the camera moves as for a marker');
    assert.equal(h.requests[0].kind, 'fire');
    assert.equal(
      h.requests[0].id,
      fireDetectionKey(fire),
      'the stand-in decides, not the hidden glow under the click',
    );
    assert.equal('rangeM' in h.requests[0], false, 'the usual fire framing');
    assert.equal(h.layer.getSelectedInfo().id, fireDetectionKey(fire));
    assert.equal(getSelectedEntityContext().label, 'Fire · FRP 1520 MW');
    assert.deepEqual(
      h.published.map((entry) => entry.id),
      [`selected-fire:${fireDetectionKey(fire)}`],
      "only the selected fire's card shows",
    );

    // Nothing of the application's under the click: empty space.
    answer = null;
    h.click();
    assert.equal(h.requests.length, 1, 'no camera move');
    assert.equal(h.layer.getSelectedInfo(), null, 'the selection is cleared');
  } finally {
    h.cleanup();
  }
});

test('a stand-in that draws a fire larger says how far the camera stands from it', () => {
  const fire = makeFire();
  const asked = [];
  let range = 24_000;
  const h = harness({ fires: [fire] });
  try {
    h.layer.setMarkerStandIn({
      hitTest: () => ({ ...fire }),
      focusRangeM: (record) => {
        asked.push(fireDetectionKey(record));
        return range;
      },
    });
    h.click();
    assert.deepEqual(asked, [fireDetectionKey(fire)]);
    assert.equal(h.requests.at(-1).rangeM, 24_000);
    // No range for this fire: the usual fire framing.
    range = null;
    h.click();
    assert.equal(h.requests.length, 2);
    assert.equal('rangeM' in h.requests.at(-1), false);
  } finally {
    h.cleanup();
  }
});

test('a stand-in hit on a fire the layer does not show selects nothing', () => {
  const fire = makeFire();
  const h = harness({ fires: [fire] });
  try {
    h.layer.setMarkerStandIn({
      hitTest: () => makeFire({ lat: 12.5, lon: 40.1 }),
    });
    h.click();
    assert.equal(h.requests.length, 0);
    assert.equal(h.layer.getSelectedInfo(), null);
  } finally {
    h.cleanup();
  }
});

test('taking the stand-in away brings the markers and their cards back and keeps the selection', () => {
  const fire = makeFire();
  const h = harness({
    fires: [fire],
    // Near enough for the markers rather than the heatmap.
    cameraPosition: Cesium.Cartesian3.fromDegrees(fire.lon, fire.lat, 500_000),
  });
  try {
    h.layer.setMarkerStandIn({ hitTest: () => fire });
    assert.equal(h.icons().show, false);
    h.click();
    h.layer.setMarkerStandIn(null);
    assert.equal(h.icons().show, true);
    assert.equal(h.layer.getSelectedInfo().id, fireDetectionKey(fire));
    const ids = h.published.map((entry) => entry.id);
    assert.ok(ids.includes(`selected-fire:${fireDetectionKey(fire)}`));
  } finally {
    h.cleanup();
  }
});

test('the stand-in is asked where a marker is picked: the click as the sensor style draws it', () => {
  const fire = makeFire();
  const asked = [];
  const h = harness({ fires: [fire] });
  try {
    registerStyleStages(h.viewer.scene, {
      surveillance: {
        enabled: true,
        uniforms: { intensity: 1, pixelation: 4 },
      },
    });
    h.layer.setMarkerStandIn({
      hitTest: (screen) => {
        asked.push(screen);
        return fire;
      },
    });
    h.click();
    const expected = sensorPickPosition(
      h.viewer.scene,
      { x: 400, y: 300 },
      h.viewer.scene.canvas,
    );
    assert.notDeepEqual([expected.x, expected.y], [400, 300]);
    assert.deepEqual([asked[0].x, asked[0].y], [expected.x, expected.y]);
  } finally {
    h.cleanup();
  }
});

test("a sibling layer's item over a stand-in fire wins the click", () => {
  const fire = makeFire();
  let asked = 0;
  registerPickOwner('flights', (pickedId) => pickedId === 'a1b2c3');
  const h = harness({ fires: [fire], picked: { id: 'a1b2c3' } });
  try {
    h.layer.setMarkerStandIn({
      hitTest: () => {
        asked++;
        return fire;
      },
    });
    h.click();
    assert.equal(asked, 0, 'the stand-in is not asked');
    assert.equal(h.requests.length, 0, 'no camera move');
    assert.equal(h.layer.getSelectedInfo(), null);
  } finally {
    h.cleanup();
    unregisterPickOwner('flights');
  }
});
