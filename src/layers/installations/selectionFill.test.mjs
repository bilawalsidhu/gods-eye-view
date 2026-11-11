import test from 'node:test';
import assert from 'node:assert/strict';

import * as context from '../../data/contextStore.js';
import { SELECTION_FILL_SET_ID } from './render/display.js';
import { createDisplayHarness } from './render/displayHarness.mjs';
import { GROUND_HARNESSES } from '../../testSupport/groundDisplayEngines.mjs';

function harness(t, makeHarness) {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const ring = [
    [-97, 30],
    [-96.99, 30],
    [-96.99, 30.01],
    [-97, 30],
  ];
  const record = {
    id: 'base',
    latitude: 30,
    longitude: -97,
    name: 'Base',
    class: 'base',
    footprints: [[ring, ring.map(([x, y]) => [x + 0.001, y + 0.001])], [ring]],
  };
  const h = createDisplayHarness(makeHarness);
  h.setRecords([record]);
  h.state.selectedId = 'base';
  // Photoreal tiles shown: the globe is hidden.
  h.setPhotoreal(true);
  h.parts.display.init();
  t.after(() => {
    h.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const fill = () => h.set(SELECTION_FILL_SET_ID);
  return {
    h,
    record,
    render: h.parts.display,
    lifecycle: h.parts.display,
    fill,
  };
}

for (const makeHarness of GROUND_HARNESSES) {
  const { name } = makeHarness();

  test(`selected multipart footprints drape on Google tiles in one constant translucent colour with holes (${name})`, (t) => {
    const { h, render, fill } = harness(t, makeHarness);
    h.state.enabled = true;
    render.syncSelectionFill();
    const { items, options, commits } = fill();
    assert.equal(items.length, 2);
    assert.equal(options.drape, 'tiles');
    for (const item of items) {
      assert.equal(item.pickId, 'base');
      assert.equal(item.fill[3], 0.22);
      assert.equal(item.height, undefined);
    }
    assert.equal(
      items[0].rings.length,
      2,
      'the first footprint keeps its hole',
    );
    assert.deepEqual(items[0].fill, items[1].fill);

    for (let i = 0; i < 100; i++) render.syncSelectionFill();
    assert.equal(fill().commits, commits, 'repaints retain ground geometry');
    h.state.selectedId = null;
    render.syncSelectionFill();
    assert.equal(fill().items.length, 0);
  });

  test(`surface changes re-drape selected geometry and disable tears down fills and subscription (${name})`, (t) => {
    const { h, lifecycle, render, fill } = harness(t, makeHarness);
    lifecycle.enable();
    h.state.selectedId = 'base';
    render.syncSelectionFill();
    h.setPhotoreal(false);
    h.changeMapStack();
    assert.equal(fill().options.drape, 'both');
    assert.equal(fill().items.length, 2);

    lifecycle.disable();
    assert.equal(fill().items.length, 0);
    assert.equal(h.mapStackRemoved(), 1);
    lifecycle.enable();
    render.syncSelectionFill();
    assert.equal(
      fill().items.length,
      0,
      'reenabling cannot revive a stale selection',
    );
    lifecycle.disable();
  });

  test(`geometry rebuild and canonical alias migration preserve shared selection before pruning (${name})`, (t) => {
    const { h, record, render } = harness(t, makeHarness);
    h.state.enabled = true;
    const cleared = [];
    window.addEventListener('gev:entity-selection-cleared', (e) => {
      cleared.push(e.detail);
      h.state.selectedId = null;
    });
    render.renderRecords({ claimSelection: true });
    const oldEntity = context.getSelectedEntityContext().entity;
    h.setRecords([{ ...record, latitude: record.latitude + 0.001 }]);
    render.renderRecords();
    assert.equal(h.state.selectedId, 'base');
    assert.equal(context.getSelectedEntityContext().id, 'base');
    assert.notEqual(context.getSelectedEntityContext().entity, oldEntity);
    const replacement = { ...record, id: 'canonical', aliasIds: ['base'] };
    h.setRecords([replacement]);
    render.renderRecords();
    assert.equal(h.state.selectedId, 'canonical');
    assert.equal(context.getSelectedEntityContext().id, 'canonical');
    assert.deepEqual(
      cleared,
      [],
      'no transient eviction can tear down the selected card or fill',
    );
    render.clearRendered();
  });
}
