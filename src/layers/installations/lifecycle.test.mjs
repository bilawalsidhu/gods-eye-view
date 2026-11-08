import test from 'node:test';
import assert from 'node:assert/strict';
import * as credits from '../../data/dataCredits.js';
import { LAYER_ID } from './policy.js';
import { OUTLINE_SET_ID } from './render/display.js';
import { createDisplayHarness } from './render/displayHarness.mjs';
import { createFakeGroundHarness } from '../../testSupport/groundDisplayEngines.mjs';

for (const source of [
  { name: 'OpenStreetMap', id: 'tile:base' },
  { name: 'OpenStreetMap', id: 'way:123' },
  { name: 'Google Places', id: 'place:base' },
  null,
]) {
  test(`enable restores cached installation credits before a refresh: ${source?.id || 'empty'}`, () => {
    const h = createDisplayHarness(createFakeGroundHarness);
    h.services.credits = credits;
    const { engine } = h;
    const visibleCredits = () => engine.fake.credits.length;
    h.setRecords(
      source
        ? [{ id: 'base', latitude: 0, longitude: 0, sources: [source] }]
        : [],
    );
    h.state.recordById = new Map();
    const lifecycle = h.parts.display;
    lifecycle.init();
    const outlinesShown = () =>
      [0, 1].every((n) => h.set(`${OUTLINE_SET_ID}-${n}`).shown);
    const expected =
      source?.name === 'OpenStreetMap'
        ? source.id.startsWith('tile:')
          ? 2
          : 1
        : 0;
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        lifecycle.enable();
        assert.equal(outlinesShown(), true);
        assert.equal(h.labels.visible, true);
        // No renderRecords or successful fetch occurs between toggles.
        assert.equal(visibleCredits(), expected);
        lifecycle.disable();
        assert.equal(outlinesShown(), false);
        assert.equal(h.labels.visible, false);
        assert.equal(visibleCredits(), 0);
      }
      credits.showOsmCredit(engine, 'another-layer');
      lifecycle.enable();
      lifecycle.disable();
      assert.equal(visibleCredits(), 1, 'another owner retains its credit');
      assert.equal(credits.hideOsmCredit(engine, LAYER_ID), false);
    } finally {
      lifecycle.disable();
      credits.hideOsmCredit(engine, 'another-layer');
      h.destroy();
    }
  });
}
