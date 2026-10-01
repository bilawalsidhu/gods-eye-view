import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { WILDLIFE_PAGE_SIZE, WILDLIFE_STUDIES } from './records.js';
import {
  createWildlifeLayer,
  wildlifeErrorReason,
  wildlifeGlyph,
  wildlifeTrackChunks,
} from './index.js';

const NOW = Date.parse('2026-09-30T10:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GULLS = 1258895879;
const STORKS = 21231406;
const SPOONBILLS = 2313947453;

const studies = (statuses = {}) =>
  WILDLIFE_STUDIES.map((study) => ({
    ...study,
    status: statuses[study.id] || 'fresh',
    fetchedAt: NOW,
  }));
const animal = (
  study,
  name,
  taxon,
  lastAge,
  lon = 4,
  lat = 51.6,
  fixes = 4,
) => ({
  id: `${study}:${name}`,
  study,
  name,
  taxon,
  track: Array.from({ length: fixes }, (_, i) => [
    lon,
    lat - (fixes - 1 - i) * 0.05,
    NOW - lastAge - (fixes - 1 - i) * HOUR,
  ]),
});
const ANIMALS = [
  animal(GULLS, 'H903', 'Larus argentatus', 2 * HOUR),
  animal(GULLS, 'L77', 'Larus fuscus', 10 * DAY, 3.5, 51.2),
  animal(STORKS, 'AU057', 'Ciconia ciconia', 3 * HOUR, 8.4, 48.1, 1),
  animal(SPOONBILLS, 'OLD', 'Platalea leucorodia', 400 * DAY, 4.4, 51.3),
];

function harness({ animals = ANIMALS, statuses = {}, picking = null } = {}) {
  const sources = [];
  const flights = [];
  const opened = [];
  const handlers = [];
  const timers = new Map();
  const rotations = [];
  let timerId = 0;
  let preRender = null;
  let picked;
  let fail = false;
  let snapshot = { studies: studies(statuses), animals };
  class FakeHandler {
    constructor() {
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(callback, type) {
      this.actions.set(type, callback);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(5, 50, 3_000_000),
      heading: 0,
      pitch: -1.5,
      roll: 0,
      flyTo(options) {
        flights.push(options);
      },
    },
    scene: {
      canvas: {},
      requestRender() {},
      pick: () => picked,
      preRender: {
        addEventListener(callback) {
          preRender = callback;
          return () => {
            preRender = null;
          };
        },
      },
    },
  };
  let pose = 'a';
  const layer = createWildlifeLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('Wildlife HTTP 502');
        return snapshot;
      },
    },
    cesium: { ...Cesium, ScreenSpaceEventHandler: FakeHandler },
    rotate: (scene, position, heading, previous) => {
      rotations.push(heading);
      return previous + 0.5;
    },
    poseSignature: () => pose,
    now: () => NOW,
    matchMedia: () => ({ matches: true }),
    openExternal: (url) => opened.push(url),
    setTimer: (callback, ms) => {
      timers.set(++timerId, { callback, ms });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
    picking,
    pointer: { isPointerFree: () => true },
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    sources,
    flights,
    opened,
    handlers,
    timers,
    rotations,
    setSnapshot(value) {
      snapshot = value;
    },
    fail(value) {
      fail = value;
    },
    movePose(value) {
      pose = value;
    },
    entityIds: () => sources[0].entities.values.map(({ id }) => id),
    runPreRender: () => preRender?.(),
    hasPreRender: () => preRender !== null,
    click(pick) {
      picked = pick;
      handlers.at(-1).actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
        position: new Cesium.Cartesian2(1, 1),
      });
    },
  };
}

function fakePicking() {
  const owners = new Map();
  return {
    owners,
    registerPickOwner(id, predicate) {
      owners.set(id, predicate);
    },
    unregisterPickOwner(id) {
      owners.delete(id);
    },
    resolvePickId: (value) => value?.id?.id ?? value?.id ?? null,
    isOwnedByOtherLayer: (layerId, pickedId) =>
      [...owners].some(([id, owns]) => id !== layerId && owns(pickedId)),
  };
}

test('the layer needs a source and cannot be initialized twice', () => {
  assert.throws(() => createWildlifeLayer({}), TypeError);
  const { layer } = harness();
  assert.throws(() => layer.init({ dataSources: { add() {} } }), /already/);
});

test('paths split into overlapping thirds that fade toward the past', () => {
  assert.deepEqual(wildlifeTrackChunks([[0, 0, 1]]), []);
  const two = wildlifeTrackChunks([
    [0, 0, 1],
    [1, 0, 2],
  ]);
  assert.deepEqual(two, [
    {
      fixes: [
        [0, 0, 1],
        [1, 0, 2],
      ],
      alpha: 0.85,
    },
  ]);
  const track = Array.from({ length: 20 }, (_, i) => [i, 0, i + 1]);
  const chunks = wildlifeTrackChunks(track);
  assert.deepEqual(
    chunks.map(({ fixes, alpha }) => [fixes[0][0], fixes.at(-1)[0], alpha]),
    [
      [0, 6, 0.2],
      [6, 12, 0.45],
      [12, 19, 0.85],
    ],
  );
  assert.match(wildlifeGlyph('#fff', true), /^data:image\/svg\+xml;base64,/);
  assert.notEqual(wildlifeGlyph('#fff', true), wildlifeGlyph('#fff', false));
  assert.equal(wildlifeGlyph('#fff', true), wildlifeGlyph('#fff', true));
});

test('an enabled refresh draws a glyph and fading path per animal in the window', async () => {
  const h = harness();
  assert.equal(await h.layer.update(), false, 'disabled layers do not fetch');
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.deepEqual(h.entityIds(), [
    `wildlife:${GULLS}:H903:track:0`,
    `wildlife:${GULLS}:H903:track:1`,
    `wildlife:${GULLS}:H903:track:2`,
    `wildlife:${GULLS}:H903`,
    `wildlife:${GULLS}:L77:track:0`,
    `wildlife:${GULLS}:L77:track:1`,
    `wildlife:${GULLS}:L77:track:2`,
    `wildlife:${GULLS}:L77`,
    `wildlife:${STORKS}:AU057`,
  ]);
  const glyph = h.sources[0].entities.getById(`wildlife:${GULLS}:H903`);
  assert.deepEqual(
    glyph.billboard.alignedAxis.getValue(),
    Cesium.Cartesian3.ZERO,
  );
  assert.equal(
    glyph.billboard.disableDepthTestDistance.getValue(),
    Number.POSITIVE_INFINITY,
  );
  const path = h.sources[0].entities.getById(`wildlife:${GULLS}:H903:track:2`);
  assert.equal(path.polyline.clampToGround.getValue(), true);
  assert.equal(path.polyline.arcType.getValue(), Cesium.ArcType.GEODESIC);
  assert.equal(
    path.polyline.classificationType.getValue(),
    Cesium.ClassificationType.BOTH,
  );
  assert.ok(path.polyline.material.color.getValue().alpha > 0.8);
  const stork = h.sources[0].entities.getById(`wildlife:${STORKS}:AU057`);
  assert.notEqual(
    stork.billboard.image.getValue(),
    glyph.billboard.image.getValue(),
    'a single fix is a dot, not an arrow',
  );
  assert.deepEqual(h.layer.getStats(), {
    count: 3,
    lastUpdate: NOW,
    error: null,
    partial: false,
  });
  assert.equal(h.layer.getDiagnostics().tracks, 6);
  const controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.chips.map(({ id, active }) => [id, active]),
    [
      ['movebank', undefined],
      ['window-month', false],
      ['window-year', true],
      ['window-all', false],
    ],
  );
  assert.deepEqual(
    controls.legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Herring gull', '#56B4E9', 1],
      ['LBB gull', '#D55E00', 1],
      ['White stork', '#E69F00', 1],
    ],
  );
  assert.match(controls.legend[0].blurb, /Colour shows species/);
  assert.deepEqual(
    controls.list.items.slice(0, 3).map(({ lead, text }) => [lead, text]),
    [
      ['2', 'Gulls · Neeltje Jans · last fix 2 h ago'],
      ['1', 'Storks · SW Germany · last fix 3 h ago'],
      ['0', 'Spoonbills · Flanders · last fix 13 months ago'],
    ],
  );
  for (const { lead, text } of controls.list.items.slice(3)) {
    assert.equal(lead, '—', 'nothing public: a dash, not a count');
    assert.match(text, / · no public fixes$/);
  }
  assert.equal(controls.list.items.length, WILDLIFE_STUDIES.length);
  assert.match(
    controls.info,
    /^3 animals in 2 studies · select an arrow · CC0 · fixes may lag hours$/,
  );
  assert.match(controls.info, /CC0/);
  assert.match(controls.infoTitle, /Not for locating or disturbing animals/);
});

test('glyphs point along the last move, recomputed only when the camera moves', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  assert.ok(h.hasPreRender());
  assert.deepEqual(
    h.rotations.map(Math.round),
    [0, 0],
    'both moving gulls head north; the one-fix stork is not rotated',
  );
  const glyph = h.sources[0].entities.getById(`wildlife:${GULLS}:H903`);
  assert.equal(glyph.billboard.rotation.getValue(), 0.5);
  h.runPreRender();
  assert.equal(h.rotations.length, 2, 'an unchanged pose does no work');
  h.movePose('b');
  h.runPreRender();
  assert.equal(h.rotations.length, 4);
  assert.equal(glyph.billboard.rotation.getValue(), 1);
});

test('the far side of the globe is culled by hand', async () => {
  const h = harness({
    animals: [
      ...ANIMALS,
      animal(GULLS, 'FAR', 'Larus argentatus', HOUR, -175, -40),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  const far = h.sources[0].entities.getById(`wildlife:${GULLS}:FAR`);
  const near = h.sources[0].entities.getById(`wildlife:${GULLS}:H903`);
  assert.equal(far.show, false);
  assert.equal(near.show, true);
});

test('the time window chooses which animals are drawn', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ window: 'month' });
  assert.equal(h.layer.getStats().count, 3);
  h.layer.setParams({ window: 'all' });
  assert.equal(h.layer.getStats().count, 4);
  assert.deepEqual(
    h.layer
      .getRowControls()
      .chips.filter(({ id }) => id.startsWith('window-'))
      .map(({ label }) => label),
    ['30 days', '1 year', 'All time'],
  );
  h.layer.setParams({ window: 'bogus' });
  assert.equal(h.layer.getDiagnostics().window, 'all');
  h.setSnapshot({ studies: studies(), animals: [ANIMALS[1]] });
  h.layer.setParams({ window: 'month' });
  await h.layer.update();
  assert.equal(h.layer.getStats().count, 1);
  h.setSnapshot({ studies: studies(), animals: [ANIMALS[3]] });
  await h.layer.update();
  assert.equal(h.layer.getStats().count, 0);
  assert.match(
    h.layer.getRowControls().info,
    /^No animals in the last 30 days/,
  );
});

test('a study lists its animals, latest first, and cites its dataset', async () => {
  const h = harness();
  h.layer.enable();
  h.layer.attachShellServices({ runNavigation: (navigate) => navigate() });
  await h.layer.update();
  h.layer.setParams({ study: GULLS, focus: true });
  assert.equal(h.flights.length, 1);
  assert.ok(h.flights[0].destination instanceof Cesium.Rectangle);
  assert.equal(h.flights[0].duration, 0, 'reduced motion is honored');
  assert.equal(h.layer.getStats().count, 2, 'only the study is drawn');
  const controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.chips.map(({ id }) => id),
    ['window-month', 'window-year', 'window-all', 'doi', 'studies'],
  );
  assert.equal(controls.chips.at(-2).label, 'DOI ↗');
  assert.deepEqual(
    controls.list.items.map(({ ordinal, lead, text }) => [ordinal, lead, text]),
    [
      [1, '2h', 'Herring gull · H903'],
      [2, '10d', 'LBB gull · L77'],
    ],
    'a two-species study names the species; one page has no page count',
  );
  assert.equal(
    controls.info,
    'Gulls · Neeltje Jans · 2 animals · select a row · CC0 · fixes may lag hours',
  );
  assert.match(controls.infoTitle, /Cite: Stienen EWM/);
  assert.match(
    controls.infoTitle,
    /https:\/\/doi\.org\/10\.5281\/zenodo\.10209520/,
  );
  h.layer.setParams({ doi: true });
  assert.deepEqual(h.opened, ['https://doi.org/10.5281/zenodo.10209520']);
  h.layer.setParams({ study: 12345 });
  assert.equal(h.layer.getDiagnostics().selectedStudy, GULLS);
  h.layer.setParams({ clear: true });
  assert.equal(h.layer.getDiagnostics().selectedStudy, null);
  assert.equal(h.layer.getStats().count, 3);
  h.layer.setParams({ movebank: true });
  assert.equal(h.opened.at(-1), 'https://www.movebank.org/');
});

test('choosing an animal names its species, study, owner and last fix', async () => {
  const h = harness();
  h.layer.enable();
  h.layer.attachShellServices({ runNavigation: (navigate) => navigate() });
  await h.layer.update();
  h.layer.setParams({ animal: `${GULLS}:H903`, focus: true });
  const diagnostics = h.layer.getDiagnostics();
  assert.equal(diagnostics.selectedStudy, GULLS);
  assert.equal(diagnostics.selectedAnimal, `${GULLS}:H903`);
  assert.ok(h.flights.at(-1).destination instanceof Cesium.Cartesian3);
  const controls = h.layer.getRowControls();
  assert.equal(
    controls.info,
    'Herring gull H903 · 2 h ago (2026-09-30 08:00 UTC) · Gulls · Neeltje Jans · INBO — Stienen, Buijs, de Visser et al. · CC0 1.0',
  );
  assert.match(controls.infoTitle, /^Herring gull \(Larus argentatus\) H903\./);
  assert.equal(controls.list.items[0].active, true);
  const glyph = h.sources[0].entities.getById(`wildlife:${GULLS}:H903`);
  assert.ok(glyph.billboard.scale.getValue() > 1);
  const path = h.sources[0].entities.getById(`wildlife:${GULLS}:H903:track:0`);
  assert.equal(path.polyline.width.getValue(), 3.5);
  h.layer.setParams({ animal: null });
  assert.equal(h.layer.getDiagnostics().selectedAnimal, null);
  assert.ok(glyph.billboard.scale.getValue() < 1);
  assert.equal(path.polyline.width.getValue(), 2);
  h.layer.setParams({ animal: 'nobody' });
  assert.equal(h.layer.getDiagnostics().selectedAnimal, null);
});

test('a stale navigation is dropped when the selection changes first', async () => {
  const h = harness();
  h.layer.enable();
  const queued = [];
  h.layer.attachShellServices({
    runNavigation: (navigate) => queued.push(navigate),
  });
  await h.layer.update();
  h.layer.setParams({ animal: `${GULLS}:H903`, focus: true });
  h.layer.setParams({ animal: `${GULLS}:L77` });
  queued[0]();
  assert.equal(h.flights.length, 0);
  queued[1]?.();
  h.layer.attachShellServices(null);
  h.layer.setParams({ animal: `${GULLS}:H903`, focus: true });
  assert.equal(queued.length, 1, 'no navigation without the shell');
  assert.equal(h.layer.getDiagnostics().selectedAnimal, `${GULLS}:H903`);
});

test('long studies page through their animals', async () => {
  const many = Array.from({ length: WILDLIFE_PAGE_SIZE + 5 }, (_, i) =>
    animal(
      GULLS,
      `G${i}`,
      'Larus argentatus',
      (i + 1) * HOUR,
      4,
      51 + i / 100,
      1,
    ),
  );
  const h = harness({ animals: many });
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ study: GULLS });
  let controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.chips.map(({ id, disabled }) => [id, disabled]).slice(3),
    [
      ['previous', true],
      ['next', false],
      ['doi', undefined],
      ['studies', undefined],
    ],
  );
  assert.match(controls.info, /select a row · Page 1 of 2/);
  assert.equal(controls.list.items.length, WILDLIFE_PAGE_SIZE);
  h.layer.setParams({ page: 'next' });
  controls = h.layer.getRowControls();
  assert.equal(controls.list.items[0].ordinal, WILDLIFE_PAGE_SIZE + 1);
  assert.equal(controls.list.items.length, 5);
  h.layer.setParams({ page: 'next' });
  assert.match(h.layer.getRowControls().info, /Page 2 of 2/);
  h.layer.setParams({ animal: `${GULLS}:G0` });
  assert.match(
    h.layer.getRowControls().list.ariaLabel,
    /page 1 of 2/,
    'choosing an animal shows its page',
  );
});

test('studies still on their way are named and polled for', async () => {
  const h = harness({
    animals: [],
    statuses: { [GULLS]: 'pending', [STORKS]: 'pending' },
  });
  h.layer.enable();
  await h.layer.update();
  const controls = h.layer.getRowControls();
  assert.match(controls.info, /^Fetching 2 studies from Movebank…/);
  assert.equal(
    controls.list.items.find(({ id }) => id === String(GULLS)).text,
    'Gulls · Neeltje Jans · loading',
  );
  assert.equal(
    controls.list.items.find(({ id }) => id === String(GULLS)).lead,
    '—',
  );
  assert.equal(h.layer.getStats().partial, true);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 20_000);
  h.setSnapshot({ studies: studies(), animals: ANIMALS });
  const [[, { callback }]] = [...h.timers];
  h.timers.clear();
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.layer.getStats().count, 3);
  assert.equal(h.timers.size, 0, 'no poll once every study is in');
  h.layer.setParams({ study: GULLS });
  h.setSnapshot({ studies: studies({ [GULLS]: 'pending' }), animals: [] });
  await h.layer.update();
  assert.match(
    h.layer.getRowControls().info,
    /^Gulls · Neeltje Jans · fetching from Movebank…/,
  );
  h.layer.disable();
  assert.equal(h.timers.size, 0, 'disabling cancels the poll');
});

test('stale and withdrawn studies are named honestly, never as current', async () => {
  const h = harness();
  h.setSnapshot({
    studies: studies({ [GULLS]: 'stale', [SPOONBILLS]: 'withdrawn' }).map(
      (study) =>
        study.id === GULLS
          ? { ...study, fetchedAt: NOW - 3 * HOUR }
          : study.id === SPOONBILLS
            ? { ...study, fetchedAt: null }
            : study,
    ),
    animals: ANIMALS.filter(({ study }) => study !== SPOONBILLS),
  });
  h.layer.enable();
  await h.layer.update();
  const controls = h.layer.getRowControls();
  assert.match(controls.info, /1 study not refreshed since 3 h ago/);
  const row = (id) =>
    controls.list.items.find((item) => item.id === String(id));
  assert.match(row(GULLS).text, /last fix 2 h ago · not refreshed$/);
  assert.match(row(STORKS).text, /last fix 3 h ago$/);
  assert.match(row(SPOONBILLS).text, /no longer public$/);
  assert.equal(h.layer.getStats().partial, true);
  h.layer.setParams({ study: GULLS });
  assert.match(h.layer.getRowControls().info, /Not refreshed since 3 h ago/);
  h.layer.setParams({ clear: true });
  h.layer.setParams({ study: SPOONBILLS });
  assert.match(
    h.layer.getRowControls().info,
    /no longer public on Movebank; its tracks were removed/,
  );
  const fresh = harness();
  fresh.layer.enable();
  await fresh.layer.update();
  assert.equal(fresh.layer.getStats().partial, false);
  assert.doesNotMatch(fresh.layer.getRowControls().info, /not refreshed/);
});

test('a failed refresh keeps the animals and says so', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  h.fail(true);
  assert.equal(await h.layer.update(), false);
  assert.equal(h.layer.getStats().count, 3);
  assert.match(
    h.layer.getRowControls().info,
    /Refresh failed: Tracking proxy error \(HTTP 502\)/,
  );
  assert.equal(h.layer.getStats().error, 'Wildlife HTTP 502');
  const cold = harness();
  cold.fail(true);
  cold.layer.enable();
  await cold.layer.update();
  assert.match(
    cold.layer.getRowControls().info,
    /^Tracking proxy error \(HTTP 502\)/,
  );
});

test('globe clicks choose animals and leave other layers alone', async () => {
  const picking = fakePicking();
  picking.registerPickOwner('flights', (id) => id === 'flight:1');
  const h = harness({ picking });
  h.layer.enable();
  await h.layer.update();
  assert.ok(picking.owners.has('wildlife'));
  h.click({ id: { id: `wildlife:${GULLS}:L77:track:1` } });
  assert.equal(h.layer.getDiagnostics().selectedAnimal, `${GULLS}:L77`);
  assert.equal(h.flights.length, 0, 'a globe click does not move the camera');
  h.click({ id: { id: 'flight:1' } });
  assert.equal(h.layer.getDiagnostics().selectedAnimal, `${GULLS}:L77`);
  h.click(undefined);
  assert.equal(h.layer.getDiagnostics().selectedAnimal, null);
  assert.equal(h.layer.getDiagnostics().selectedStudy, GULLS);
});

test('disable and destroy release everything', async () => {
  const picking = fakePicking();
  const h = harness({ picking });
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ animal: `${GULLS}:H903` });
  h.layer.disable();
  assert.equal(h.sources[0].show, false);
  assert.equal(picking.owners.has('wildlife'), false);
  assert.equal(h.handlers[0].destroyed, true);
  assert.equal(h.hasPreRender(), false);
  const diagnostics = h.layer.getDiagnostics();
  assert.equal(diagnostics.selectedAnimal, null);
  assert.equal(diagnostics.selectedStudy, null);
  h.layer.setParams({ study: GULLS });
  assert.equal(
    h.layer.getDiagnostics().selectedStudy,
    null,
    'ignored while off',
  );
  h.layer.destroy();
  assert.equal(h.sources.length, 0);
});

test('paths skip gaps and failures read as short reasons', () => {
  const HOUR = 3_600_000;
  assert.deepEqual(
    wildlifeTrackChunks([
      [-8, 40, 0],
      [4, 51, HOUR],
    ]),
    [],
    'one fix after a jump draws no path',
  );
  assert.equal(
    wildlifeTrackChunks([
      [-8, 40, 0],
      [4, 51, HOUR],
      [4.1, 51, 2 * HOUR],
    ]).length,
    1,
  );
  assert.equal(
    wildlifeErrorReason('Wildlife HTTP 503'),
    'Tracking proxy error (HTTP 503)',
  );
  assert.equal(
    wildlifeErrorReason('Malformed wildlife snapshot'),
    'Unexpected data from the proxy',
  );
  assert.equal(
    wildlifeErrorReason('Failed to fetch'),
    'Network error, retrying',
  );
  for (const message of ['Wildlife HTTP 503', 'x', 'Malformed'])
    assert.ok(wildlifeErrorReason(message).length <= 45);
});
