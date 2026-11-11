import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, setLocale } from '../../i18n/index.js';
import { createModel } from './model.js';
import { createQueries } from './queries.js';

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
    assert.equal(
      methods.getStats().loadingLabel,
      '24 Std. bis 21.10. 15:00 UTC',
    );
    layerState._at = null;
    setLocale('en');
    assert.equal(methods.getStats().loadingLabel, 'LIVE · updated 2m ago');
    assert.equal(methods.getStats().at, null);
    assert.equal(methods.getStats().source, undefined);
  } finally {
    setLocale(previousLocale);
  }
});
