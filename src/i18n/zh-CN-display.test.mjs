import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from './index.js';
import { hudQuantity, LOCALIZED_LOCALITY } from '../hudLocalityFormat.js';
import { formatCockpitDistance } from '../ui/cockpitPresentation.js';
import { cctvSourceStatusLabel } from '../ui/cctvFrames.js';
import { READOUT_WORDS } from '../layers/recentImagery/display.js';
import { createModel } from '../layers/firms/model.js';
import { createQueries } from '../layers/firms/queries.js';
import { renderRadioState } from '../ui/radioPresentation.js';

test('Chinese HUD and cockpit units keep their case without spacing coordinates', () => {
  try {
    setLocale('zh-CN');
    assert.equal(hudQuantity(0, 'km'), '0 km');
    assert.equal(hudQuantity(2069, 'km', 1), '2069.0 km');
    assert.equal(formatCockpitDistance(14000), '14\u00a0km');
    assert.equal(LOCALIZED_LOCALITY.sector({ latDeg: 21.33, lonDeg: -77.5 }),
      '扇区 21.33N 77.50W');
    setLocale('ja');
    assert.equal(hudQuantity(13, 'km'), '13 km');
    assert.equal(hudQuantity(1.5, 'km', 1), '1.5 km');
    setLocale('en');
    assert.equal(hudQuantity(0, 'km'), '0KM');
    assert.equal(hudQuantity(2069, 'km', 1), '2069.0KM');
    assert.equal(formatCockpitDistance(14000), '14\u00a0KM');
  } finally {
    setLocale('en');
  }
});

test('FIRMS stale cache age uses localized durations while English stays compact', () => {
  const now = Date.now();
  const layerState = { _stale: true };
  const components = {
    model: createModel({ services: { anchors: {} } }),
  };
  const { methods } = createQueries({ layerState, components, config: {} });
  try {
    for (const [hours, zh, en] of [[0.5, '不到 1 小时', '<1h'], [2, '2 小时', '2h'], [72, '3 天', '3d']]) {
      layerState._lastUpdate = now - hours * 3600000;
      setLocale('zh-CN');
      const expected = t('STALE · cached {age}', { age: zh });
      assert.equal(methods.getStats().loadingLabel, expected);
      assert.equal(methods.getStats().error, expected);
      setLocale('en');
      assert.equal(methods.getStats().loadingLabel, `STALE · cached ${en}`);
    }
  } finally {
    setLocale('en');
  }
});

test('Recent Imagery spaces numeric Chinese ages and retains natural relative dates', () => {
  try {
    setLocale('zh-CN');
    assert.equal(READOUT_WORDS.daysAgo(9), '9 天前');
    assert.equal(READOUT_WORDS.daysAgo(0), '今天');
    assert.equal(READOUT_WORDS.daysAgo(1), '昨天');
    setLocale('en');
    assert.equal(READOUT_WORDS.daysAgo(9), '9 days ago');
    assert.equal(READOUT_WORDS.daysAgo(0), 'today');
  } finally {
    setLocale('en');
  }
});

test('CCTV translates the healthy status and preserves unknown provider codes', () => {
  try {
    for (const [locale, expected] of [['zh-CN', '正常'], ['ru', 'НОРМА'], ['es', 'OK'], ['en', 'OK']]) {
      setLocale(locale);
      assert.equal(cctvSourceStatusLabel('ok'), expected);
      assert.equal(cctvSourceStatusLabel('CUSTOM'), 'CUSTOM');
    }
  } finally {
    setLocale('en');
  }
});

test('radio option text and accessible name use the same localized parentheses', () => {
  const originalDocument = globalThis.document;
  const element = () => ({
    style: {}, dataset: {}, attributes: {},
    classList: { contains: () => true, toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(...children) { this.children = children; },
  });
  globalThis.document = { createElement: element, getElementById: () => null };
  try {
    for (const [locale, label, expected] of [['zh-CN', '全部', '全部（750）'], ['en', 'All', 'All (750)']]) {
      setLocale(locale);
      const host = {
        _radioPanel: element(), _radioFilter: element(),
        actions: { getLifecycle: () => null, scheduleLayout() {} },
      };
      renderRadioState.call(host, {
        enabled: true, categories: [{ id: 'all', label, count: 750, color: '' }],
        filter: 'all', filteredCount: 750, stationCount: 750, volume: 1,
      });
      const option = host._radioFilter.children[0];
      assert.equal(option.textContent, `● ${expected}`);
      assert.equal(option.attributes['aria-label'], expected);
    }
  } finally {
    globalThis.document = originalDocument;
    setLocale('en');
  }
});
