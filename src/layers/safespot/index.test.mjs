import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSafeSpotLayer,
  SAFESPOT_LAYER_ID,
  SAFESPOT_LAYER_NAME,
  SAFESPOT_LAYER_ICON,
  SAFESPOT_LAYER_SOURCE,
} from './index.js';
import {
  ROUTE_COLORS,
  getSpeedColor,
  getResidualSpeedColor,
  SafeSpotRouteRenderer,
} from './rendering.js';
import {
  SafeSpotFleetSimulator,
  applyCarriagewayOffset,
} from './fleet.js';
import {
  SafeSpotHdMapController,
  HD_MAP_MODES,
} from './hdMap.js';
import {
  DEFAULT_CORRIDOR_ID,
  DEFAULT_ROUTING_MODEL,
  SUPPORTED_ROUTING_MODELS,
  BENCHMARK_CORRIDOR_IDS,
  formatDistance,
  SafeSpotTelemetryClient,
} from '../../data/safespot.js';
import { createSafeSpotFleetEngine } from '../../../server/providers/safespot-fleet-engine.js';

test('SafeSpotSG Evaluation Lab layer metadata and defaults', () => {
  assert.equal(SAFESPOT_LAYER_ID, 'safespot-lab');
  assert.equal(SAFESPOT_LAYER_NAME, 'SafeSpotSG Evaluation Lab');
  assert.equal(SAFESPOT_LAYER_ICON, '🛡️');
  assert.equal(SAFESPOT_LAYER_SOURCE, 'SafeSpotSG · LTA · Garmin');

  const layer = createSafeSpotLayer();
  assert.equal(layer.id, 'safespot-lab');
  assert.equal(layer.icon, '🛡️');
  assert.equal(layer.showInTogglePanel, true);
  assert.equal(layer.updateInterval, 0);

  const params = layer.getParams();
  assert.equal(params.corridorId, DEFAULT_CORRIDOR_ID);
  assert.equal(params.model, DEFAULT_ROUTING_MODEL);
  assert.deepEqual(SUPPORTED_ROUTING_MODELS, ['baseline', 'calibrated', 'speedband']);
  assert.equal(params.showHeatmap, true);
  assert.equal(params.showDivergence, true);
  assert.equal(params.showGoogleReference, true);
  assert.equal(params.showFleetSimulation, true);
  assert.equal(params.hdMapMode, HD_MAP_MODES.RETINA_VOYAGER);
  assert.equal(params.thresholdMeters, 35.0);
});

test('SafeSpotSG layer setParams, 3D Model Arena, Fleet, and HD Map row controls', () => {
  const layer = createSafeSpotLayer();

  // Parameter modification including model switch
  const updated = layer.setParams({
    corridorId: 'toa-payoh-to-raffles-place',
    model: 'speedband',
    showHeatmap: false,
    thresholdMeters: 50.0,
  });
  assert.equal(updated, true);
  const p = layer.getParams();
  assert.equal(p.corridorId, 'toa-payoh-to-raffles-place');
  assert.equal(p.model, 'speedband');
  assert.equal(p.showHeatmap, false);
  assert.equal(p.thresholdMeters, 50.0);

  // Row controls inspection
  const controls = layer.getRowControls();
  assert.ok(Array.isArray(controls.chips), 'Row controls should have chips array');
  assert.equal(controls.chips.length, 16, 'Should provide 16 interactive chips');
  assert.ok(controls.chips.some((c) => c.id === 'safespot-corridor-select'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-model-baseline'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-model-calibrated'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-model-speedband' && c.active === true));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-scorecard-modal'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-toggle-fleet'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-fleet-sweep'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-hd-map'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-toggle-heatmap'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-toggle-divergence'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-toggle-ref'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-toggle-rain'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-trigger-pickup'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-toggle-telemetry'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-trigger-alert'));
  assert.ok(controls.chips.some((c) => c.id === 'safespot-focus-route'));

  assert.ok(typeof controls.info === 'string');
  assert.ok(controls.info.includes('SPEEDBAND'));
  assert.ok(Array.isArray(controls.legend));
  assert.ok(controls.legend.length >= 10);

  // Initial stats
  const stats = layer.getStats();
  assert.equal(stats.activeCorridor, 'toa-payoh-to-raffles-place');
  assert.equal(stats.activeModel, 'speedband');
  assert.equal(stats.telemetryConnected, false);
  assert.equal(stats.isRaining, false);
});

test('Speed and Residual Speed heatmap color calculation rules', () => {
  const highRatio = getSpeedColor(null, 0, 0.85);
  const medRatio = getSpeedColor(null, 0, 0.60);
  const lowRatio = getSpeedColor(null, 0, 0.35);
  assert.ok(highRatio);
  assert.ok(medRatio);
  assert.ok(lowRatio);

  // Residual speed rules (<5 green, 5-15 amber, >15 crimson)
  const goodFit = getResidualSpeedColor(3.2);
  const modFit = getResidualSpeedColor(9.5);
  const highBias = getResidualSpeedColor(18.4);
  assert.ok(goodFit);
  assert.ok(modFit);
  assert.ok(highBias);
  assert.notDeepEqual(goodFit, highBias);
});

test('Carriageway directionality offset and Autonomous Fleet Simulation to 100% SG coverage', () => {
  // 1-way carriageway keeps exact centerline
  const oneWayPos = applyCarriagewayOffset(1.3204, 103.8438, 90, true);
  assert.equal(oneWayPos.lat, 1.3204);
  assert.equal(oneWayPos.lng, 103.8438);

  // 2-way carriageway applies left-hand traffic offset so opposing directions separate
  const twoWayEast = applyCarriagewayOffset(1.3204, 103.8438, 90, false);
  const twoWayWest = applyCarriagewayOffset(1.3204, 103.8438, 270, false);
  assert.notEqual(twoWayEast.lat, twoWayWest.lat);

  // Backend fleet engine: the server owns the clock and coverage is earned by
  // driving. Use the fallback ring graph with an injected clock for determinism.
  const T0 = 5_000_000;
  const engine = createSafeSpotFleetEngine({ graphPath: null, now: () => T0 });
  const step1 = engine.stepCoverage({ model: 'calibrated', speedMultiplier: 250, nowMs: T0 });
  assert.equal(step1.model, 'calibrated');
  assert.equal(step1.vehicles.length, 50);
  assert.equal(step1.coverage.activeCars, 36);
  assert.equal(step1.coverage.activeBuses, 14);
  assert.equal(step1.coverage.coveredEdges, 0, 'no simulated time has passed yet');
  assert.ok(step1.vehicles.some((v) => v.id.startsWith('CAR-')));
  assert.ok(step1.vehicles.some((v) => v.id.startsWith('BUS-')));
  assert.ok(step1.vehicles.every((v) => v.waypoints.length > 0 && typeof v.progressSec === 'number'));

  // The old instant sweep is gone: these parameters change nothing.
  const noSweep = engine.stepCoverage({ model: 'speedband', sweepTo100: true, nowMs: T0 });
  assert.equal(noSweep.coverage.coveredEdges, 0);

  // Only simulated time covers edges; the fleet reaches 100% by driving the ring.
  let now = T0;
  let state = noSweep;
  for (let i = 0; i < 400 && !state.coverage.isComplete; i++) {
    now += 15_000;
    state = engine.stepCoverage({ model: 'speedband', nowMs: now });
  }
  assert.equal(state.coverage.coveragePct, 100);
  assert.equal(state.coverage.isComplete, true);
  assert.equal(state.coverage.coveredEdges, state.coverage.totalDrivableEdges);
  assert.ok(state.coverage.fleetDistanceKm > 0);

  // Reset returns to an uncovered network with a fresh clock.
  const afterReset = engine.resetCoverage({ nowMs: now });
  assert.equal(afterReset.coverage.coveredEdges, 0);
  assert.equal(afterReset.simSeconds, 0);
  assert.ok(afterReset.coverage.coveragePct < 100);
});

test('SafeSpotFleetSimulator getDetectableObjects and strict noCesiumLabels compliance', () => {
  const addedDataSources = [];
  const mockViewer = {
    isDestroyed: () => false,
    dataSources: {
      add: (ds) => {
        addedDataSources.push(ds);
        return ds;
      },
      remove: () => true,
      contains: (ds) => addedDataSources.includes(ds),
    },
    scene: {
      requestRender: () => {},
    },
  };

  const sim = new SafeSpotFleetSimulator(mockViewer);
  sim.setRunning(false); // Manual step in unit test
  sim.attach();

  const engine = createSafeSpotFleetEngine({ graphPath: null, now: () => 1_000 });
  const payload = engine.stepCoverage({ model: 'calibrated', nowMs: 1_000 });
  sim.ingestFleetState(payload);
  sim.stepAnimation(0.1);

  const contacts = sim.getDetectableObjects({ maxCount: 20, seed: 0 });
  assert.equal(contacts.length, 20);
  assert.ok(contacts.some((c) => c.id.startsWith('CAR-') && c.type === 'VEH'));
  assert.ok(contacts.some((c) => c.id.startsWith('BUS-') && c.type === 'VEH'));

  // Enforce strict noCesiumLabels invariant on all fleet & track entities
  for (const entity of sim._dataSource.entities.values) {
    assert.equal(entity.label, undefined, `Entity ${entity.id} must not use Cesium LabelGraphics`);
  }

  sim.destroy();
});

test('SafeSpotHdMapController mode cycling and resolution scaling', () => {
  const mockViewer = {
    resolutionScale: 1.0,
    isDestroyed: () => false,
    scene: {
      globe: { maximumScreenSpaceError: 2.0 },
      requestRender: () => {},
    },
  };

  const hdMap = new SafeSpotHdMapController(mockViewer);
  hdMap.attach(HD_MAP_MODES.RETINA_VOYAGER);
  assert.ok(mockViewer.resolutionScale >= 1.5);
  assert.equal(mockViewer.scene.globe.maximumScreenSpaceError, 1.0);

  assert.equal(hdMap.cycleMode(), HD_MAP_MODES.ONEMAP_SG);
  assert.equal(hdMap.cycleMode(), HD_MAP_MODES.RETINA_DARK);
  assert.equal(hdMap.cycleMode(), HD_MAP_MODES.BASE);
  assert.equal(hdMap.cycleMode(), HD_MAP_MODES.RETINA_VOYAGER);

  hdMap.detach();
  assert.equal(mockViewer.resolutionScale, 1.0);
  assert.equal(mockViewer.scene.globe.maximumScreenSpaceError, 2.0);
  hdMap.destroy();
});

test('Distance formatting and benchmark corridors', () => {
  assert.equal(formatDistance(25), '25 m');
  assert.equal(formatDistance(950), '950 m');
  assert.equal(formatDistance(1200), '1.2 km');
  assert.equal(formatDistance(2166), '2.2 km');

  assert.ok(BENCHMARK_CORRIDOR_IDS.includes('novena-to-mbs'));
  assert.ok(BENCHMARK_CORRIDOR_IDS.includes('toa-payoh-to-raffles-place'));
  assert.ok(BENCHMARK_CORRIDOR_IDS.includes('ang-mo-kio-to-punggol'));
});

test('SafeSpotTelemetryClient event handling and simulation commands', () => {
  const client = new SafeSpotTelemetryClient({ autoReconnect: false });
  assert.equal(client.isConnected, false);

  let tickFired = false;
  let alertFired = false;
  client.on('tick', () => {
    tickFired = true;
  });
  client.on('alert', () => {
    alertFired = true;
  });

  client.emit('tick', { deviceId: 'test-watch', floorsAbove: 3 });
  client.emit('alert', { severity: 'critical', type: 'fall_detected' });

  assert.equal(tickFired, true);
  assert.equal(alertFired, true);

  client.destroy();
});

test('Layer lifecycle with mock Cesium Viewer', async () => {
  const addedDataSources = [];
  const removedDataSources = [];

  const mockViewer = {
    isDestroyed: () => false,
    dataSources: {
      add: async (ds) => {
        addedDataSources.push(ds);
        return ds;
      },
      remove: (ds) => {
        removedDataSources.push(ds);
        return true;
      },
      contains: (ds) => addedDataSources.includes(ds),
    },
    scene: {
      camera: {
        flyToBoundingSphere: () => {},
      },
    },
  };

  const layer = createSafeSpotLayer();

  // init
  const inited = await layer.init(mockViewer);
  assert.equal(inited, true);

  // enable
  const enabled = await layer.enable(mockViewer);
  assert.equal(enabled, true);
  assert.equal(
    addedDataSources.length,
    4,
    'All 4 data sources (route, pickup, telemetry, autonomous fleet) should be added on enable'
  );
  for (const ds of addedDataSources) {
    assert.equal(ds.show, true);
  }

  // disable
  const disabled = await layer.disable(mockViewer);
  assert.equal(disabled, true);
  for (const ds of addedDataSources) {
    assert.equal(ds.show, false);
  }

  // destroy
  const destroyed = await layer.destroy(mockViewer);
  assert.equal(destroyed, true);
  assert.equal(
    removedDataSources.length,
    4,
    'All 4 data sources should be removed from viewer on destroy'
  );
});
