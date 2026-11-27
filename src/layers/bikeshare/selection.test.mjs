import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelection } from './selection.js';
import { createRendering } from './rendering.js';
import { createState } from './state.js';
import { BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS } from './policy.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeInput } from '../../input/testDoubles.mjs';
import { setClickCardHitTest } from '../../data/pickRegistry.js';

/** A station layer's selection on a viewer whose pick is scripted. */
function harness(t) {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  let picked = null;
  const viewer = { scene: { canvas: new EventTarget(), pick: () => picked } };
  const input = fakeInput(viewer);
  const noop = () => {};
  const state = {
    _selectedKey: null,
    _clickSubscription: null,
    _stationRenderMap: new Map([['nyc:1', { position: { x: 1, y: 0, z: 0 } }]]),
    _stationSet: { id: 'bikeshare:stations', upsert: noop },
    _selectedSet: {
      id: 'bikeshare:selected',
      set: noop,
      size: () => 0,
      clear: noop,
    },
  };
  const selection = createSelection({
    state,
    services: {
      overlays: { setOverlayEntries: noop, clearOverlaySource: noop },
    },
    parts: { rendering: { stationItem: () => ({}) } },
  });
  selection._installClickHandler(viewer);
  t.after(() => {
    state._clickSubscription?.();
    input.destroy();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  return {
    state,
    click(hit) {
      picked = hit ? { id: hit } : null;
      input.tap({ x: 10, y: 10 });
    },
  };
}

// The card or label painted on top takes the click: a station under another
// layer's card is neither selected nor let go.
test("another layer's card over a station keeps the click", (t) => {
  const h = harness(t);
  let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  setClickCardHitTest(() => top);
  t.after(() => setClickCardHitTest(null));
  const station = { set: 'bikeshare:stations', id: 'nyc:1' };
  h.click(station);
  assert.equal(h.state._selectedKey, null, 'covered: not selected');
  top = null;
  h.click(station);
  assert.equal(h.state._selectedKey, 'nyc:1');
  top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  h.click(null);
  assert.equal(h.state._selectedKey, 'nyc:1', 'covered: kept');
  top = null;
  h.click(null);
  assert.equal(h.state._selectedKey, null, 'open map lets it go');
});

function makeRecord() {
  return {
    stationId: '3790',
    stationName: 'Congress & 6th',
    bikesAvailable: 7,
    docksAvailable: 4,
    capacity: 11,
    isInstalled: true,
    isRenting: false,
    isReturning: true,
    key: 'austin-capmetro:3790',
    position: fromDegrees(-97.7431, 30.2672, 2),
    pixelSize: 8,
    color: [0, 1, 0, 1],
  };
}

test('real station select/clear path publishes one card and draws no native label', () => {
  const calls = [];
  const services = {
    overlays: {
      setOverlayEntries: (...args) => calls.push(['entries', ...args]),
      setOverlaySourceVisible: (...args) => calls.push(['visible', ...args]),
      clearOverlaySource: (...args) => calls.push(['clear', ...args]),
    },
    render: { governorRequestRender() {} },
  };
  const state = createState();
  const parts = {};
  const context = { state, services, parts };
  parts.rendering = createRendering(context);
  parts.selection = createSelection(context);
  const key = 'austin-capmetro:3790';
  const record = makeRecord();
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  state._viewer = viewer;
  parts.rendering.attachSets(viewer);
  state._stationRenderMap = new Map([[key, record]]);
  const live = (suffix) =>
    [...draw.sets.values()].find(
      (set) => !set.disposed && set.spec.id.endsWith(suffix),
    );
  const stations = live(':stations');
  const selected = live(':selected');
  try {
    parts.selection._selectStation(key);
    assert.equal(
      stations.items.get(key).show,
      false,
      'the station’s own dot is hidden',
    );
    assert.equal(selected.items.size, 1, 'one highlight dot replaces it');
    const [highlight] = selected.items.values();
    assert.equal(highlight.pos, record.position);
    assert.deepEqual(highlight.color, [0, 1, 1, 1], 'cyan');
    assert.equal(highlight.pixelSize, 14);
    assert.equal(highlight.disableDepthTest, Infinity);

    const publication = calls.find(([type]) => type === 'entries');
    assert.ok(publication);
    assert.equal(publication[1], 'bikeshare-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].position, record.position);
    assert.deepEqual(publication[3], BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS);

    parts.selection._clearSelection();
    assert.equal(stations.items.get(key).show, true);
    assert.equal(selected.items.size, 0);
    assert.deepEqual(calls.at(-1), ['clear', 'bikeshare-selected']);
  } finally {
    parts.selection._clearSelection();
    unbind();
  }
});
