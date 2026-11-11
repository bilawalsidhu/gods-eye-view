import test from 'node:test';
import assert from 'node:assert/strict';
import * as credits from '../../data/dataCredits.js';
import { createLifecycle } from './lifecycle.js';
import { LAYER_ID } from './policy.js';

for (const source of [
  { name: 'OpenStreetMap', id: 'tile:base' },
  { name: 'OpenStreetMap', id: 'way:123' },
  { name: 'Google Places', id: 'place:base' },
  null,
]) {
  test(`enable restores cached installation credits before a refresh: ${source?.id || 'empty'}`, () => {
    const visibleCredits = new Set();
    const noop = () => {};
    const viewer = {
      camera: {},
      creditDisplay: {
        addStaticCredit: (credit) => visibleCredits.add(credit),
        removeStaticCredit: (credit) => visibleCredits.delete(credit),
      },
    };
    const state = {
      viewer,
      records: source ? [{ id: 'base', sources: [source] }] : [],
      recordById: new Map(),
      dataSource: { show: false },
    };
    let markersVisible = false;
    const parts = {
      namedMarkers: {
        enable: () => {
          markersVisible = true;
        },
        sync: noop,
        hide: () => {
          markersVisible = false;
        },
      },
      rendering: {},
      viewport: { clearUnavailableRetry: noop },
      ingestion: { setInstallationStatus: noop },
    };
    const lifecycle = createLifecycle({
      state,
      services: {
        credits,
        picking: { registerPickOwner: noop, unregisterPickOwner: noop },
        context: { clearSelectedEntityContextForLayer: noop },
      },
      parts,
      source: {},
    }).methods;
    const expected =
      source?.name === 'OpenStreetMap'
        ? source.id.startsWith('tile:')
          ? 2
          : 1
        : 0;
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        lifecycle.enable();
        assert.equal(state.dataSource.show, true);
        assert.equal(markersVisible, true);
        // No renderRecords or successful fetch occurs between toggles.
        assert.equal(visibleCredits.size, expected);
        lifecycle.disable();
        assert.equal(state.dataSource.show, false);
        assert.equal(markersVisible, false);
        assert.equal(visibleCredits.size, 0);
      }
      credits.showOsmCredit(viewer, 'another-layer');
      lifecycle.enable();
      lifecycle.disable();
      assert.equal(visibleCredits.size, 1, 'another owner retains its credit');
      assert.equal(credits.hideOsmCredit(viewer, LAYER_ID), false);
    } finally {
      lifecycle.disable();
      credits.hideOsmCredit(viewer, 'another-layer');
    }
  });
}
