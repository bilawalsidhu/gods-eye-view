import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  aqiColor,
  createAirQualityOverlayEntry,
  selectAirQualityOverlayCohort,
  mapAnalystRecord,
} from './model.js';
import { createAirQualitySource } from './source.js';
import { createAirQualityLayer } from './index.js';

test('aqiColor returns standard EPA color bands', () => {
  assert.equal(aqiColor(25).toCssColorString(), 'rgb(0,255,136)');
  assert.equal(aqiColor(75).toCssColorString(), 'rgb(255,221,0)');
  assert.equal(aqiColor(125).toCssColorString(), 'rgb(255,149,0)');
  assert.equal(aqiColor(175).toCssColorString(), 'rgb(255,59,48)');
  assert.equal(aqiColor(250).toCssColorString(), 'rgb(175,82,222)');
  assert.equal(aqiColor(350).toCssColorString(), 'rgb(126,0,35)');
});

test('createAirQualityOverlayEntry builds prioritized overlay labels', () => {
  const pos = Cesium.Cartesian3.fromDegrees(10, 20);
  const entry = createAirQualityOverlayEntry({
    id: 'station-1',
    position: pos,
    name: 'Houston Ship Channel',
    aqi: 142,
    pollutant: 'PM2.5',
    accent: '#ff9500',
  });

  assert.equal(entry.id, 'station-1');
  assert.equal(entry.title, 'AQI 142');
  assert.equal(entry.subtitle, 'PM2.5');
  assert.equal(entry.accent, '#ff9500');
  assert.equal(entry.priority, 14200);
  assert.equal(entry.variant, 'label');
});

test('selectAirQualityOverlayCohort keeps highest AQI stations within cohort limit', () => {
  const entries = [
    { id: 'a', priority: 5000 },
    { id: 'b', priority: 18000 },
    { id: 'c', priority: 12000 },
  ];
  const sorted = selectAirQualityOverlayCohort(entries, 2);
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0].id, 'b');
  assert.equal(sorted[1].id, 'c');
});

test('mapAnalystRecord converts raw observation into JSON-safe analyst format', () => {
  const record = mapAnalystRecord({
    id: 'h1',
    name: 'Rotterdam Port',
    city: 'Rotterdam',
    country: 'NL',
    industrialType: 'Petrochemical',
    lat: 51.921234,
    lon: 4.481234,
    aqi: 55,
    category: 'Moderate',
    primaryPollutant: 'NO₂',
    pm25: 12.34,
    pm10: 22.1,
    no2: 35.6,
    so2: 4.2,
    time: '2026-10-13T00:00:00Z',
  });

  assert.equal(record.id, 'h1');
  assert.equal(record.name, 'Rotterdam Port');
  assert.equal(record.lat, 51.92123);
  assert.equal(record.lon, 4.48123);
  assert.equal(record.aqi, 55);
  assert.equal(record.category, 'Moderate');
  assert.equal(record.primaryPollutant, 'NO₂');
  assert.equal(record.pm25, 12.3);

  // Null-safe fallback
  const empty = mapAnalystRecord(null, 5);
  assert.equal(empty.id, 'station-5');
  assert.equal(empty.name, 'Unknown Station');
  assert.equal(empty.lat, null);
});

test('createAirQualitySource filters out invalid coordinates and maps snapshot rows', async () => {
  const mockStations = [
    { id: 's1', name: 'Valid Hub', lat: 29.7, lon: -95.3, aqi: 62 },
    { id: 's2', name: 'Invalid Hub', lat: 999, lon: -95.3, aqi: 120 },
  ];
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ stations: mockStations }),
  });

  const source = createAirQualitySource({ fetchImpl });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].stableId, 's1');
  assert.equal(snapshot[0].name, 'Valid Hub');
  assert.equal(snapshot[0].aqi, 62);
});

test('createAirQualityLayer manages dataSource lifecycle and analyst records', async () => {
  const overlayCalls = [];
  const overlayHost = {
    setEntries: (id, entries) => overlayCalls.push(['setEntries', id, entries.length]),
    setVisible: (id, visible) => overlayCalls.push(['setVisible', id, visible]),
    clearSource: (id) => overlayCalls.push(['clearSource', id]),
  };

  const mockSnapshot = [
    {
      stableId: 'hub-1',
      name: 'Texas Petrochemical',
      city: 'Houston',
      country: 'US',
      industrialType: 'Refinery',
      lat: 29.7,
      lon: -95.3,
      aqi: 145,
      category: 'Unhealthy for Sensitive Groups',
      primaryPollutant: 'PM2.5',
      pm25: 45.2,
      pm10: 60.1,
      no2: 25.0,
      so2: 5.0,
      timestamp: '2026-10-13T00:00:00Z',
    },
  ];

  const source = {
    getSnapshot: async () => mockSnapshot,
  };

  const layer = createAirQualityLayer({ source, overlayHost });
  assert.equal(layer.id, 'air-quality');

  const viewer = {
    dataSources: {
      add: (ds) => { viewer.ds = ds; },
      remove: () => { viewer.ds = null; },
    },
  };

  layer.init(viewer);
  assert.ok(viewer.ds);
  assert.equal(viewer.ds.show, false);

  layer.enable(viewer);
  assert.equal(viewer.ds.show, true);

  const updated = await layer.update(viewer);
  assert.equal(updated, true);
  assert.equal(viewer.ds.entities.values.length, 1);

  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.ok(stats.lastUpdate != null);

  const analystRecords = layer.getAnalystRecords();
  assert.equal(analystRecords.length, 1);
  assert.equal(analystRecords[0].name, 'Texas Petrochemical');
  assert.equal(analystRecords[0].aqi, 145);

  layer.disable(viewer);
  assert.equal(viewer.ds.show, false);

  layer.destroy(viewer);
  assert.equal(viewer.ds, null);
});
