import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, setLocale } from '../../i18n/index.js';
import { createModel } from './model.js';
import { createQueries } from './queries.js';
import { createCards } from './cards.js';

test('a FIRMS snapshot that ends at a set time names it instead of LIVE', (context) => {
  const now = 1800000000000;
  context.mock.method(Date, 'now', () => now);
  const previousLocale = getLocale();
  const at = Date.UTC(2026, 9, 21, 15);
  const layerState = {
    _loading: false,
    _stale: false,
    _keyRequired: false,
    _error: null,
    _lastUpdate: now - 120000,
    _at: at,
    _count: 1,
    _cellCount: 0,
    _fires: [],
  };
  const model = createModel({ services: { anchors: {} } });
  const { methods } = createQueries({
    layerState,
    components: { model },
    config: {},
  });
  try {
    setLocale('en');
    assert.equal(methods.getStats().loadingLabel, '24 h to 10-21 15:00 UTC');
    assert.equal(methods.getStats().at, at);
    assert.equal(methods.getStats().source, 'NASA FIRMS', 'the row drops LIVE');
    setLocale('de');
    assert.equal(methods.getStats().loadingLabel, '24 h bis 21.10. 15:00 UTC');
    layerState._at = null;
    setLocale('en');
    assert.equal(methods.getStats().loadingLabel, 'LIVE · updated 2m ago');
    assert.equal(methods.getStats().at, null);
    assert.equal(methods.getStats().source, undefined);
  } finally {
    setLocale(previousLocale);
  }
});

test('fire cards count ages from the end of the window shown, and from now when live', (context) => {
  const now = Date.UTC(2026, 10, 14, 12);
  context.mock.method(Date, 'now', () => now);
  // A window that ended months before now: its newest fire three hours earlier.
  const at = Date.UTC(2026, 7, 1, 12);
  const layerState = { _at: at };
  const model = createModel({ layerState, services: { anchors: {} } });
  const cell = {
    count: 4,
    maxFrp: 210,
    newestAcqMs: at - 3 * 3_600_000,
    latCell: 1,
    lonCell: 2,
  };
  const previousLocale = getLocale();
  try {
    setLocale('en');
    assert.equal(model.ageReferenceMs(), at);
    const card = model.buildCellCard({ cell, position: {} }, model.ageReferenceMs());
    assert.equal(card.details[0], 'max 210 MW · new 3h', 'not months old');

    // The cards the scene shows use the same time.
    const entries = [];
    layerState._viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
    layerState._fireByCardId = new Map();
    layerState._selectedFire = null;
    layerState._labelCandidates = [{ cell, position: {} }];
    layerState._labelLodDistance = 0;
    const { rebuildAmbientLabels } = createCards({
      layerState,
      services: {},
      components: {
        model,
        rendering: {
          scenePorts: () => ({
            query: { project: () => ({ x: 400, y: 300 }), isOccluded: () => false },
          }),
        },
      },
      config: { overlayHost: { setEntries: (source, shown) => entries.push(...shown) } },
    });
    rebuildAmbientLabels();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].details[0], 'max 210 MW · new 3h');

    // Live, they count from now.
    layerState._at = null;
    cell.newestAcqMs = now - 5 * 3_600_000;
    assert.equal(model.ageReferenceMs(), now);
    entries.length = 0;
    rebuildAmbientLabels();
    assert.equal(entries[0].details[0], 'max 210 MW · new 5h');
  } finally {
    setLocale(previousLocale);
  }
});
