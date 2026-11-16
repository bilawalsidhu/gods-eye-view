import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { createWorldClock } from '../../time/worldClock.js';
import {
  ECLIPSE_PATHS_LAYER_ID,
  ECLIPSE_PATHS_OVERLAY_SOURCE_ID,
  ECLIPSE_PLAY_RATE,
  createEclipseElementsSource,
  createEclipsePathsLayer,
  skyShadeAt,
  fromGeodetic,
  centralPath,
} from './index.js';

const source = createEclipseElementsSource();
const catalog = await source.getCatalog();
const lunarCatalog = await source.getLunarCatalog();

/** A draw set that keeps what it was given. */
function fakeSet(spec, sets) {
  const items = new Map();
  const set = {
    id: spec.id,
    show: spec.show !== false,
    disposed: false,
    items,
    set(list) {
      items.clear();
      for (const item of list) items.set(item.id, item);
    },
    upsert(list) {
      for (const item of list) items.set(item.id, item);
    },
    remove(ids) {
      for (const id of ids) items.delete(id);
    },
    clear() {
      items.clear();
    },
    setOptions() {},
    size: () => items.size,
    on: () => () => {},
    dispose() {
      set.disposed = true;
    },
  };
  sets.set(spec.id, set);
  return set;
}

/** Degrees, to a tenth, of a position the layer handed the renderer. */
const degrees = (position) => {
  const { lat, lon } = 'lon' in position ? position : toLonLatH(position);
  return [Math.round(lat * 10) / 10, Math.round(lon * 10) / 10];
};

function harness({ at = Date.UTC(2026, 10, 11), ...layerOptions } = {}) {
  let wall = at;
  const clock = createWorldClock({
    now: () => wall,
    monotonicNow: () => 0,
    requestFrame: null,
    cancelFrame: null,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const sets = new Map();
  const overlays = { entries: [], visible: null };
  const shadow = {
    solar: null,
    lunar: null,
    shown: false,
    show: true,
    disposed: false,
  };
  const sky = { shown: null, destroyed: false };
  const flights = [];
  const views = [];
  const clicks = { action: null, free: true, at: null };
  const deferred = [];
  const preUpdate = new Set();
  const timers = new Set();
  let renders = 0;
  // The camera stands near Luxor, low.
  const eye = {
    lon: 32.6,
    lat: 25.7,
    height: 100,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  };
  const viewer = { container: null };
  bindRenderer(viewer, {
    draw: {
      shapes: (spec) => fakeSet(spec, sets),
      lines: (spec) => fakeSet(spec, sets),
      icons: (spec) => fakeSet(spec, sets),
      points: (spec) => fakeSet(spec, sets),
      field(spec) {
        assert.equal(spec.kind, 'eclipseShadow');
        const take = (patch) => {
          if ('solar' in patch) shadow.solar = patch.solar ?? null;
          if ('lunar' in patch) shadow.lunar = patch.lunar ?? null;
          shadow.shown = Boolean(shadow.solar || shadow.lunar);
        };
        take(spec);
        shadow.show = spec.show !== false;
        return {
          id: spec.id,
          get show() {
            return shadow.show;
          },
          set show(value) {
            shadow.show = value;
          },
          update: take,
          on: () => () => {},
          dispose() {
            shadow.disposed = true;
          },
        };
      },
    },
    camera: {
      pose: () => ({ ...eye }),
      setView: (view) => views.push(view),
      // A flight lands at once.
      flyTo: (destination, options) => {
        flights.push({ destination, ...options });
        options?.onComplete?.();
        return { cancel() {} };
      },
    },
    frame: {
      requestRender() {
        renders += 1;
      },
      on(phase, listener) {
        assert.equal(phase, 'preUpdate');
        preUpdate.add(listener);
        return () => preUpdate.delete(listener);
      },
    },
    // Where a click on the globe lands.
    query: { pickEllipsoid: () => clicks.at },
  });
  const layer = createEclipsePathsLayer({
    source,
    clock,
    overlayHost: {
      setEntries: (id, entries) => {
        assert.equal(id, ECLIPSE_PATHS_OVERLAY_SOURCE_ID);
        overlays.entries = entries;
      },
      setVisible: (_id, visible) => {
        overlays.visible = visible;
      },
      clearSource: () => {
        overlays.entries = [];
      },
    },
    createSky: (_viewer, options) => ({
      close: (sky.close = options?.onClose),
      show(shown) {
        sky.shown = shown;
      },
      hide() {
        sky.shown = null;
      },
      isShown: () => sky.shown !== null,
      destroy() {
        sky.destroyed = true;
      },
    }),
    setInterval: (callback) => {
      timers.add(callback);
      return callback;
    },
    clearInterval: (callback) => timers.delete(callback),
    reducedMotion: () => true,
    inputFor: () => ({
      onClick(action) {
        clicks.action = action;
        return () => {
          clicks.action = null;
        };
      },
    }),
    pointer: { isPointerFree: () => clicks.free },
    ...layerOptions,
    defer: (work) => deferred.push(work),
  });
  layer.init(viewer);
  const drawn = () =>
    [...sets.values()].flatMap((set) => [...set.items.values()]);
  return {
    layer,
    clock,
    viewer,
    eye,
    sets,
    overlays,
    shadow,
    sky,
    flights,
    views,
    clicks,
    /** Click the globe at a place, as the viewer would. */
    click: (lat, lon, topHit = null) => {
      clicks.at = fromDegrees(lon, lat);
      clicks.action?.({ screenPosition: { x: 1, y: 1 }, topHit });
    },
    // Run what the layer put off, as the page would a moment later.
    settle: () => {
      for (const work of deferred.splice(0)) work();
    },
    timers,
    renders: () => renders,
    frame: () => {
      for (const listener of preUpdate) listener();
    },
    setWall: (ms) => {
      wall = ms;
    },
    drawn,
    entityIds: () => drawn().map((item) => item.id),
    item: (id) => drawn().find((entry) => entry.id === id) ?? null,
  };
}

/** A layer turned on and loaded; by default listing the Sun's eclipses only. */
async function enabled({ bodies = 'solar', ...options } = {}) {
  const h = harness(options);
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  h.layer.setParams({ bodies });
  return h;
}

test('enabled, the layer chooses the next eclipse to come and draws its path', async () => {
  const h = await enabled();
  assert.equal(h.layer.getParams().eclipse, '2027-02-06');
  assert.equal(h.layer.getStats().count, catalog.length + lunarCatalog.length);
  const ids = h.entityIds();
  for (const id of [
    'eclipse-path:band',
    'eclipse-path:edge',
    'eclipse-path:center',
    'eclipse-path:greatest',
  ])
    assert.ok(ids.includes(id), `${id} is drawn`);
  // A time label each half hour of the path, and one at the peak.
  const labels = h.overlays.entries;
  assert.ok(labels.length >= 6);
  assert.ok(labels.every((entry) => entry.variant === 'label'));
  assert.equal(h.overlays.visible, true);
  // No shadow on the Earth today.
  assert.equal(h.shadow.shown, false);
  assert.equal(h.layer.getDiagnostics().inProgress, null);
});

test('the layer follows the world clock and covers the chosen eclipse on the timeline', async () => {
  const h = await enabled();
  assert.equal(h.clock.follows(ECLIPSE_PATHS_LAYER_ID), true);
  h.layer.setParams({ eclipse: '2027-08-02' });
  const coverage = h.clock.coverage();
  assert.equal(
    new Date(coverage.start).toISOString().slice(0, 16),
    '2027-08-02T07:30',
  );
  assert.equal(
    new Date(coverage.end).toISOString().slice(0, 16),
    '2027-08-02T12:42',
  );
  assert.deepEqual(coverage.marks, [
    catalog.find(({ id }) => id === '2027-08-02').greatestMs,
  ]);
  h.layer.disable();
  assert.equal(h.clock.follows(ECLIPSE_PATHS_LAYER_ID), false);
  assert.equal(h.clock.coverage(), null);
});

test('the shadow shows while the world time is inside an eclipse, and that eclipse becomes the chosen one', async () => {
  const h = await enabled();
  h.clock.seek(Date.UTC(2027, 7, 2, 10, 6));
  h.frame();
  assert.equal(h.shadow.shown, true);
  assert.equal(h.layer.getParams().eclipse, '2027-08-02');
  assert.equal(h.layer.getDiagnostics().inProgress, '2027-08-02');
  // The umbra reaches the ground: a negative radius on the plane.
  assert.ok(h.shadow.solar.cones[1] < 0);
  // The camera stands near Luxor, in totality: the sky is dark.
  assert.ok(h.shadow.solar.skyShade > 0.9);
  assert.equal(h.shadow.lunar, null);
  // Live keeps pace by a timer only while the shadow is on the Earth.
  assert.equal(h.timers.size, 1);
  h.clock.seek(Date.UTC(2027, 7, 3));
  h.frame();
  assert.equal(h.shadow.shown, false);
  assert.equal(h.timers.size, 0);
});

test('stepping moves along the catalogue and flies to the eclipse when asked', async () => {
  const h = await enabled();
  h.layer.setParams({ step: 1, focus: true });
  assert.equal(h.layer.getParams().eclipse, '2027-08-02');
  assert.equal(h.flights.length, 1);
  const where = h.flights[0].destination;
  assert.ok(Math.abs(where.lat - 25.5) < 0.1);
  assert.ok(Math.abs(where.lon - 33.2) < 0.1);
  assert.equal(h.flights[0].durationS, 0);
  h.layer.setParams({ step: -1 });
  assert.equal(h.layer.getParams().eclipse, '2027-02-06');
  // A year chooses its first eclipse; past the catalogue, the last one.
  h.layer.setParams({ year: 1919 });
  assert.equal(h.layer.getParams().eclipse, '1919-05-29');
  h.layer.setParams({ year: 1583 });
  assert.equal(h.layer.getParams().eclipse, catalog[0].id);
  h.layer.setParams({ year: 4000 });
  assert.equal(h.layer.getParams().eclipse, catalog.at(-1).id);
  // The slider shows one century, so a year is easy to land on.
  h.layer.setParams({ year: 2027 });
  const slider = h.layer.getRowControls().slider;
  assert.deepEqual([slider.min, slider.max, slider.value], [2000, 2099, 2027]);
  assert.equal(slider.label, 'Year · 2000–2099');
  assert.deepEqual(slider.params(2024), { year: 2024 });
  // The chips beside it step a century at a time, within the catalogue.
  const chip = (id) =>
    h.layer.getRowControls().chips.find((entry) => entry.id === id);
  assert.deepEqual(chip('century-forward').params, { year: 2127 });
  h.layer.setParams(chip('century-back').params);
  assert.equal(h.layer.getParams().eclipse.slice(0, 4), '1927');
  h.layer.setParams({ year: 1583 });
  assert.equal(chip('century-back').disabled, true);
  assert.deepEqual(
    [h.layer.getRowControls().slider.min, h.layer.getRowControls().slider.max],
    [1583, 1599],
  );
  h.layer.setParams({ year: 3000 });
  assert.equal(chip('century-forward').disabled, true);
  assert.equal(h.layer.setParams({ eclipse: '1999-01-01' }), false);
});

test('play runs the clock through the eclipse from its start and stops at its end', async () => {
  const h = await enabled();
  h.layer.setParams({ eclipse: '2027-08-02' });
  h.layer.setParams({ play: true });
  const state = h.clock.getState();
  assert.equal(state.playing, true);
  assert.equal(state.rate, ECLIPSE_PLAY_RATE);
  assert.equal(
    new Date(state.timeMs).toISOString().slice(0, 16),
    '2027-08-02T07:30',
  );
  assert.equal(h.layer.getDiagnostics().playing, true);
  assert.equal(
    h.layer.getRowControls().chips.find(({ id }) => id === 'play').active,
    true,
  );
  // Past the end: the layer holds the clock on the eclipse's last moment.
  h.clock.seek(Date.UTC(2027, 7, 2, 13));
  h.frame();
  const after = h.clock.getState();
  assert.equal(after.playing, false);
  assert.equal(
    new Date(after.timeMs).toISOString().slice(0, 16),
    '2027-08-02T12:42',
  );
  assert.equal(h.layer.getDiagnostics().playing, false);
});

test('the row lists the eclipses around the chosen one and names its facts', async () => {
  const h = await enabled();
  h.layer.setParams({ eclipse: '2027-08-02' });
  const controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.chips.map(({ id }) => id),
    // Facing the Sun is turned off, so a solar eclipse has no such chip.
    [
      'previous',
      'next',
      'century-back',
      'century-forward',
      'play',
      'sky',
      'follow',
    ],
  );
  const items = controls.list.items;
  assert.equal(items.length, 8);
  assert.deepEqual(
    items.filter(({ active }) => active).map(({ id }) => id),
    ['2027-08-02'],
  );
  assert.deepEqual(items.find(({ id }) => id === '2028-07-22').params, {
    eclipse: '2028-07-22',
    focus: true,
  });
  assert.equal(controls.legend.length, 7);
  assert.match(controls.info, /Total solar eclipse/);
  assert.match(controls.info, /6 min 23 s/);
  assert.match(controls.info, /258 km/);
});

test('the sky view looks up from its flag: where the eclipse peaks, until a click moves it', async () => {
  const h = await enabled();
  h.layer.setParams({ eclipse: '2027-08-02' });
  const eclipse = catalog.find(({ id }) => id === '2027-08-02');
  const flag = () => {
    const item = h.item('eclipse-sky:flag');
    return item ? degrees(item.pos) : null;
  };
  // The flag stands where the eclipse peaks even before it begins.
  assert.deepEqual(flag(), [25.5, 33.2]);
  h.frame();
  assert.equal(h.sky.shown, null, 'no eclipse today, no sky view');
  h.clock.seek(eclipse.greatestMs);
  h.frame();
  assert.equal(h.sky.shown.view.phase, 'total');
  assert.equal(h.sky.shown.view.night, false);
  assert.deepEqual(h.sky.shown.lines, ['Seen from 25.5°, 33.2°', 'Totality']);
  // A click on the globe moves the flag: Rome sees a partial eclipse.
  h.click(41.9, 12.5);
  assert.deepEqual(flag(), [41.9, 12.5]);
  assert.equal(h.sky.shown.view.phase, 'partial');
  assert.equal(h.sky.shown.lines[0], 'Seen from 41.9°, 12.5°');
  assert.match(h.sky.shown.lines[1], /^\d+% of the Sun covered$/);
  // A click on another layer's item is that layer's.
  h.click(0, 0, { set: 'ships', id: 'ship:1', surface: false });
  assert.deepEqual(flag(), [41.9, 12.5]);
  // While another tool holds the pointer, a click is not the layer's.
  h.clicks.free = false;
  h.click(0, 0);
  assert.deepEqual(flag(), [41.9, 12.5]);
  h.clicks.free = true;
  // Turned off in the row, the view and its flag go; turned on, they return.
  h.layer.setParams({ sky: false });
  h.frame();
  assert.equal(h.sky.shown, null);
  assert.equal(flag(), null);
  assert.equal(h.layer.getParams().sky, false);
  h.click(10, 10);
  assert.equal(flag(), null);
  h.layer.setParams({ sky: true });
  h.frame();
  assert.deepEqual(flag(), [41.9, 12.5]);
  // Another eclipse: the flag goes to where that one peaks.
  h.layer.setParams({ eclipse: '2028-07-22' });
  assert.deepEqual(flag(), [-15.6, 126.7]);
  h.layer.disable();
  assert.equal(h.sky.shown, null);
});

test('the sky view closes from its own cross, as from its chip, and the chips come in grouped lines', async () => {
  const h = await enabled();
  h.layer.setParams({ eclipse: '2027-08-02' });
  const chips = () => h.layer.getRowControls().chips;
  assert.deepEqual(
    chips().map(({ id, breakBefore }) => (breakBefore ? `/${id}` : id)),
    [
      'previous',
      'next',
      '/century-back',
      'century-forward',
      '/play',
      'sky',
      '/follow',
    ],
  );
  assert.equal(chips().find(({ id }) => id === 'sky').active, true);
  h.sky.close();
  assert.equal(h.layer.getParams().sky, false);
  assert.equal(chips().find(({ id }) => id === 'sky').active, false);
  assert.ok(!h.entityIds().includes('eclipse-sky:flag'));
});

test('the limit of the partial eclipse is drawn a beat after the path, for the eclipse still chosen', async () => {
  const h = await enabled();
  h.layer.setParams({ eclipse: '2027-08-02' });
  const limits = () =>
    h.entityIds().filter((id) => id.startsWith('eclipse-path:limit:'));
  assert.equal(limits().length, 0);
  // Another eclipse is chosen before the first one's limit is worked out.
  h.layer.setParams({ eclipse: '2028-07-22' });
  h.settle();
  assert.ok(limits().length >= 1);
  const count = limits().length;
  // Settling again adds nothing twice.
  h.settle();
  assert.equal(limits().length, count);
});

test('returning to an eclipse before its deferred limit runs draws it only once', async () => {
  const h = await enabled();
  h.layer.setParams({ eclipse: '2027-08-02' });
  h.layer.setParams({ eclipse: '2028-07-22' });
  h.layer.setParams({ eclipse: '2027-08-02' });
  // The first request for 2027-08-02 is stale, though that eclipse is chosen
  // again.
  assert.doesNotThrow(() => h.settle());
  const limits = h
    .entityIds()
    .filter((id) => id.startsWith('eclipse-path:limit:'));
  assert.ok(limits.length > 0);
  assert.equal(new Set(limits).size, limits.length);
});

test('following keeps the camera over the shadow while the eclipse plays', async () => {
  const h = await enabled();
  h.layer.setParams({ eclipse: '2027-08-02' });
  Object.assign(h.eye, { lon: 0, lat: 0, height: 9e6 });
  // Following is on from the start.
  assert.equal(h.layer.getParams().follow, true);
  const flightsBefore = h.flights.length;
  h.layer.setParams({ play: true });
  // The camera is not flown to the peak: it goes with the shadow instead.
  assert.equal(h.flights.length, flightsBefore);
  h.clock.pause();
  h.clock.seek(Date.UTC(2027, 7, 2, 10, 6, 34));
  h.clock.play({ rate: 480, continuous: true });
  h.frame();
  const where = h.views.at(-1).destination;
  assert.ok(Math.abs(where.lat - 25.5) < 0.1);
  assert.ok(Math.abs(where.lon - 33.2) < 0.1);
  assert.equal(where.height, 9e6);
  assert.deepEqual(h.views.at(-1).orientation, {
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  // Paused, the camera is the viewer's again.
  h.clock.pause();
  const views = h.views.length;
  h.frame();
  assert.equal(h.views.length, views);
  // The camera rides the central line and no farther. Before the umbra
  // lands, it waits at the line's start.
  const eclipse = catalog.find(({ id }) => id === '2027-08-02');
  const path = centralPath(eclipse);
  const at = () => {
    const spot = h.views.at(-1).destination;
    return [spot.lat, spot.lon];
  };
  const near = ([lat, lon], point) =>
    Math.abs(lat - point.lat) < 0.01 && Math.abs(lon - point.lon) < 0.01;
  h.clock.seek(path.startMs - 20 * 60_000);
  h.clock.play({ rate: 480, continuous: true });
  h.frame();
  assert.ok(near(at(), path.center[0]));
  // After it leaves, the camera stops at the line's end and stays there,
  // though the penumbra is still on the Earth.
  h.clock.seek(path.endMs + 60_000);
  h.frame();
  assert.ok(near(at(), path.center.at(-1)));
  assert.equal(h.layer.getDiagnostics().shadowShown, true);
  const stopped = h.views.length;
  h.clock.seek(path.endMs + 10 * 60_000);
  h.frame();
  assert.equal(h.views.length, stopped);
});

test('a partial eclipse draws its peak and no path', async () => {
  const h = await enabled();
  h.layer.setParams({ eclipse: '2029-01-14' });
  assert.deepEqual(h.entityIds(), [
    'eclipse-path:greatest',
    'eclipse-sky:flag',
  ]);
  // Its limit still shows where it can be seen.
  h.settle();
  assert.ok(h.entityIds().some((id) => id.startsWith('eclipse-path:limit:')));
  assert.equal(h.overlays.entries.length, 1);
});

test('disabled, the layer hides the shadow, clears its labels and lets the clock go', async () => {
  const h = await enabled();
  h.clock.seek(Date.UTC(2027, 7, 2, 10, 6));
  h.frame();
  h.layer.disable();
  assert.equal(h.shadow.shown, false);
  assert.deepEqual(h.overlays.entries, []);
  assert.equal(h.overlays.visible, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  // Hidden, not torn down: the sets and the shadow stay until destroy.
  assert.ok([...h.sets.values()].every((set) => set.show === false));
  assert.equal(h.shadow.show, false);
  h.layer.destroy();
  assert.equal(h.shadow.disposed, true);
  assert.equal(h.sky.destroyed, true);
  assert.ok([...h.sets.values()].every((set) => set.disposed));
});

test('the sky darkens only where the Sun is up and the Moon covers it', () => {
  const eclipse = catalog.find(({ id }) => id === '2027-08-02');
  const at = eclipse.greatestMs;
  assert.ok(skyShadeAt(eclipse, at, fromGeodetic(25.69, 32.64)) > 0.9);
  const rome = skyShadeAt(eclipse, at, fromGeodetic(41.9, 12.5));
  assert.ok(rome > 0 && rome < 0.5);
  assert.equal(skyShadeAt(eclipse, at, fromGeodetic(-23.5, -46.6)), 0);
  // Tokyo: the Sun has set.
  assert.equal(skyShadeAt(eclipse, at, fromGeodetic(35.7, 139.7)), 0);
});

test('a layer without a catalogue source or a clock is refused', () => {
  assert.throws(() => createEclipsePathsLayer({}), /catalogue source/);
  assert.throws(() => createEclipsePathsLayer({ source }), /world clock/);
});

test('with Sun and Moon both listed, the row walks solar and lunar eclipses in time order', async () => {
  const h = await enabled({ bodies: 'all' });
  assert.equal(h.layer.getParams().bodies, 'all');
  assert.equal(h.layer.getParams().eclipse, '2027-02-06');
  h.layer.setParams({ step: 1 });
  // A penumbral lunar eclipse two weeks after the annular solar one.
  assert.equal(h.layer.getParams().eclipse, '2027-02-20');
  const controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.segmented.options.map(({ id, active }) => [id, active]),
    [
      ['bodies-all', true],
      ['bodies-solar', false],
      ['bodies-lunar', false],
    ],
  );
  assert.match(controls.info, /Penumbral lunar eclipse/);
  assert.equal(controls.legend.length, 7);
  // Narrowed to the Moon, the choice stays; narrowed to the Sun, it moves on
  // to the next solar eclipse.
  h.layer.setParams({ bodies: 'lunar' });
  assert.equal(h.layer.getParams().eclipse, '2027-02-20');
  h.layer.setParams({ bodies: 'solar' });
  assert.equal(h.layer.getParams().eclipse, '2027-08-02');
});

test('a lunar eclipse draws the lines where the Moon sits on the horizon as it begins and ends', async () => {
  const h = await enabled({ bodies: 'lunar' });
  h.layer.setParams({ eclipse: '2025-09-07' });
  const ids = h.entityIds();
  for (const id of [
    'eclipse-path:horizon:penumbral:0',
    'eclipse-path:horizon:penumbral:1',
    'eclipse-path:horizon:umbral:0',
    'eclipse-path:horizon:umbral:1',
    'eclipse-path:greatest',
  ])
    assert.ok(ids.includes(id), `${id} is drawn`);
  assert.ok(!ids.includes('eclipse-path:band'));
  // No partial-eclipse limit: a lunar eclipse has none.
  h.settle();
  assert.ok(!h.entityIds().some((id) => id.startsWith('eclipse-path:limit:')));
  const controls = h.layer.getRowControls();
  assert.match(controls.info, /Total lunar eclipse/);
  assert.match(controls.info, /Totality: 1 h 22 min/);
  // There is no turning the camera to the Moon.
  assert.ok(!controls.chips.some(({ id }) => id === 'look'));
  // The timeline covers it from the first touch of the penumbra to the last.
  const eclipse = lunarCatalog.find(({ id }) => id === '2025-09-07');
  const coverage = h.clock.coverage();
  assert.equal(coverage.start, eclipse.startMs);
  assert.equal(coverage.end, eclipse.endMs);
});

test('during a lunar eclipse the layer tints the half of the Earth with the Moon in its sky', async () => {
  const h = await enabled({ bodies: 'all' });
  const eclipse = lunarCatalog.find(({ id }) => id === '2025-09-07');
  h.clock.seek(eclipse.greatestMs);
  h.frame();
  assert.equal(h.layer.getParams().eclipse, '2025-09-07');
  assert.equal(h.layer.getDiagnostics().inProgress, '2025-09-07');
  const shown = h.shadow.lunar;
  // The Moon stands over 6°S 87°E, sixty Earth radii out, wholly in the umbra.
  const [x, y, z, radius] = shown.moon;
  assert.ok(Math.abs(Math.hypot(x, y, z) - 60.27) < 1e-9);
  assert.ok(Math.abs((Math.atan2(y, x) * 180) / Math.PI - 87) < 0.01);
  assert.ok(Math.abs(radius - 0.2725076) < 1e-9);
  assert.equal(shown.depth, 1);
  assert.equal(h.shadow.solar, null);
  // Luxor has the Moon up: the sky view shows it in totality.
  assert.equal(h.sky.shown.view.lunar, true);
  assert.equal(h.sky.shown.view.phase, 'total');
  assert.equal(h.sky.shown.view.below, false);
  // The flag stands where the Moon is overhead at greatest eclipse.
  assert.deepEqual(h.sky.shown.lines, ['Seen from -6°, 87°', 'Totality']);
  // A lunar eclipse casts no shadow on the Earth to follow.
  assert.ok(!h.layer.getRowControls().chips.some(({ id }) => id === 'follow'));
  // Before the umbra reaches it, the Moon is only in the penumbra.
  h.clock.seek(eclipse.contacts.partial[0] - 5 * 60_000);
  h.frame();
  assert.equal(h.sky.shown.view.phase, 'penumbral');
  assert.equal(h.shadow.lunar.depth, 0);
  // After the last contact nothing is drawn.
  h.clock.seek(eclipse.endMs + 60_000);
  h.frame();
  assert.equal(h.shadow.shown, false);
});

test('the list marks each eclipse with a Sun or a Moon', async () => {
  const h = await enabled({ bodies: 'all' });
  h.layer.setParams({ eclipse: '2027-08-02' });
  const items = h.layer.getRowControls().list.items;
  const text = (id) => items.find((item) => item.id === id).text;
  assert.match(text('2027-08-02'), /^☀️ /u);
  assert.match(text('2027-02-20'), /^🌙 /u);
});
