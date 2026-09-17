import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeofenceAlert, formatBreachMessage } from './geofenceAlert.js';
import { createGeofenceMonitor } from './geofenceMonitor.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('visual alert: formatBreachMessage includes id', () => {
  assert.equal(formatBreachMessage({ id: 'A123' }), 'GEOFENCE BREACH — A123');
  assert.equal(formatBreachMessage({ entityId: 'X' }), 'GEOFENCE BREACH — X');
});

test('visual alert: show/hide toggles visible class', () => {
  // minimal DOM stub
  const classList = new Set();
  const alertEl = {
    classList: {
      add: (c) => classList.add(c),
      remove: (c) => classList.delete(c),
      contains: (c) => classList.has(c),
    },
    hidden: true,
    offsetWidth: 0,
  };
  const textEl = { textContent: '' };
  const alert = createGeofenceAlert({ alertEl, textEl, autoHideMs: 0 });
  alert.show('BREACH — TEST');
  assert.equal(textEl.textContent, 'BREACH — TEST');
  assert.ok(classList.has('visible'));
  assert.equal(alert.isVisible(), true);
  alert.hide();
  assert.ok(!classList.has('visible'));
  alert.destroy();
});

test('test toggle: sendTestPayload dispatches mock payload', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => null,
    dataManager: {
      layers: new Map(),
      subscribeActivity: () => () => {},
      subscribe: () => () => {},
    },
    fetchImpl: fakeFetch,
    now: () => '2026-01-03T00:00:00.000Z',
  });
  monitor.setWebhookUrl('https://example.com/hook');
  await monitor.sendTestPayload();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/hook');
  assert.equal(calls[0].body.entityId, 'TEST-123');
  assert.equal(calls[0].body.test, true);
  assert.equal(calls[0].body.timestamp, '2026-01-03T00:00:00.000Z');
  monitor.destroy();
});

test('test toggle: sendTestPayload requires URL', async () => {
  const monitor = createGeofenceMonitor({
    getPolygon: () => null,
    dataManager: {
      layers: new Map(),
      subscribeActivity: () => () => {},
      subscribe: () => () => {},
    },
    fetchImpl: async () => ({ ok: true }),
  });
  await assert.rejects(() => monitor.sendTestPayload(), /not configured/);
  monitor.destroy();
});

test('markup: geofence alert and test toggle ids exist', () => {
  const chrome = read('src/ui/templates/scene-chrome.html');
  const controls = read('src/ui/templates/display-controls.html');
  for (const id of [
    'geofence-alert',
    'geofence-alert-text',
    'geofence-alert-dismiss',
  ]) {
    assert.match(
      chrome,
      new RegExp(`id="${id}"`),
      `${id} missing in scene-chrome`,
    );
  }
  for (const id of [
    'geofence-test-webhook',
    'geofence-test-hint',
    'geofence-test-row',
  ]) {
    assert.match(
      controls,
      new RegExp(`id="${id}"`),
      `${id} missing in display-controls`,
    );
  }
});

test('monitor: visual alert integration via onEnter', () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  let records = [{ icao24: 'B1', lat: 5, lon: 5 }];
  const fakeManager = {
    layers: new Map([
      [
        'flights',
        { enabled: true, module: { getAnalystRecords: () => records } },
      ],
    ]),
    subscribeActivity: () => () => {},
    subscribe: () => () => {},
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: fakeManager,
    fetchImpl: async () => ({ ok: true }),
  });
  let shown = null;
  const fakeAlert = {
    show: (msg) => (shown = msg),
    hide: () => (shown = null),
  };
  monitor.onEnter((e) => fakeAlert.show(formatBreachMessage(e)));
  monitor.evaluateAll();
  assert.equal(shown, null);
  records = [{ icao24: 'B1', lat: 0.5, lon: 0.5 }];
  monitor.evaluateAll();
  assert.match(shown, /B1/);
  monitor.destroy();
});
