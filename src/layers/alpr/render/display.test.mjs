// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { setLocale } from '../../../i18n/index.js';
import { shownEntityLabel } from '../../../voice/speech.js';
import { distanceScale } from '../../../globe/cpuPicks.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { MARKER_SCALE_BY_DISTANCE } from '../policy.js';
import { directionWedgePositions } from '../visuals.js';
import { createAlprDisplay } from './display.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const heightOf = (position) => geo.cartographic.fromCartesian(position).height;
const SOURCE = {
  label: 'Fixture',
  attribution: {
    name: 'Fixture cameras',
    text: 'Fixture cameras',
    href: 'https://example.com/cameras',
  },
};

function fakeHarness() {
  const engine = createFakeEngine();
  let picked;
  engine.fake.script('pick', () => picked);
  return {
    name: 'the fake engine',
    engine,
    frame: () => engine.fake.frame(),
    click(target) {
      picked = target;
      engine.fake.input('click', { position: { x: -50, y: -50 } });
    },
    credits: () => engine.fake.credits,
    surface(height) {
      engine.fake.script('sampleHeight', height);
    },
    terrain(height) {
      engine.fake.script('terrainHeight', height);
    },
    /** A badge as drawn: set id → instance → { shown, sizePx, alpha, scale, position }. */
    badge(id, index) {
      const { store, options } = engine.fake.moverSet(id);
      const at = index * 3;
      return {
        shown: index < store.count && store.shows[index] === 1,
        sizePx: options.sprite.sizePx,
        alpha: store.colors[index * 4 + 3],
        scale: store.scales[index],
        id: store.pickIds[index],
        position: {
          x: store.positions[at],
          y: store.positions[at + 1],
          z: store.positions[at + 2],
        },
      };
    },
  };
}

const HARNESSES = [fakeHarness];

function services() {
  const contexts = new Map();
  let selected = null;
  return {
    contexts,
    get selected() {
      return selected;
    },
    otherSelection() {
      selected = { id: 'flight:1', layerId: 'flights' };
    },
    render: { governorRequestRender() {} },
    groundFloor: { cachedGroundFloor: () => 150 },
    context: {
      getSelectedEntityContext: () => selected,
      clearSelectedEntityContextForLayer(layerId) {
        if (selected?.layerId === layerId) selected = null;
      },
      removeEntityContextsForLayer(_id, { retainIds = new Set() } = {}) {
        for (const id of contexts.keys())
          if (!retainIds.has(id)) contexts.delete(id);
      },
      registerEntityContext(entity, metadata) {
        contexts.set(metadata.id, { ...metadata, entity });
      },
      selectEntityContext(entity) {
        selected = [...contexts.values()].find((c) => c.entity === entity);
      },
    },
  };
}

const records = (count, extra = {}) =>
  Array.from({ length: count }, (_, i) => ({
    id: `alpr:${i}`,
    latitude: 30 + i * 0.00001,
    longitude: -97,
    osmId: i,
    ...extra,
  }));

function setup(
  makeHarness,
  { source = SOURCE, cameraHeight = 2000, overlays } = {},
) {
  const h = makeHarness();
  h.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-97, 30, cameraHeight),
  });
  const s = services();
  if (overlays) s.overlays = overlays;
  const state = {
    enabled: true,
    selectedId: null,
    lastAnchorSampleAt: 0,
    renderRevision: 0,
    records: [],
    recordById: new Map(),
  };
  const display = createAlprDisplay(h.engine, { state, services: s, source });
  display.init({ onMove() {} });
  display.setVisible(true);
  const load = (list) => {
    state.records = list;
    state.recordById = new Map(list.map((r) => [r.id, r]));
    display.renderRecords();
    h.frame();
  };
  const marker = (id) => display.markers().find((m) => m.id === id);
  return {
    ...h,
    display,
    state,
    services: s,
    load,
    marker,
    /** A click on a camera's badge. */
    clickCamera(id) {
      h.click({
        id,
        owner: 'alpr-cameras',
        instance: marker(id).index,
      });
    },
    destroy() {
      state.enabled = false;
      display.setVisible(false);
      display.destroy();
      h.engine.destroy();
    },
  };
}

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`badges draw on their floor, on top, shrinking with distance (${name})`, async () => {
    const h = setup(makeHarness);
    try {
      h.load(records(2));
      await settle();
      const badge = h.badge('alpr-cameras', 0);
      assert.equal(badge.shown, true);
      assert.equal(badge.sizePx, 38);
      assert.equal(badge.id, 'alpr:0', 'a pick returns the camera id');
      assert.equal(badge.alpha, 1);
      assert.ok(Math.abs(heightOf(badge.position) - 151.5) < 0.01);
      {
        for (const [id, size, url] of [
          ['alpr-cameras', 38, /alpr-marker-normal\.png$/],
          ['alpr-selected', 60, /alpr-marker-selected\.png$/],
        ]) {
          const { options } = h.engine.fake.moverSet(id);
          assert.equal(options.kind, 'sprite');
          assert.equal(options.sprite.sizePx, size);
          assert.match(options.sprite.atlas.url, url);
          assert.equal(options.depthTest, 'always');
          assert.equal(options.pickable, true);
          assert.deepEqual(
            options.sprite.scaleByDistance,
            MARKER_SCALE_BY_DISTANCE,
          );
          assert.ok(options.order < 0, 'under the moving contacts');
        }
        assert.ok(
          h.engine.fake.moverSet('alpr-selected').options.order >
            h.engine.fake.moverSet('alpr-cameras').options.order,
        );
      }
    } finally {
      h.destroy();
    }
  });

  test(`a click selects a camera under its 60 px badge and another clears it (${name})`, async () => {
    const h = setup(makeHarness);
    try {
      h.load(records(2));
      await settle();
      h.clickCamera('alpr:0');
      h.frame();
      await settle();
      assert.equal(h.services.selected.id, 'alpr:0');
      assert.equal(h.badge('alpr-cameras', 0).shown, false);
      const chosen = h.badge('alpr-selected', 0);
      assert.equal(chosen.shown, true);
      assert.equal(chosen.sizePx, 60);
      assert.equal(chosen.id, 'alpr:0');
      assert.equal(
        h.marker('alpr:0').gevLabelModel.accent,
        '#ff6474',
        'the selected accent',
      );
      h.clickCamera('alpr:1');
      h.frame();
      assert.equal(h.services.selected.id, 'alpr:1');
      assert.equal(h.badge('alpr-cameras', 0).shown, true);
      assert.equal(h.marker('alpr:0').gevLabelModel.accent, '#52d4ff');
      h.click({ id: 'alpr:1', owner: 'alpr-selected', instance: 0 });
      h.frame();
      assert.equal(
        h.services.selected,
        null,
        'a click on the selected camera clears it',
      );
      assert.equal(h.engine.movers.list()[1].count, 0);
      h.clickCamera('alpr:1');
      h.click(undefined);
      assert.equal(h.services.selected, null, 'so does the map');
      h.clickCamera('alpr:1');
      h.click({ id: 'flight:abc', owner: 'flights-sprites-0', instance: 0 });
      assert.equal(h.services.selected, null, "and another layer's object");
    } finally {
      h.destroy();
    }
  });

  test(`the selected readout anchors on the rendered ground, sampled once a second (${name})`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const h = setup(makeHarness);
    try {
      h.surface(187);
      h.load(records(1));
      await settle();
      h.clickCamera('alpr:0');
      const anchor = h.marker('alpr:0').gevDisplayPosition();
      assert.ok(Math.abs(heightOf(anchor) - 187) < 0.001);
      h.surface(190);
      for (let i = 0; i < 30; i++) h.frame();
      assert.ok(
        Math.abs(heightOf(h.marker('alpr:0').gevDisplayPosition()) - 187) <
          0.001,
        'no per-frame raycasts',
      );
      t.mock.timers.tick(1000);
      h.frame();
      assert.ok(
        Math.abs(heightOf(h.marker('alpr:0').gevDisplayPosition()) - 190) <
          0.001,
      );
    } finally {
      h.destroy();
    }
  });

  test(`markers wait on the terrain for their floor and hide with no ground known (${name})`, async () => {
    const h = setup(makeHarness);
    try {
      h.services.groundFloor.cachedGroundFloor = () => null;
      h.terrain(320);
      h.load(records(1));
      await settle();
      assert.equal(h.marker('alpr:0').clamped, true);
      assert.ok(
        Math.abs(heightOf(h.badge('alpr-cameras', 0).position) - 321.5) < 0.01,
      );
      h.terrain(410);
      await h.engine.maps.setTerrain({ kind: 'ellipsoid' });
      h.frame();
      assert.ok(
        Math.abs(heightOf(h.badge('alpr-cameras', 0).position) - 411.5) < 0.01,
      );
      h.terrain(undefined);
      h.load(records(1).map((r) => ({ ...r, latitude: 30.0001 })));
      await settle();
      assert.equal(h.badge('alpr-cameras', 0).shown, false);
    } finally {
      h.destroy();
    }
  });

  test(`a dense view respects the render cap, batches writes and flies to the nearest camera (${name})`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup(makeHarness);
    try {
      h.load(records(1600));
      assert.equal(h.display.count(), 1500);
      assert.equal(h.state.renderSaturated, true);
      assert.ok(
        h.engine.fake.moverSet('alpr-cameras').commits < 10,
        'one buffer commit per batch, not per marker',
      );
      const credit = h.credits().find((c) => /Fixture cameras/.test(c.html));
      assert.ok(credit, 'the source credit shows with the cameras');
      assert.equal(credit.onScreen, true);
      t.mock.timers.tick(5000);
      assert.equal(
        h.credits().some((c) => /Fixture cameras/.test(c.html)),
        false,
        'for five seconds',
      );
      const follow = h.engine.camera.follow({
        position: () => geo.cartesian3.fromDegrees(-97, 30, 3000),
        viewFrom: { x: 0, y: -500, z: 300 },
      });
      assert.equal(h.display.following(), true);
      assert.equal(h.display.focusNearest(), false);
      follow.stop();
      assert.equal(h.display.focusNearest(), true);
      assert.equal(h.services.selected.id, 'alpr:0');
      {
        const [{ args }] = h.engine.fake.callsOf('camera.flyToSphere');
        assert.equal(args[0].radius, 30);
        assert.ok(Math.abs(heightOf(args[0].center) - 0) < 0.01, 'no ground');
        assert.equal(args[1].range, 800);
        assert.equal(args[1].pitch, -Math.PI / 4);
        assert.equal(args[1].duration, 1.2);
      }
    } finally {
      h.destroy();
    }
  });

  test(`ten toggles clear contexts, clicks and credits without new sets (${name})`, () => {
    const h = setup(makeHarness);
    try {
      const sets = h.engine.movers.list().map(({ id }) => id);
      for (let i = 0; i < 10; i++) {
        h.state.enabled = true;
        h.display.setVisible(true);
        h.load(records(3));
        h.state.enabled = false;
        h.display.setVisible(false);
        h.display.clearSelection();
        h.display.clearRendered();
        assert.equal(h.services.contexts.size, 0);
        assert.equal(
          h.credits().filter((c) => /Fixture/.test(c.html)).length,
          0,
        );
        assert.ok(h.engine.movers.list().every((set) => set.count === 0));
      }
      assert.deepEqual(
        h.engine.movers.list().map(({ id }) => id),
        sets,
      );
    } finally {
      h.destroy();
    }
    assert.deepEqual(h.engine.movers.list(), []);
  });
}

test('a badge beyond the horizon is hidden', () => {
  const h = setup(fakeHarness, { cameraHeight: 300 });
  try {
    // A low oblique view: the ground at the view centre is 55 km away.
    h.engine.fake.script(
      'pickEllipsoid',
      geo.cartesian3.fromDegrees(-97, 30.5),
    );
    h.load([
      { id: 'alpr:near', latitude: 30, longitude: -97 },
      { id: 'alpr:far', latitude: 31.2, longitude: -97 },
    ]);
    assert.equal(
      h.badge('alpr-cameras', h.marker('alpr:near').index).shown,
      true,
    );
    assert.equal(
      h.badge('alpr-cameras', h.marker('alpr:far').index).shown,
      false,
    );
  } finally {
    h.destroy();
  }
});

test('selected metadata survives a refresh; an evicted or replaced selection is released', () => {
  const h = setup(fakeHarness);
  try {
    h.load(records(2));
    h.clickCamera('alpr:0');
    assert.equal(h.services.selected.id, 'alpr:0');
    h.load(records(2).map((r) => ({ ...r, operator: 'Updated' })));
    assert.equal(h.state.selectedId, 'alpr:0');
    assert.ok(
      h.services.contexts
        .get('alpr:0')
        .entity.gevLabelModel.details.some((line) => line.includes('UPDATED')),
    );
    h.services.otherSelection();
    h.load(records(2));
    assert.equal(h.state.selectedId, null);
    assert.equal(h.services.selected.id, 'flight:1');
    h.clickCamera('alpr:1');
    h.load(records(1));
    assert.equal(h.state.selectedId, null);
    assert.equal(h.services.contexts.has('alpr:1'), false);
  } finally {
    h.destroy();
  }
});

test('the camera label stays English data in a translated interface', (t) => {
  const h = setup(fakeHarness);
  setLocale('ru');
  t.after(() => setLocale('en'));
  try {
    h.load(records(1));
    const { label } = h.services.contexts.get('alpr:0');
    assert.equal(label, 'ALPR camera');
    assert.equal(shownEntityLabel(label), 'Камера ALPR');
  } finally {
    h.destroy();
  }
});

test('an OpenStreetMap source keeps the shared OSM credit inline while cameras show', () => {
  const shown = [];
  const h = setup(fakeHarness, {
    source: { attribution: { name: 'OpenStreetMap' } },
  });
  h.services.credits = {
    showOsmCredit: (target, owner) => shown.push(['show', target, owner]),
    hideOsmCredit: (target, owner) => shown.push(['hide', target, owner]),
  };
  try {
    h.load(records(1));
    assert.deepEqual(shown.at(-1), ['show', h.engine, 'alpr-cameras']);
    h.load([]);
    assert.deepEqual(shown.at(-1), ['hide', h.engine, 'alpr-cameras']);
  } finally {
    h.destroy();
  }
});

test('retired floor requests cannot rewrite a newer marker or a destroyed set', async () => {
  const h = setup(fakeHarness);
  const pending = [];
  let cached;
  h.services.groundFloor.cachedGroundFloor = () => cached;
  h.services.groundFloor.resolveGroundFloorCells = (_points, { signal }) =>
    new Promise((resolve) => pending.push({ resolve, signal }));
  h.load(records(1));
  assert.equal(pending.length, 1);
  h.display.clearRendered();
  assert.equal(pending[0].signal.aborted, true);
  h.load([{ ...records(1)[0], latitude: 30.01 }]);
  assert.equal(pending.length, 2);
  const marker = h.services.contexts.get('alpr:0').entity;
  const position = marker.position;
  cached = 450;
  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    marker.position,
    position,
    'old completion cannot place the new marker',
  );
  h.display.destroy();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  h.frame();
  assert.equal(h.services.contexts.size, 0);
  assert.equal(h.engine.camera.moveEnd.numberOfListeners, 0);
  assert.equal(h.engine.frames.preRender.numberOfListeners, 0);
  assert.deepEqual(h.engine.movers.list(), []);
  h.engine.destroy();
});

// The canvas overlay over the badges (../overlay.js), on the fake engine.
function overlaySetup(t, count = 2) {
  const previousImage = globalThis.Image;
  globalThis.Image = class {
    complete = true;
    naturalWidth = 128;
  };
  t.after(() => {
    if (previousImage === undefined) delete globalThis.Image;
    else globalThis.Image = previousImage;
  });
  let paint, mapListener, active;
  let removed = 0;
  const h = setup(fakeHarness, {
    cameraHeight: 600,
    overlays: {
      registerPaintLane(_lane, painter) {
        paint = painter;
        return {
          requestPaint() {},
          setActive(value) {
            active = value;
          },
          unregister() {
            removed++;
          },
        };
      },
      keyholeAlpha: () => 1,
      subscribeMapStack(callback) {
        mapListener = callback;
        return () => {
          mapListener = null;
        };
      },
    },
  });
  t.after(() => h.destroy());
  const draw = [];
  const ctx = {
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {
      draw.push('wedge');
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    drawImage(image) {
      draw.push(image.src);
    },
  };
  const list = records(count, { directionDeg: 90 });
  const { width, height } = h.engine.host.size();
  return {
    ...h,
    list,
    load: () => h.load(list),
    draw,
    paint: (matrix = h.engine.projector.viewProjection()) =>
      paint({ ctx, width, height, viewProjectionMatrix: matrix }),
    /** Where a marker's canvas anchor lands on screen. */
    screen: (id) =>
      h.engine.projector.worldToWindow(h.marker(id).gevAlprCanvasPosition),
    mapChanged: () => mapListener({ detail: { status: 'ready' } }),
    get active() {
      return active;
    },
    get removed() {
      return removed;
    },
  };
}

test('the overlay paints the 64 nearest cameras, the selection last, and invents no bearing', (t) => {
  const h = overlaySetup(t, 70);
  h.list[69].directionDeg = null;
  h.load();
  h.clickCamera('alpr:69');
  h.paint();
  const owned = h.display.markers().filter((m) => m.canvasOwned);
  assert.equal(owned.length, 64);
  assert.equal(h.draw.filter((x) => x === 'wedge').length, 63);
  assert.ok(h.draw.at(-1).endsWith('alpr-marker-selected-brackets.png'));
  const firstGlyph = h.draw.findIndex((value) => value !== 'wedge');
  assert.equal(firstGlyph, 63, 'all wedges paint before any glyph');
  assert.equal(h.marker('alpr:69').gevAlprWedge, null);
  assert.equal(
    h.display.markers().filter((m) => !m.canvasOwned).length,
    6,
    'farther cameras keep their native badges',
  );
  h.engine.fake.script('pick', undefined);
  h.engine.fake.input('click', { position: h.screen('alpr:69') });
  assert.equal(
    h.services.selected,
    null,
    'the selected glyph paints and picks on top: a click on it clears it',
  );
});

test('a paint projects from the host frame and skips fully clipped artwork', (t) => {
  const h = overlaySetup(t, 1);
  h.load();
  const worldToWindow = h.engine.projector.worldToWindow;
  h.engine.projector.worldToWindow = () => {
    throw new Error('A paint must not reread camera and DOM size per vertex');
  };
  try {
    h.paint();
    assert.ok(h.draw.includes('wedge'));
    // Every point far left of the canvas: clip x shifted by -1000 w.
    const matrix = [...h.engine.projector.viewProjection()];
    for (const [x, w] of [
      [0, 3],
      [4, 7],
      [8, 11],
      [12, 15],
    ])
      matrix[x] -= 1000 * matrix[w];
    h.draw.length = 0;
    h.paint(matrix);
    assert.equal(
      h.draw.length,
      0,
      'fully clipped artwork allocates no gradient',
    );
    h.paint(h.engine.projector.viewProjection().map((value) => -value));
    assert.equal(h.draw.length, 0, 'points behind the camera never paint');
  } finally {
    h.engine.projector.worldToWindow = worldToWindow;
  }
});

test('a change made while the overlay paints wakes the next frame, which commits it once', async (t) => {
  const h = overlaySetup(t, 1);
  h.load();
  h.engine.fake.resetCalls();
  const commits = h.engine.fake.moverSet('alpr-cameras').commits;
  h.paint();
  assert.equal(h.marker('alpr:0').canvasOwned, true);
  await Promise.resolve();
  assert.ok(
    h.engine.fake.callsOf('render.request').length > 0,
    'the pending change wakes a new frame',
  );
  h.frame();
  assert.equal(h.engine.fake.moverSet('alpr-cameras').commits, commits + 1);
  h.engine.fake.resetCalls();
  h.paint();
  h.frame();
  await Promise.resolve();
  assert.equal(
    h.engine.fake.moverSet('alpr-cameras').commits,
    commits + 1,
    'settled sprites do not commit again',
  );
  assert.equal(
    h.engine.fake.callsOf('render.request').length,
    0,
    'settled sprites do not wake another frame',
  );
});

test('a selected camera without a bearing gets its badge and brackets, never a fabricated wedge', (t) => {
  const h = overlaySetup(t, 1);
  h.list[0].directionDeg = null;
  h.load();
  h.clickCamera('alpr:0');
  h.paint();
  h.frame();
  assert.equal(h.draw.length, 2);
  assert.ok(h.draw[0].endsWith('alpr-marker-selected.png'));
  assert.ok(h.draw[1].endsWith('alpr-marker-selected-brackets.png'));
  assert.equal(h.marker('alpr:0').gevAlprWedge, null);
  const badge = h.badge('alpr-selected', 0);
  assert.equal(badge.shown, true, 'a faint native pick target stays');
  assert.ok(Math.abs(badge.alpha - 0.01) < 1e-6);
  assert.equal(directionWedgePositions(h.list[0]), null);
});

test('an unknown surface leaves the badge native and paints nothing', (t) => {
  const h = overlaySetup(t, 1);
  h.services.groundFloor.cachedGroundFloor = () => null;
  h.engine.fake.script('terrainHeight', -15000);
  h.engine.fake.script('sampleHeight', undefined);
  h.load();
  h.paint();
  h.frame();
  assert.equal(h.draw.length, 0);
  assert.equal(h.marker('alpr:0').canvasOwned, false);
  const badge = h.badge('alpr-cameras', 0);
  assert.equal(badge.alpha, 1);
  assert.equal(badge.shown, false, 'it waits for a known ground');
});

test('a canvas-owned badge stays a faint pick target at full size', (t) => {
  const h = overlaySetup(t, 1);
  h.load();
  h.paint();
  h.frame();
  const marker = h.marker('alpr:0');
  assert.equal(marker.canvasOwned, true);
  const anchor = marker.gevAlprCanvasPosition;
  h.paint();
  assert.equal(marker.gevAlprCanvasPosition, anchor, 'stable across frames');
  const badge = h.badge('alpr-cameras', marker.index);
  assert.equal(badge.shown, true);
  assert.ok(Math.abs(badge.alpha - 0.01) < 1e-6, 'nearly transparent');
  const distance = geo.cartesian3.distance(
    h.engine.camera.livePosition,
    marker.gevAlprCanvasPosition,
  );
  assert.ok(
    Math.abs(
      badge.scale * distanceScale(MARKER_SCALE_BY_DISTANCE, distance) - 1,
    ) < 1e-5,
    'the set’s distance scale is undone',
  );
  h.mapChanged();
  h.frame();
  assert.equal(marker.gevAlprCanvasPosition, null);
  assert.equal(marker.canvasOwned, false);
  assert.equal(h.badge('alpr-cameras', marker.index).alpha, 1);
});

test('a still view refines two anchors per paint against the floor window, once each', (t) => {
  const h = overlaySetup(t, 2);
  let samples = 0;
  h.engine.fake.script('sampleHeight', (place) => {
    samples++;
    return geo.math.toDegrees(place.latitude) > 30.000005 ? 400 : 172;
  });
  h.load();
  h.paint();
  assert.equal(samples, 0, 'no samples while the camera may still be moving');
  const height = (id) => heightOf(h.marker(id).gevAlprCanvasPosition);
  assert.ok(Math.abs(height('alpr:0') - 151.5) < 0.01, 'floor anchor first');
  h.paint();
  assert.equal(samples, 2);
  assert.ok(Math.abs(height('alpr:0') - 173.5) < 0.01, 'rendered surface');
  assert.ok(
    Math.abs(height('alpr:1') - 151.5) < 0.01,
    'a rooftop-height sample is rejected',
  );
  h.paint();
  assert.equal(samples, 2, 'each anchor is checked once');
});

test('repeated paints of a still view write no badge', (t) => {
  const h = overlaySetup(t, 3);
  h.load();
  h.paint();
  h.frame();
  const commits = h.engine.fake.moverSet('alpr-cameras').commits;
  for (let i = 0; i < 5; i++) {
    h.paint();
    h.frame();
  }
  assert.equal(h.engine.fake.moverSet('alpr-cameras').commits, commits);
});

test('the horizon, a disable and disposal remove overlay hits, painting and ownership', (t) => {
  const h = overlaySetup(t, 1);
  h.load();
  h.paint();
  const at = h.screen('alpr:0');
  h.engine.fake.script('pick', undefined);
  h.engine.fake.input('click', { position: at });
  assert.equal(h.services.selected?.id, 'alpr:0', 'the painted glyph picks');
  h.display.clearSelection();
  const horizonVisible = h.engine.projector.horizonVisible;
  h.engine.projector.horizonVisible = () => false;
  h.paint();
  h.engine.fake.input('click', { position: at });
  assert.equal(h.services.selected, null, 'nothing past the horizon picks');
  h.engine.projector.horizonVisible = horizonVisible;
  h.paint();
  h.state.enabled = false;
  h.display.clearRendered();
  assert.equal(h.active, false);
  h.state.enabled = true;
  h.engine.fake.input('click', { position: at });
  assert.equal(h.services.selected, null, 'no hits once cleared');
  h.display.destroy();
  assert.equal(h.removed, 1);
});
