import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIVER_ALERT_STORAGE_KEY,
  alertLevelsFor,
  alertReached,
  createRiverAlerts,
  requestAlertPermission,
  showBrowserAlert,
} from './alerts.js';

const NOW = Date.UTC(2026, 10, 4, 12);
const KOBLENZ = 'pegelonline:4c7d796a-39f2-4f26-97a9-3aad01713e29';

const memoryStorage = () => {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
};

const taiwan = (band, extra = {}) => ({
  id: 'wra:1140H041',
  name: 'Huang River',
  river: 'Huang River',
  band,
  level: 3.2,
  observedMs: NOW - 10 * 60_000,
  refs: { watch: 3, warning: 4, flood: 5 },
  ...extra,
});

test('a gauge offers only the levels its references can reach', () => {
  assert.deepEqual(alertLevelsFor(taiwan('normal')), [
    'watch',
    'warning',
    'flood',
  ]);
  // A German gauge: mean yearly high and low, and the records.
  assert.deepEqual(
    alertLevelsFor({
      refs: { recordLow: 0.8, low: 1.2, mean: 2.9, high: 7, recordHigh: 10.7 },
    }),
    ['watch', 'major', 'low', 'record-low'],
  );
  assert.deepEqual(alertLevelsFor({ refs: {} }), []);
  assert.deepEqual(alertLevelsFor(null), []);
});

test('a level is reached at it or further along its own ladder', () => {
  assert.equal(alertReached('flood', 'warning'), true);
  assert.equal(alertReached('major', 'flood'), true);
  assert.equal(alertReached('watch', 'flood'), false);
  assert.equal(alertReached('record-low', 'low'), true);
  assert.equal(alertReached('low', 'record-low'), false);
  // Low water never reaches a flood level, nor high water a drought one.
  assert.equal(alertReached('record-low', 'watch'), false);
  assert.equal(alertReached('flood', 'low'), false);
  assert.equal(alertReached('normal', 'nonsense'), false);
});

test('an alert fires once per crossing and re-arms when the water turns', () => {
  const alerts = createRiverAlerts({ storage: memoryStorage() });
  assert.deepEqual(alerts.set(taiwan('normal'), 'warning'), { reached: false });
  assert.deepEqual(alerts.check([taiwan('watch')], NOW), []);
  const [due] = alerts.check([taiwan('flood')], NOW);
  assert.equal(due.station.id, 'wra:1140H041');
  assert.equal(due.level, 'warning');
  // Still high: no second alert.
  assert.deepEqual(alerts.check([taiwan('warning')], NOW), []);
  // Back down, then up again: a new alert.
  assert.deepEqual(alerts.check([taiwan('normal')], NOW), []);
  assert.equal(alerts.check([taiwan('warning')], NOW).length, 1);
});

test('late readings and grey gauges change nothing', () => {
  const alerts = createRiverAlerts({ storage: memoryStorage() });
  alerts.set(taiwan('normal'), 'watch');
  const late = taiwan('flood', { observedMs: NOW - 5 * 60 * 60_000 });
  assert.deepEqual(alerts.check([late], NOW), []);
  assert.deepEqual(alerts.check([taiwan('unknown')], NOW), []);
  assert.equal(alerts.get('wra:1140H041').reached, false);
  assert.equal(alerts.check([taiwan('watch')], NOW).length, 1);
});

test('setting a level already reached says so and does not fire again', () => {
  const alerts = createRiverAlerts({ storage: memoryStorage() });
  assert.deepEqual(alerts.set(taiwan('flood'), 'warning'), { reached: true });
  assert.deepEqual(alerts.check([taiwan('flood')], NOW), []);
});

test('alerts persist, survive bad storage and refuse what they cannot watch', () => {
  const storage = memoryStorage();
  const alerts = createRiverAlerts({ storage, limit: 2 });
  alerts.set(taiwan('normal'), 'flood');
  alerts.set(
    { id: KOBLENZ, name: 'Koblenz', band: 'low', refs: { recordLow: 0.5 } },
    'record-low',
  );
  // Over the limit, a level the gauge lacks, a forged id.
  assert.equal(
    alerts.set({ ...taiwan('normal'), id: 'wra:9999X999' }, 'flood'),
    null,
  );
  assert.equal(alerts.set(taiwan('normal'), 'major'), null);
  assert.equal(alerts.set({ ...taiwan('normal'), id: '../x' }, 'flood'), null);

  const reloaded = createRiverAlerts({ storage });
  assert.deepEqual(
    reloaded.list().map(({ id, level, name }) => [id, level, name]),
    [
      ['wra:1140H041', 'flood', 'Huang River'],
      [KOBLENZ, 'record-low', 'Koblenz'],
    ],
  );
  reloaded.set(taiwan('normal'), null);
  reloaded.clear();
  assert.equal(storage.items.has(RIVER_ALERT_STORAGE_KEY), false);

  // Garbage and foreign entries in storage are dropped, not trusted.
  storage.setItem(
    RIVER_ALERT_STORAGE_KEY,
    JSON.stringify({
      'wra:1140H041': { level: 'flood', name: 'Huang River' },
      'javascript:alert(1)': { level: 'flood' },
      [KOBLENZ]: { level: 'everything' },
    }),
  );
  assert.deepEqual(
    createRiverAlerts({ storage })
      .list()
      .map(({ id }) => id),
    ['wra:1140H041'],
  );
  storage.setItem(RIVER_ALERT_STORAGE_KEY, '{not json');
  assert.deepEqual(createRiverAlerts({ storage }).list(), []);
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {},
  };
  const memoryOnly = createRiverAlerts({ storage: throwing });
  assert.deepEqual(memoryOnly.set(taiwan('normal'), 'flood'), {
    reached: false,
  });
  assert.equal(memoryOnly.get('wra:1140H041').level, 'flood');
});

test('system notifications only when the viewer allowed them', async () => {
  const shown = [];
  class Granted {
    static permission = 'granted';
    constructor(title, options) {
      shown.push([title, options.body, options.tag]);
    }
  }
  assert.equal(
    showBrowserAlert(
      { title: 'River alert', body: 'Flood', tag: 't' },
      Granted,
    ),
    true,
  );
  assert.deepEqual(shown, [['River alert', 'Flood', 't']]);
  assert.equal(
    showBrowserAlert({ title: 'x' }, { permission: 'denied' }),
    false,
  );
  assert.equal(showBrowserAlert({ title: 'x' }, undefined), false);
  class Throws {
    static permission = 'granted';
    constructor() {
      throw new TypeError('Illegal constructor');
    }
  }
  assert.equal(showBrowserAlert({ title: 'x' }, Throws), false);

  let asked = 0;
  const ask = {
    permission: 'default',
    requestPermission: async () => {
      asked++;
      return 'granted';
    },
  };
  assert.equal(await requestAlertPermission(ask), 'granted');
  assert.equal(
    await requestAlertPermission({ permission: 'denied' }),
    'denied',
  );
  assert.equal(await requestAlertPermission(undefined), 'unsupported');
  assert.equal(asked, 1);
});
