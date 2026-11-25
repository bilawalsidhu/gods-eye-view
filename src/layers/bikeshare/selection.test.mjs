import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelection } from './selection.js';
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
    _overlayHost: { setEntries: noop, clearSource: noop },
  };
  const selection = createSelection({
    state,
    services: {},
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
