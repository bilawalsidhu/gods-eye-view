import test from 'node:test';
import assert from 'node:assert/strict';
import { createCyclonesLayer } from './index.js';
import { setLocale, t } from '../../i18n/index.js';

// The exact string the server sends (COVERAGE in server/providers/cyclones.js).
const SERVER_COVERAGE =
  'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.';
const time = '2026-09-16T03:00:00.000Z';
const storm = {
  id: 'ep152026',
  name: 'Fifteen-E',
  classification: 'PTC',
  basin: 'EP',
  position: { longitude: -125.8, latitude: 15.5 },
  positionAt: time,
  issuedAt: time,
  advisoryNumber: '10',
  windKt: 25,
  pressureHpa: 1006,
  geometryStatus: 'pending',
  geometryAdvisoryNumber: null,
  forecastPoints: [],
  track: null,
  cone: null,
  advisoryUrl: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
};
const snapshot = (storms, extra = {}) => ({
  schemaVersion: 1,
  storms,
  unavailable: false,
  stale: false,
  fetchedAt: Date.parse(time),
  coverage: SERVER_COVERAGE,
  reason: null,
  ...extra,
});
function harness(feed) {
  const rendering = {
    async setSnapshot() {
      return true;
    },
    setSelection() {},
    getFocusSphere: () => ({ radius: 500000 }),
    clear() {},
    destroy() {},
    getDiagnostics: () => ({ entities: 0, timerActive: false }),
  };
  const layer = createCyclonesLayer({
    feed,
    createRendering: () => rendering,
    matchMedia: () => ({ matches: false }),
    openLink: () => {},
  });
  layer.init({ camera: { flyToBoundingSphere() {} } });
  layer.attachShellServices({ runNavigation: (fn) => fn() });
  return layer;
}

const translated = () => t(SERVER_COVERAGE);

test('es: server snapshot without storms -> coverage line in Spanish', async () => {
  setLocale('es');
  try {
    assert.notEqual(translated(), SERVER_COVERAGE, 'es.json has a translation');
    const layer = harness({ getSnapshot: async () => snapshot([]) });
    layer.enable();
    await layer.update();
    const info = layer.getRowControls().info;
    assert.ok(
      info.endsWith(translated()),
      `expected Spanish coverage, got:\n${info}`,
    );
    layer.destroy();
  } finally {
    setLocale('en');
  }
});

test('es: server snapshot with a storm -> coverage line in Spanish', async () => {
  setLocale('es');
  try {
    const layer = harness({ getSnapshot: async () => snapshot([storm]) });
    layer.enable();
    await layer.update();
    const info = layer.getRowControls().info;
    assert.ok(
      info.endsWith(translated()),
      `expected Spanish coverage, got:\n${info}`,
    );
    layer.destroy();
  } finally {
    setLocale('en');
  }
});

test('es: unavailable without reason -> fallback status not the English literal', async () => {
  setLocale('es');
  try {
    const layer = harness({
      getSnapshot: async () =>
        snapshot([], { unavailable: true, reason: null }),
    });
    layer.enable();
    await layer.update();
    const status = layer.getRowControls().summary.status;
    assert.notEqual(
      status,
      'Cyclone advisories unavailable',
      `fallback shown in English: ${status}`,
    );
    layer.destroy();
  } finally {
    setLocale('en');
  }
});

test('en: coverage and fallback status read as before', async () => {
  const layer = harness({ getSnapshot: async () => snapshot([]) });
  layer.enable();
  await layer.update();
  assert.ok(layer.getRowControls().info.endsWith(SERVER_COVERAGE));
  layer.destroy();
  const down = harness({
    getSnapshot: async () => snapshot([], { unavailable: true, reason: null }),
  });
  down.enable();
  await down.update();
  assert.equal(
    down.getRowControls().summary.status,
    'Cyclone advisories unavailable',
  );
  down.destroy();
});
