import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusColor,
  typeIcon,
  typeLabel,
  createTelemetryOverlayEntry,
  selectTelemetryOverlayCohort,
  mapAnalystRecord,
} from './model.js';
import { createLocalTelemetrySource } from './source.js';
import { createLocalTelemetryLayer } from './index.js';

test('statusColor returns cyber colors for machine operational states', () => {
  assert.equal(statusColor('nominal'), '#00ff88');
  assert.equal(statusColor('idle'), '#00d2ff');
  assert.equal(statusColor('warning'), '#ff9500');
  assert.equal(statusColor('fault'), '#ff3b30');
  assert.equal(statusColor('unknown'), '#8e8e93');
});

test('typeIcon and typeLabel map industrial device categories', () => {
  assert.equal(typeIcon('agv'), '🚜');
  assert.equal(typeIcon('robot'), '🤖');
  assert.equal(typeIcon('drone'), '🛸');
  assert.equal(typeIcon('pump'), '⚙');
  assert.equal(typeIcon('sensor'), '📡');
  assert.equal(typeLabel('agv'), 'Automated Guided Vehicle');
  assert.equal(typeLabel('drone'), 'Autonomous Inspection UAV');
});

test('createTelemetryOverlayEntry builds prioritized overlay entries', () => {
  const entry = createTelemetryOverlayEntry({
    id: 'agv-01',
    name: 'Giga AGV Alpha',
    facility: 'Tesla Giga Texas',
    lat: 30.222,
    lon: -97.617,
    alt: 140,
    status: 'nominal',
    type: 'agv',
    battery: 92,
  });

  assert.equal(entry.id, 'overlay:telemetry:agv-01');
  assert.equal(entry.entityId, 'local-telemetry:agv-01');
  assert.equal(entry.primaryText, '🚜 Giga AGV Alpha [92%]');
  assert.equal(entry.secondaryText, 'NOMINAL · Tesla Giga Texas');
  assert.equal(entry.badgeColor, '#00ff88');
  assert.equal(entry.priority, 50);
});

test('selectTelemetryOverlayCohort prioritizes faults and warnings', () => {
  const devices = [
    { id: 'dev-1', status: 'nominal' },
    { id: 'dev-2', status: 'fault' },
    { id: 'dev-3', status: 'warning' },
  ];
  const sorted = selectTelemetryOverlayCohort(devices, 2);
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0].id, 'dev-2'); // fault first
  assert.equal(sorted[1].id, 'dev-3'); // warning second
});

test('mapAnalystRecord converts machine telemetry to analyst card format', () => {
  const record = mapAnalystRecord({
    id: 'pump-01',
    name: 'Chiller Pump 3',
    facility: 'Austin Fab',
    type: 'pump',
    status: 'nominal',
    battery: 100,
    speed: 0,
    heading: 0,
    lat: 30.225,
    lon: -97.615,
    alt: 140,
    metrics: {
      flow_rate_gpm: 1250,
      pressure_psi: 82.4,
    },
  });

  assert.equal(record.id, 'local-telemetry:pump-01');
  assert.equal(record.layerId, 'local-telemetry');
  assert.equal(record.badge.text, 'NOMINAL');
  assert.equal(record.badge.color, '#00ff88');
  assert.ok(record.sections[1].content.includes('flow rate gpm: 1250'));
  assert.ok(record.sections[1].content.includes('pressure psi: 82.4'));
});

test('createLocalTelemetrySource filters invalid coordinates and parses snapshots', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      source: 'IIoT Feed',
      devices: [
        {
          id: 'agv-1',
          name: 'AGV #1',
          type: 'agv',
          lat: 30.22,
          lon: -97.61,
          status: 'nominal',
        },
        {
          id: 'bad-coord',
          lat: 999.0,
          lon: -97.61,
        },
      ],
    }),
  });

  const source = createLocalTelemetrySource({ fetchImpl: mockFetch });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].id, 'agv-1');
  assert.equal(snapshot[0].name, 'AGV #1');
  assert.equal(snapshot[0].type, 'agv');
});

test('createLocalTelemetryLayer manages dataSource lifecycle and stats', async () => {
  const mockOverlayHost = {
    setVisible() {},
    clearSource() {},
    setEntries() {},
  };
  const mockSource = {
    async getSnapshot() {
      return [
        {
          id: 'drone-01',
          name: 'Survey Drone',
          type: 'drone',
          lat: 51.95,
          lon: 4.02,
          alt: 65,
          status: 'nominal',
          battery: 78,
          speed: 12.0,
        },
      ];
    },
  };

  const layer = createLocalTelemetryLayer({
    source: mockSource,
    overlayHost: mockOverlayHost,
  });

  const added = [];
  const mockViewer = {
    dataSources: {
      add(ds) {
        added.push(ds);
      },
      remove(ds) {
        const idx = added.indexOf(ds);
        if (idx !== -1) added.splice(idx, 1);
      },
    },
  };

  layer.init(mockViewer);
  assert.equal(added.length, 1);
  assert.equal(layer.getStats().enabled, false);

  layer.enable(mockViewer);
  assert.equal(layer.getStats().enabled, true);

  const updated = await layer.update(mockViewer);
  assert.equal(updated, true);
  assert.equal(layer.getStats().count, 1);

  const records = layer.getAnalystRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'local-telemetry:drone-01');

  layer.disable(mockViewer);
  assert.equal(layer.getStats().enabled, false);

  layer.destroy(mockViewer);
  assert.equal(added.length, 0);
});
