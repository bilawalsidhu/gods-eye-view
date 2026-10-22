import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  TELEMETRY_COLORS,
  calculateBarometerAltitude,
  createFloorLevelBadgeSvg,
  createFallAlertBadgeSvg,
  createSensorPinSvg,
  SafeSpotTelemetryVisualizer,
} from './telemetry.js';

test('Barometer 3D floor elevation formula', () => {
  // Ground level (floors = 0)
  assert.equal(calculateBarometerAltitude(0, 0), 1.2);

  // Level 3 floors above ground (HDB standard: 3 * 2.8 + 1.2 = 9.6m)
  assert.equal(calculateBarometerAltitude(3, 0), 9.6);

  // Level 4 floors above ground (HDB standard: 4 * 2.8 + 1.2 = 12.4m)
  assert.equal(calculateBarometerAltitude(4, 0), 12.4);

  // With terrain altitude offset
  assert.equal(calculateBarometerAltitude(4, 15.0), 27.4);

  // Graceful fallback on invalid/negative inputs
  assert.equal(calculateBarometerAltitude(-1, 0), 1.2);
  assert.equal(calculateBarometerAltitude(null, 0), 1.2);
});

test('SVG Floor level billboard badge generator', () => {
  const badgeSvg = createFloorLevelBadgeSvg(3, 9.6, 76, 84);
  assert.ok(badgeSvg.startsWith('data:image/svg+xml;charset=utf-8,'));
  const decoded = decodeURIComponent(badgeSvg);

  assert.ok(decoded.includes('LEVEL 4'), 'Floors 3 above ground is Level 4');
  assert.ok(decoded.includes('+9.6m'), 'Should display elevation in meters');
  assert.ok(decoded.includes('76 bpm'), 'Should display heart rate');
  assert.ok(decoded.includes('84%'), 'Should display battery percentage');
  assert.ok(decoded.includes('fēnix 6'), 'Should label Garmin device');
});

test('SVG Fall alert billboard badge generator', () => {
  const alertSvg = createFallAlertBadgeSvg(3);
  assert.ok(alertSvg.startsWith('data:image/svg+xml;charset=utf-8,'));
  const decoded = decodeURIComponent(alertSvg);

  assert.ok(decoded.includes('FALL DETECTED'), 'Must prominently announce fall alert');
  assert.ok(decoded.includes('Level 4'), 'Must identify floor level');
  assert.ok(decoded.includes('#ef4444') || decoded.includes('#991b1b'), 'Must use emergency red color');
});

test('SVG Sensor pin markers for Watch, Phone, and BLE Beacon', () => {
  const watchPin = createSensorPinSvg('watch');
  assert.ok(decodeURIComponent(watchPin).includes(TELEMETRY_COLORS.WATCH_GNSS));

  const phonePin = createSensorPinSvg('phone');
  assert.ok(decodeURIComponent(phonePin).includes(TELEMETRY_COLORS.PHONE_GPS));

  const beaconPin = createSensorPinSvg('beacon');
  assert.ok(decodeURIComponent(beaconPin).includes(TELEMETRY_COLORS.BLE_BEACON));
});

test('SafeSpotTelemetryVisualizer multi-source fusion and 3D floor stalk', () => {
  const addedDataSources = [];
  const removedDataSources = [];

  const mockViewer = {
    isDestroyed: () => false,
    dataSources: {
      add: (ds) => { addedDataSources.push(ds); return ds; },
      remove: (ds) => { removedDataSources.push(ds); return true; },
      contains: (ds) => addedDataSources.includes(ds),
    },
    scene: {
      requestRender: () => {},
      camera: { flyToBoundingSphere: () => {} },
      globe: {
        getHeight: () => 5.0, // Mock terrain altitude
      },
    },
  };

  const visualizer = new SafeSpotTelemetryVisualizer(mockViewer);
  visualizer.attach();
  assert.equal(visualizer._attached, true);
  assert.equal(addedDataSources.length, 1);

  // Mock telemetry tick
  const mockTick = {
    type: 'telemetry:tick',
    timestamp: 1729497600,
    deviceId: 'fenix-6-solar-demo',
    battery: 84,
    heartRate: 76,
    fusedLocation: {
      lat: 1.33271,
      lng: 103.84792,
      accuracy: 3.0,
      floorsAbove: 4,
    },
    sensorStreams: {
      watchGnss: { lat: 1.33275, lng: 103.84795, accuracy: 12 },
      phoneGps: { lat: 1.33280, lng: 103.84805, accuracy: 25 },
      bleBeacons: [
        { lat: 1.33271, lng: 103.84792, estimatedDistanceMeters: 2.4 },
      ],
      barometer: { floorsAbove: 4, estimatedHeightMeters: 11.2 },
    },
  };

  visualizer.updateTelemetry(mockTick);

  const entities = visualizer._dataSource.entities.values;
  assert.ok(entities.length >= 7, 'Must populate all fusion components');

  // 1. Watch GNSS draped ellipse
  const watchEnvelope = entities.find((e) => e.id === 'safespot:telemetry:watch-envelope');
  assert.ok(watchEnvelope, 'Watch GNSS ellipse must exist');
  assert.equal(watchEnvelope.ellipse.semiMajorAxis.getValue(), 12);
  assert.equal(watchEnvelope.ellipse.classificationType.getValue(), Cesium.ClassificationType.BOTH);

  // 2. Phone GPS draped ellipse
  const phoneEnvelope = entities.find((e) => e.id === 'safespot:telemetry:phone-envelope');
  assert.ok(phoneEnvelope, 'Phone GPS ellipse must exist');
  assert.equal(phoneEnvelope.ellipse.semiMajorAxis.getValue(), 25);
  assert.equal(phoneEnvelope.ellipse.classificationType.getValue(), Cesium.ClassificationType.BOTH);

  // 3. BLE Beacon micro-location envelope (<5m)
  const beaconEnvelope = entities.find((e) => e.id === 'safespot:telemetry:beacon-drape');
  assert.ok(beaconEnvelope, 'BLE Beacon envelope must exist');
  assert.ok(beaconEnvelope.ellipse.semiMajorAxis.getValue() < 5.0, 'BLE envelope radius must be < 5m');
  assert.equal(beaconEnvelope.ellipse.classificationType.getValue(), Cesium.ClassificationType.BOTH);

  // 4. Barometer 3D altitude stalk polyline
  const stalkPolyline = entities.find((e) => e.id === 'safespot:telemetry:barometer-stalk');
  assert.ok(stalkPolyline, 'Barometer stalk polyline must exist');
  const stalkPositions = stalkPolyline.polyline.positions.getValue();
  assert.equal(stalkPositions.length, 2, 'Stalk must have ground and top positions');
  assert.equal(stalkPolyline.polyline.width.getValue(), 4);

  // 5. Floor marker billboard at elevation Z
  const floorMarker = entities.find((e) => e.id === 'safespot:telemetry:floor-marker');
  assert.ok(floorMarker, 'Floor marker entity must exist');
  assert.equal(
    floorMarker.billboard.disableDepthTestDistance.getValue(),
    Number.POSITIVE_INFINITY,
    'Must disable depth test distance for crisp 3D tile visibility',
  );

  // 6. Ground footprint anchor point
  const groundAnchor = entities.find((e) => e.id === 'safespot:telemetry:ground-anchor');
  assert.ok(groundAnchor, 'Ground footprint anchor entity must exist');

  // 7. Fall alert trigger and clear
  visualizer.triggerFallAlert({ eventType: 'FALL_DETECTED', floorsAbove: 4 });
  const alertEntity = visualizer._dataSource.entities.values.find(
    (e) => e.id === 'safespot:telemetry:fall-alert',
  );
  assert.ok(alertEntity, 'Critical fall alert billboard must appear when alert is triggered');
  assert.equal(alertEntity.billboard.disableDepthTestDistance.getValue(), Number.POSITIVE_INFINITY);

  visualizer.clearAlert();
  const alertAfterClear = visualizer._dataSource.entities.values.find(
    (e) => e.id === 'safespot:telemetry:fall-alert',
  );
  assert.equal(alertAfterClear, undefined, 'Fall alert entity must be cleared');

  // Teardown
  visualizer.destroy();
  assert.equal(removedDataSources.length, 1);
});
