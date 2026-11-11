// Mapped Installations on the engine contract, on the fake engine and on the
// Cesium engine: the sites' discs, the named areas' outlines, the ground
// outlines and the selection fill, what a pick selects, the context handles,
// late floors and teardown.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import * as context from '../../../data/contextStore.js';
import { claimPointer, releasePointer } from '../../../data/inputOwnership.js';
import { setLocale } from '../../../i18n/index.js';
import { rgbaFromCss } from '../../shared/color.js';
import { installationClassLabel, installationTitle } from '../classLabel.js';
import { COLOR_BY_CLASS, LAYER_ID } from '../policy.js';
import {
  MARKER_SET_ID,
  OUTLINE_SET_ID,
  SELECTED_MARKER_SET_ID,
  SELECTION_FILL_SET_ID,
} from './display.js';
import { NAMED_MARKER_SET_ID } from './namedMarkers.js';
import { createDisplayHarness } from './displayHarness.mjs';
import { GROUND_HARNESSES } from '../../../testSupport/groundDisplayEngines.mjs';

const ring = (west, south, size = 0.01) => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];

const airfield = () => ({
  id: 'osm:way:1',
  kind: 'installation',
  class: 'airfield',
  name: 'QA Airfield',
  latitude: 30.005,
  longitude: -96.995,
  footprint: ring(-97, 30),
  sources: [{ name: 'OpenStreetMap', id: 'way:1' }],
});

const namedRange = () => ({
  id: 'osm:military:w2',
  kind: 'installation',
  class: 'range',
  name: 'Named Range',
  namedArea: true,
  areaM2: 5e6,
  latitude: 30.105,
  longitude: -97.095,
  footprints: [[ring(-97.1, 30.1), ring(-97.098, 30.102, 0.002)]],
  outlineLines: [ring(-97.1, 30.1), ring(-97.098, 30.102, 0.002)],
});

const classColor = (record, alpha) =>
  rgbaFromCss(COLOR_BY_CLASS[record.class]).withAlpha(alpha).rgba();

function closeTo(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) < 1e-6, message),
  );
}

/** A started display over Texas, with the window the context store needs. */
function setup(t, makeHarness, records = [airfield()], options) {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const h = createDisplayHarness(makeHarness, options);
  h.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-97, 30, 50_000),
  });
  h.setRecords(records);
  h.start();
  t.after(() => {
    h.destroy();
    context.removeEntityContextsForLayer(LAYER_ID);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  return h;
}

/** The outline set holding the drawn outlines (the other one is empty). */
function drawnOutlines(h) {
  const sets = [0, 1].map((n) => h.set(`${OUTLINE_SET_ID}-${n}`));
  return sets.find((set) => set.items.length) ?? sets[1];
}

for (const makeHarness of GROUND_HARNESSES) {
  const { name } = makeHarness();

  test(`sites are 9 px discs in their class colour, 13 px and white when selected, always on top (${name})`, (t) => {
    const h = setup(t, makeHarness);
    h.parts.display.renderRecords();
    const [disc] = h.markers(MARKER_SET_ID);
    assert.equal(h.markers(MARKER_SET_ID).length, 1);
    assert.equal(disc.pickId, 'osm:way:1', 'a pick names the site');
    closeTo(disc.color, classColor(airfield(), 1));
    assert.equal(h.markers(SELECTED_MARKER_SET_ID).length, 0);
    {
      const { options } = h.engine.fake.moverSet(MARKER_SET_ID);
      assert.equal(options.kind, 'point');
      assert.equal(options.point.sizePx, 9);
      assert.equal(options.point.outlinePx, 1);
      assert.deepEqual(options.point.outlineColor, [0, 0, 0, 0.8]);
      assert.equal(options.depthTest, 'always');
      assert.equal(options.pickable, true);
      assert.ok(options.order < 0, 'under the moving contacts');
      const selected = h.engine.fake.moverSet(SELECTED_MARKER_SET_ID).options;
      assert.equal(selected.point.sizePx, 13);
      assert.ok(selected.order > options.order, 'over the other discs');
    }

    assert.equal(h.parts.display.selectRecord('osm:way:1'), true);
    assert.equal(h.markers(MARKER_SET_ID).length, 0);
    const [chosen] = h.markers(SELECTED_MARKER_SET_ID);
    assert.equal(chosen.pickId, 'osm:way:1');
    closeTo(chosen.color, [1, 1, 1, 1]);
  });

  test(`a named area draws no disc but its outlines are drawn, as on Cesium (${name})`, (t) => {
    const named = namedRange();
    const h = setup(t, makeHarness, [airfield(), named]);
    h.parts.display.renderRecords();
    assert.deepEqual(
      h.markers(MARKER_SET_ID).map((disc) => disc.pickId),
      ['osm:way:1'],
      'the named area has no site disc',
    );
    const outlines = drawnOutlines(h).items.filter(
      (item) => item.pickId === named.id,
    );
    assert.equal(outlines.length, 2, 'every outline line of the named area');
    assert.deepEqual(outlines[0].positions, named.outlineLines[0]);
    closeTo(outlines[0].color, classColor(named, 0.85));
    const namedDiscs = h.markers(NAMED_MARKER_SET_ID);
    assert.equal(
      namedDiscs[0].pickId,
      named.id,
      'its named-area disc is drawn',
    );
    assert.equal(namedDiscs[0].show, true);
    // Selected, it still draws no site disc, and its outlines stay.
    h.parts.display.selectRecord(named.id);
    assert.equal(h.markers(SELECTED_MARKER_SET_ID).length, 0);
    assert.equal(
      drawnOutlines(h).items.filter((item) => item.pickId === named.id).length,
      2,
    );
  });

  test(`outlines are 2 px ground lines at 0.85 on both surfaces, rebuilt only for a changed site (${name})`, (t) => {
    const h = setup(t, makeHarness);
    h.parts.display.renderRecords();
    const set = drawnOutlines(h);
    assert.equal(set.options.kind, 'corridor');
    assert.equal(set.options.drape, 'both');
    assert.equal(set.options.pickable, true);
    assert.equal(set.items.length, 1);
    const [line] = set.items;
    assert.equal(line.widthPx, 2);
    assert.equal(line.pickId, 'osm:way:1');
    closeTo(line.color, classColor(airfield(), 0.85));

    const commits = [0, 1].map((n) => h.set(`${OUTLINE_SET_ID}-${n}`).commits);
    for (let i = 0; i < 5; i++) h.parts.display.renderRecords();
    assert.deepEqual(
      [0, 1].map((n) => h.set(`${OUTLINE_SET_ID}-${n}`).commits),
      commits,
      'repaints with the same geometry rebuild nothing',
    );

    // A changed site rebuilds the set; the drawn outlines stay until the
    // new ones are drawn.
    h.setRecords([
      airfield(),
      { ...airfield(), id: 'osm:way:3', latitude: 30.2 },
    ]);
    h.parts.display.renderRecords();
    const counts = () =>
      [0, 1].map((n) => h.set(`${OUTLINE_SET_ID}-${n}`).items.length);

    assert.deepEqual(counts(), [2, 0]);
  });

  test(`the selected footprints fill at 0.22 with their holes, on the tiles under photoreal (${name})`, (t) => {
    const named = namedRange();
    const h = setup(t, makeHarness, [named]);
    h.setPhotoreal(true);
    h.parts.display.renderRecords();
    assert.equal(
      h.set(SELECTION_FILL_SET_ID),
      undefined,
      'no fill before a selection',
    );
    h.parts.display.selectRecord(named.id);
    const fill = h.set(SELECTION_FILL_SET_ID);
    assert.equal(fill.options.drape, 'tiles');
    assert.equal(fill.options.kind, 'polygon');
    assert.ok(
      fill.options.order < drawnOutlines(h).options.order,
      'under the outlines',
    );
    assert.equal(fill.items.length, 1, 'one polygon per footprint');
    assert.equal(fill.items[0].rings.length, 2, 'with its hole');
    assert.equal(fill.items[0].pickId, named.id);
    assert.equal(fill.items[0].outline, undefined);
    closeTo(fill.items[0].fill, classColor(named, 0.22));

    const commits = fill.commits;
    for (let i = 0; i < 10; i++) h.parts.display.renderRecords();
    assert.equal(
      h.set(SELECTION_FILL_SET_ID).commits,
      commits,
      'repaints keep the fill',
    );

    // The map stack changes to the globe: the fill drapes on both.
    h.setPhotoreal(false);
    h.changeMapStack();
    assert.equal(h.set(SELECTION_FILL_SET_ID).options.drape, 'both');
    assert.equal(h.set(SELECTION_FILL_SET_ID).items.length, 1);

    h.parts.display.disable();
    assert.equal(h.set(SELECTION_FILL_SET_ID).items.length, 0);
    assert.equal(
      h.mapStackRemoved(),
      1,
      'disable drops the map-stack listener',
    );
    h.parts.display.enable();
    h.parts.display.syncSelectionFill();
    assert.equal(
      h.set(SELECTION_FILL_SET_ID).items.length,
      0,
      'reenabling cannot revive a stale selection',
    );
  });

  test(`a click on a disc, an outline or the fill selects the site; the next click releases it (${name})`, (t) => {
    const h = setup(t, makeHarness);
    h.parts.display.renderRecords();
    h.click({ id: 'osm:way:1' });
    assert.equal(h.state.selectedId, 'osm:way:1');
    assert.equal(context.getSelectedEntityContext()?.id, 'osm:way:1');
    h.click({ id: 'osm:way:1' });
    assert.equal(
      h.state.selectedId,
      null,
      'clicking the selected site releases it',
    );
    assert.equal(context.getSelectedEntityContext(), null);

    h.click({ set: `${OUTLINE_SET_ID}-1`, instance: 0 });
    assert.equal(
      h.state.selectedId,
      'osm:way:1',
      'an outline selects its site',
    );
    h.click({ id: 'aircraft:1' });
    assert.equal(h.state.selectedId, null, 'another contact releases it');
    h.parts.display.selectRecord('osm:way:1');
    h.click({ set: SELECTION_FILL_SET_ID, instance: 0 });
    assert.equal(
      h.state.selectedId,
      null,
      'the fill of the selected site releases it',
    );

    const lease = claimPointer('draw');
    try {
      h.click({ id: 'osm:way:1' });
      assert.equal(
        h.state.selectedId,
        null,
        'a tool that owns the pointer keeps it',
      );
    } finally {
      releasePointer(lease);
    }
    h.parts.display.disable();
    h.click({ id: 'osm:way:1' });
    assert.equal(h.state.selectedId, null, 'a disabled layer ignores clicks');
  });

  test(`each drawn site has a context handle on its floor, kept while its geometry is unchanged (${name})`, (t) => {
    const h = setup(t, makeHarness);
    const record = airfield();
    h.floors.set(`${record.latitude},${record.longitude}`, 125);
    try {
      setLocale('ru');
      h.parts.display.renderRecords();
      const handle = context.getContextStore().entities.get(record.id).entity;
      assert.equal(handle.gevTrackedId, `installations:${record.id}`);
      assert.deepEqual(handle.gevLabelModel, {
        title: installationTitle('QA Airfield'),
        details: [installationClassLabel('airfield')],
        accent: COLOR_BY_CLASS.airfield,
      });
      assert.notEqual(
        handle.gevLabelModel.details[0],
        'AIRFIELD',
        'in the UI language',
      );
      const height = geo.cartographic.fromCartesian(
        handle.gevDisplayPosition(),
      ).height;
      assert.ok(Math.abs(height - 125) < 0.01, 'on the cached ground floor');
      const entry = context.getContextStore().entities.get(record.id);
      assert.equal(entry.layerName, 'Mapped Military Installations');
      assert.equal(entry.source, 'OpenStreetMap');

      h.parts.display.renderRecords();
      assert.equal(
        context.getContextStore().entities.get(record.id).entity,
        handle,
        'a repaint with the same geometry keeps the handle',
      );
      h.setRecords([{ ...record, latitude: record.latitude + 0.001 }]);
      h.parts.display.renderRecords();
      assert.notEqual(
        context.getContextStore().entities.get(record.id).entity,
        handle,
      );
    } finally {
      setLocale('en');
    }
  });

  test(`floors that resolve late paint the discs again (${name})`, async (t) => {
    let warm;
    const h = setup(t, makeHarness, [airfield()], {
      warmFloors: () => new Promise((resolve) => (warm = resolve)),
    });
    const record = airfield();
    h.parts.display.renderRecords();
    const heightOf = () =>
      geo.cartographic.fromCartesian(h.markers(MARKER_SET_ID)[0].position)
        .height;
    assert.ok(
      Math.abs(heightOf()) < 0.01,
      'a cold floor sits on the ellipsoid',
    );
    h.parts.display.warmInstallationFloors([record]);
    h.floors.set(`${record.latitude},${record.longitude}`, 2400);
    warm(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      Math.abs(heightOf() - 2400) < 0.01,
      'the late floor lifts the disc',
    );
  });

  test(`teardown removes every set and listener (${name})`, (t) => {
    const h = setup(t, makeHarness, [airfield(), namedRange()]);
    const changed = h.engine.camera.changed.numberOfListeners;
    h.parts.display.renderRecords();
    h.parts.display.selectRecord('osm:way:1');
    assert.ok(h.listeners() > 0);
    h.parts.display.detach();
    assert.equal(h.listeners(), 0, 'no click listener');
    assert.equal(
      h.engine.camera.changed.numberOfListeners,
      changed - 2,
      'the viewport and named-marker camera listeners go',
    );
    assert.deepEqual(
      h.engine.movers.list().filter(({ id }) => id.startsWith(LAYER_ID)),
      [],
    );
    assert.equal(h.sets(), 0, 'no ground set');
    assert.equal(context.getContextStore().entities.has('osm:way:1'), false);
  });
}
