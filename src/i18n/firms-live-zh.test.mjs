import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, setLocale } from './index.js';
import { createModel } from '../layers/firms/model.js';
import { createQueries } from '../layers/firms/queries.js';

const cases = [
  [0, '不到 1 分钟前', '<1m ago', '不到 1 分鐘前'],
  [120000, '2 分钟前', '2m ago', '2 分鐘前'],
  [7200000, '2 小时前', '2h ago', '2 小時前'],
];

for (const [age, zh, en, hant] of cases) {
  test(`FIRMS live age ${age} ms has one relative-time suffix`, (context) => {
    const now = 1800000000000;
    context.mock.method(Date, 'now', () => now);
    const previousLocale = getLocale();
    const layerState = {
      _loading: false,
      _stale: false,
      _keyRequired: false,
      _error: null,
      _lastUpdate: now - age,
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
      assert.equal(methods.getStats().loadingLabel, `LIVE · updated ${en}`);
      setLocale('zh-CN');
      assert.equal(methods.getStats().loadingLabel, `实时 · 更新于 ${zh}`);
      setLocale('zh-Hant');
      assert.equal(methods.getStats().loadingLabel, `實時 · 更新於 ${hant}`);
    } finally {
      setLocale(previousLocale);
    }
  });
}

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
    setLocale('de');
    assert.equal(
      methods.getStats().loadingLabel,
      '24 Std. bis 21.10. 15:00 UTC',
    );
    layerState._at = null;
    setLocale('en');
    assert.equal(methods.getStats().loadingLabel, 'LIVE · updated 2m ago');
    assert.equal(methods.getStats().at, null);
  } finally {
    setLocale(previousLocale);
  }
});
