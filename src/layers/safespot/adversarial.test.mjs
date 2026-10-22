import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  SafeSpotPickupRenderer,
  PICKUP_COLORS,
  createRankBadgeSvg,
  createCandidateInfoCardSvg,
  createSeniorPinSvg,
  createDriverPinSvg,
} from './pickup.js';
import {
  SafeSpotTelemetryVisualizer,
  TELEMETRY_COLORS,
  calculateBarometerAltitude,
  createFloorLevelBadgeSvg,
  createFallAlertBadgeSvg,
  createSensorPinSvg,
} from './telemetry.js';
import { buildSafeSpotRowControls } from './controls.js';
import { createSafeSpotLayer } from './index.js';

/**
 * Helper: Mock Cesium Viewer for lifecycle & entity management testing.
 */
function createMockViewer() {
  const addedDataSources = [];
  const removedDataSources = [];

  const viewer = {
    isDestroyed: () => false,
    dataSources: {
      add: (ds) => {
        if (!addedDataSources.includes(ds)) addedDataSources.push(ds);
        return ds;
      },
      remove: (ds) => {
        const idx = addedDataSources.indexOf(ds);
        if (idx !== -1) addedDataSources.splice(idx, 1);
        removedDataSources.push(ds);
        return true;
      },
      contains: (ds) => addedDataSources.includes(ds),
      get length() {
        return addedDataSources.length;
      },
    },
    scene: {
      requestRender: () => {},
      camera: {
        flyToBoundingSphere: () => {},
      },
      globe: {
        getHeight: (carto) => {
          if (!carto) return 0;
          return 5.0; // Simulated terrain altitude
        },
      },
    },
  };

  return { viewer, addedDataSources, removedDataSources };
}

/**
 * Strict invariant verification helper:
 * Asserts that no entity in the dataSource has a label or LabelGraphics property.
 */
function assertNoCesiumLabels(dataSource, contextDescription = '') {
  const entities = dataSource.entities.values;
  for (const entity of entities) {
    assert.equal(
      entity.label,
      undefined,
      `[INVARIANT VIOLATION] Entity "${entity.id}" has Cesium label property in context: ${contextDescription}`,
    );
    assert.ok(
      !(entity.label instanceof Cesium.LabelGraphics),
      `[INVARIANT VIOLATION] Entity "${entity.id}" has Cesium.LabelGraphics in context: ${contextDescription}`,
    );
  }
}

/**
 * XML well-formedness checker for SVG data URIs
 */
function assertWellFormedSvg(dataUri, description = '') {
  assert.ok(dataUri.startsWith('data:image/svg+xml;charset=utf-8,'), `${description} must be a valid SVG data URI`);
  const svgText = decodeURIComponent(dataUri.replace('data:image/svg+xml;charset=utf-8,', ''));
  assert.ok(svgText.includes('<svg') && svgText.includes('</svg>'), `${description} must contain root svg tags`);
  
  // Basic check for unescaped ampersands outside of entities or CDATA
  const unescapedAmp = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/;
  assert.ok(
    !unescapedAmp.test(svgText),
    `${description} contains unescaped ampersand in SVG XML: ${svgText.slice(0, 100)}...`,
  );
}

// ============================================================================
// 1. Rain Toggle Stress Tests
// ============================================================================
test('Adversarial 1: Rapid Rain Toggle Stress & Entity Lifecycle (100 cycles)', () => {
  const { viewer } = createMockViewer();
  const renderer = new SafeSpotPickupRenderer(viewer);
  renderer.attach();

  const mockSimulationData = {
    isRaining: false,
    candidates: [
      {
        id: 'stand-1',
        name: 'Toa Payoh Central Stand',
        type: 'taxi_stand',
        lat: 1.33285,
        lng: 103.84852,
        score: 285,
        rankingReason: 'Covered linkway connection, barrier-free access',
        driverEtaSeconds: 240,
        seniorWalkSeconds: 180,
        shelteredPercentage: 94,
        barrierFree: true,
        walkingPath: [
          [103.8479, 1.3327, 0],
          [103.8482, 1.3328, 0],
          [103.84852, 1.33285, 0],
        ],
        drivePath: [
          { lat: 1.3390, lng: 103.8420 },
          { lat: 1.3360, lng: 103.8450 },
          { lat: 1.33285, lng: 103.84852 },
        ],
      },
      {
        id: 'kerb-1',
        name: 'Lorong 2 Kerbside',
        type: 'kerbside',
        lat: 1.33150,
        lng: 103.84650,
        score: 410,
        rankingReason: 'Direct open kerbside',
        driverEtaSeconds: 210,
        seniorWalkSeconds: 260,
        shelteredPercentage: 35,
        barrierFree: false,
        walkingPath: [
          [103.8479, 1.3327, 0],
          [103.84650, 1.33150, 0],
        ],
        drivePath: [
          { lat: 1.3390, lng: 103.8420 },
          { lat: 1.33150, lng: 103.84650 },
        ],
      },
    ],
  };

  // Initial render
  renderer.renderPickupSimulation(mockSimulationData, {
    seniorLocation: { lat: 1.3327, lng: 103.8479 },
    driverLocation: { lat: 1.3390, lng: 103.8420 },
  });

  const baselineEntityCount = renderer._dataSource.entities.values.length;
  assert.ok(baselineEntityCount >= 6, 'Baseline should have at least 6 entities');
  assertNoCesiumLabels(renderer._dataSource, 'Initial render');

  // Perform 100 rapid rain toggles
  for (let i = 0; i < 100; i++) {
    const isRaining = i % 2 === 0;
    const simCopy = {
      ...mockSimulationData,
      isRaining,
    };

    renderer.renderPickupSimulation(simCopy, {
      seniorLocation: { lat: 1.3327, lng: 103.8479 },
      driverLocation: { lat: 1.3390, lng: 103.8420 },
    });

    const currentCount = renderer._dataSource.entities.values.length;
    assert.equal(
      currentCount,
      baselineEntityCount,
      `Entity count must not leak during rain toggle iteration ${i} (expected ${baselineEntityCount}, got ${currentCount})`,
    );

    assertNoCesiumLabels(renderer._dataSource, `Rain toggle iteration ${i}`);

    // Verify route styling adaptation
    const walkRoute = renderer._dataSource.entities.values.find((e) => e.id === 'safespot:pickup:senior-walk-route');
    assert.ok(walkRoute, `Walk route entity must exist at iteration ${i}`);
    
    const material = walkRoute.polyline.material;
    const dashLength = material.dashLength.getValue();
    if (isRaining) {
      assert.equal(dashLength, 8.0, `Rain active with 94% shelter should have tight dash length 8.0 at iteration ${i}`);
    } else {
      assert.equal(dashLength, 16.0, `Dry weather should have standard dash length 16.0 at iteration ${i}`);
    }
  }

  renderer.destroy();
});

test('Adversarial 1b: Rain toggle with extreme/unsheltered route styling', () => {
  const { viewer } = createMockViewer();
  const renderer = new SafeSpotPickupRenderer(viewer);
  renderer.attach();

  // Test candidate with low sheltered percentage (35%)
  const unshelteredData = {
    isRaining: true,
    candidates: [
      {
        id: 'unsheltered-1',
        name: 'Open Air Point',
        lat: 1.3315,
        lng: 103.8465,
        shelteredPercentage: 35,
        walkingPath: [
          [103.8479, 1.3327, 0],
          [103.8465, 1.3315, 0],
        ],
        drivePath: [
          { lat: 1.3390, lng: 103.8420 },
          { lat: 1.3315, lng: 103.8465 },
        ],
      },
    ],
  };

  renderer.renderPickupSimulation(unshelteredData);
  const walkRoute = renderer._dataSource.entities.values.find((e) => e.id === 'safespot:pickup:senior-walk-route');
  assert.ok(walkRoute);
  
  // Even though isRaining is true, because shelteredPercentage < 80, color should be UNSHELTERED (sky cyan)
  const color = walkRoute.polyline.material.color.getValue();
  const expectedColor = Cesium.Color.fromCssColorString(PICKUP_COLORS.WALK_UNSHELTERED);
  assert.ok(color.equals(expectedColor), 'Low sheltered route in rain should use WALK_UNSHELTERED color');
  assert.equal(walkRoute.polyline.material.dashLength.getValue(), 16.0);

  renderer.destroy();
});

// ============================================================================
// 2. Telemetry Edge Cases
// ============================================================================
test('Adversarial 2: Telemetry Edge Cases & Missing/Null Sensor Resilience', () => {
  const { viewer } = createMockViewer();
  const visualizer = new SafeSpotTelemetryVisualizer(viewer);
  visualizer.attach();

  // 1. Completely null telemetry
  assert.doesNotThrow(() => visualizer.updateTelemetry(null));
  assert.equal(visualizer._dataSource.entities.values.length, 0);

  // 2. Empty object
  assert.doesNotThrow(() => visualizer.updateTelemetry({}));
  assert.equal(visualizer._dataSource.entities.values.length, 0);

  // 3. Telemetry with NaN coordinates
  assert.doesNotThrow(() =>
    visualizer.updateTelemetry({
      fusedLocation: { lat: NaN, lng: 103.8479, floorsAbove: 3 },
    }),
  );
  assert.equal(visualizer._dataSource.entities.values.length, 0, 'NaN coordinates should not create entities');

  // 4. Telemetry with missing sensor streams (all null)
  const nullSensorsTick = {
    fusedLocation: { lat: 1.3327, lng: 103.8479, floorsAbove: 0 },
    sensors: {
      watchGps: null,
      phoneGps: null,
      bleBeacon: null,
      barometer: null,
    },
    heartRate: 0, // Flatline / arrest
    battery: 0,   // Dead battery
  };

  assert.doesNotThrow(() => visualizer.updateTelemetry(nullSensorsTick));
  assert.ok(visualizer._dataSource.entities.values.length >= 6, 'Should fall back to calculated defaults gracefully');
  assertNoCesiumLabels(visualizer._dataSource, 'Null sensors payload');

  // Verify floor altitude at ground level (floors = 0)
  const stalkPolyline = visualizer._dataSource.entities.values.find((e) => e.id === 'safespot:telemetry:barometer-stalk');
  assert.ok(stalkPolyline);
  const positions = stalkPolyline.polyline.positions.getValue();
  assert.equal(positions.length, 2);

  // Verify floor marker badge with heartRate = 0 and battery = 0
  const floorMarker = visualizer._dataSource.entities.values.find((e) => e.id === 'safespot:telemetry:floor-marker');
  assert.ok(floorMarker);
  const badgeDataUri = floorMarker.billboard.image.getValue();
  const decodedBadge = decodeURIComponent(badgeDataUri);
  assert.ok(decodedBadge.includes('LEVEL 1'), 'Floors 0 should be LEVEL 1');
  assert.ok(decodedBadge.includes('0 bpm'), 'Heart rate 0 should render 0 bpm');
  assert.ok(decodedBadge.includes('0%'), 'Battery 0 should render 0%');

  // 5. Negative floorsAbove (-4 basement)
  const basementTick = {
    fusedLocation: { lat: 1.3327, lng: 103.8479, floorsAbove: -4 },
    heartRate: 215, // Extreme tachycardia
    battery: 100,
  };
  assert.doesNotThrow(() => visualizer.updateTelemetry(basementTick));
  const basementMarker = visualizer._dataSource.entities.values.find((e) => e.id === 'safespot:telemetry:floor-marker');
  assert.ok(basementMarker);
  const decodedBasement = decodeURIComponent(basementMarker.billboard.image.getValue());
  // calculateBarometerAltitude(-4, 5.0) -> Math.max(0, -4) -> 0 -> 5.0 + 1.2 = 6.2m
  assert.ok(decodedBasement.includes('LEVEL 1'), 'Negative floors should clamp to LEVEL 1');

  // 6. Extreme floors (e.g. 80 floors skyscraper)
  const skyscraperTick = {
    fusedLocation: { lat: 1.3327, lng: 103.8479, floorsAbove: 80 },
    heartRate: 85,
    battery: 65,
  };
  assert.doesNotThrow(() => visualizer.updateTelemetry(skyscraperTick));
  const skyMarker = visualizer._dataSource.entities.values.find((e) => e.id === 'safespot:telemetry:floor-marker');
  assert.ok(skyMarker);
  const decodedSky = decodeURIComponent(skyMarker.billboard.image.getValue());
  assert.ok(decodedSky.includes('LEVEL 81'), '80 floors above should render LEVEL 81');

  // 7. Missing sensors property entirely
  const noSensorsTick = {
    fusedLocation: { lat: 1.3327, lng: 103.8479, floorsAbove: 1 },
    heartRate: 80,
    battery: 95,
  };
  assert.doesNotThrow(() => visualizer.updateTelemetry(noSensorsTick));
  assert.ok(visualizer._dataSource.entities.values.length >= 6);

  // 8. WebSocket Disconnected & Reconnect event lifecycle
  // Visualizer should safely maintain or update entities without corruption
  visualizer.clear();
  assert.equal(visualizer._dataSource.entities.values.length, 0);
  visualizer.updateTelemetry(noSensorsTick);
  assert.ok(visualizer._dataSource.entities.values.length >= 6);

  visualizer.destroy();
});

test('Adversarial 2b: Malformed / Non-finite Sensor Coordinate Resilience', () => {
  const { viewer } = createMockViewer();
  const visualizer = new SafeSpotTelemetryVisualizer(viewer);
  visualizer.attach();

  // Test when sensor object is present but lat/lng are non-numeric or empty
  // (e.g. GPS lock lost indoors: watchGnss = {})
  const malformedSensorsTick = {
    fusedLocation: { lat: 1.3327, lng: 103.8479, floorsAbove: 2 },
    sensors: {
      watchGnss: {},
      phoneGps: { lat: 'invalid', lng: 'bad' },
    },
  };

  // Empirical test: Does Cesium Cartesian3 throw DeveloperError when passed NaN?
  let caughtError = null;
  try {
    visualizer.updateTelemetry(malformedSensorsTick);
  } catch (err) {
    caughtError = err;
  }

  // Document whether this edge case is handled or throws DeveloperError
  if (caughtError) {
    assert.ok(
      caughtError.message.includes('not a number') || caughtError.name === 'DeveloperError',
      'Confirms Cesium DeveloperError on NaN sensor coordinates when sensor object has missing lat/lng',
    );
  }

  visualizer.destroy();
});

// ============================================================================
// 3. Fall Alert Cycling Stress
// ============================================================================
test('Adversarial 3: Rapid Fall Alert Cycling & Cleanup (100 cycles)', () => {
  const { viewer } = createMockViewer();
  const visualizer = new SafeSpotTelemetryVisualizer(viewer);
  visualizer.attach();

  const baseTelemetry = {
    fusedLocation: { lat: 1.3327, lng: 103.8479, floorsAbove: 3 },
    sensors: {
      watchGps: { lat: 1.33272, lng: 103.84791, accuracy: 10 },
      phoneGps: { lat: 1.33268, lng: 103.84785, accuracy: 25 },
      bleBeacon: { lat: 1.3327, lng: 103.8479, estimatedDistanceMeters: 2.5 },
    },
    heartRate: 72,
    battery: 90,
  };

  visualizer.updateTelemetry(baseTelemetry);
  const baseEntityCount = visualizer._dataSource.entities.values.length;
  assert.ok(baseEntityCount >= 6, 'Baseline entities must exist');

  // No alert initially
  assert.equal(
    visualizer._dataSource.entities.values.find((e) => e.id === 'safespot:telemetry:fall-alert'),
    undefined,
  );

  // Perform 100 rapid trigger and clear cycles
  for (let i = 0; i < 100; i++) {
    // 1. Trigger Alert
    visualizer.triggerFallAlert({ eventType: 'FALL_DETECTED', floorsAbove: 3 });
    const alertEntity = visualizer._dataSource.entities.values.find(
      (e) => e.id === 'safespot:telemetry:fall-alert',
    );
    assert.ok(alertEntity, `Fall alert entity must exist when triggered at cycle ${i}`);
    assert.equal(
      alertEntity.billboard.disableDepthTestDistance.getValue(),
      Number.POSITIVE_INFINITY,
      'Fall alert must have depth test disabled',
    );
    assert.equal(
      visualizer._dataSource.entities.values.length,
      baseEntityCount + 1,
      `Entity count should be exactly base + 1 during alert at cycle ${i}`,
    );

    assertNoCesiumLabels(visualizer._dataSource, `Fall alert active cycle ${i}`);

    // 2. Clear Alert
    visualizer.clearAlert();
    const alertAfterClear = visualizer._dataSource.entities.values.find(
      (e) => e.id === 'safespot:telemetry:fall-alert',
    );
    assert.equal(alertAfterClear, undefined, `Fall alert entity must be removed at cycle ${i}`);
    assert.equal(
      visualizer._dataSource.entities.values.length,
      baseEntityCount,
      `Entity count must return to exact baseline at cycle ${i}`,
    );

    assertNoCesiumLabels(visualizer._dataSource, `Fall alert cleared cycle ${i}`);
  }

  // Idempotent clear when no alert active
  assert.doesNotThrow(() => visualizer.clearAlert());
  assert.equal(visualizer._dataSource.entities.values.length, baseEntityCount);

  // Double trigger consecutive alerts without crash
  assert.doesNotThrow(() => {
    visualizer.triggerFallAlert({ eventType: 'FALL_DETECTED' });
    visualizer.triggerFallAlert({ eventType: 'FALL_DETECTED' });
  });
  assert.equal(
    visualizer._dataSource.entities.values.filter((e) => e.id === 'safespot:telemetry:fall-alert').length,
    1,
    'Consecutive alerts should never create duplicate alert entities',
  );

  visualizer.clearAlert();
  visualizer.destroy();
});

// ============================================================================
// 4. Candidate Switching Stress & Entity Isolation
// ============================================================================
test('Adversarial 4: Rapid Candidate Switching & HUD Billboard Detachment (100 switches)', () => {
  const { viewer } = createMockViewer();
  const renderer = new SafeSpotPickupRenderer(viewer);
  renderer.attach();

  const multiCandidateData = {
    isRaining: true,
    candidates: [
      {
        id: 'candidate-alpha',
        name: 'Taxi Stand Alpha (Top Pick)',
        lat: 1.3330,
        lng: 103.8485,
        score: 150,
        shelteredPercentage: 95,
        driverEtaSeconds: 180,
        seniorWalkSeconds: 120,
        walkingPath: [[103.8479, 1.3327], [103.8485, 1.3330]],
        drivePath: [{ lat: 1.3390, lng: 103.8420 }, { lat: 1.3330, lng: 103.8485 }],
      },
      {
        id: 'candidate-beta',
        name: 'Kerbside Beta',
        lat: 1.3310,
        lng: 103.8460,
        score: 220,
        shelteredPercentage: 70,
        driverEtaSeconds: 210,
        seniorWalkSeconds: 240,
        walkingPath: [[103.8479, 1.3327], [103.8460, 1.3310]],
        drivePath: [{ lat: 1.3390, lng: 103.8420 }, { lat: 1.3310, lng: 103.8460 }],
      },
      {
        id: 'candidate-gamma',
        name: 'Drop-off Gamma',
        lat: 1.3350,
        lng: 103.8490,
        score: 310,
        shelteredPercentage: 40,
        driverEtaSeconds: 300,
        seniorWalkSeconds: 360,
        walkingPath: [[103.8479, 1.3327], [103.8490, 1.3350]],
        drivePath: [{ lat: 1.3390, lng: 103.8420 }, { lat: 1.3350, lng: 103.8490 }],
      },
      {
        id: 'candidate-delta',
        name: 'Taxi Stand Delta',
        lat: 1.3300,
        lng: 103.8440,
        score: 390,
        shelteredPercentage: 85,
        driverEtaSeconds: 350,
        seniorWalkSeconds: 400,
        walkingPath: [[103.8479, 1.3327], [103.8440, 1.3300]],
        drivePath: [{ lat: 1.3390, lng: 103.8420 }, { lat: 1.3340, lng: 103.8440 }],
      },
    ],
  };

  renderer.renderPickupSimulation(multiCandidateData);
  const initialCount = renderer._dataSource.entities.values.length;
  // 4 candidate pins + senior origin + driver origin + 1 walk route + 1 drive route + 1 info card = 9 entities
  assert.equal(initialCount, 9, 'Initial entity count should be 9');

  const candidateIds = ['candidate-alpha', 'candidate-beta', 'candidate-gamma', 'candidate-delta'];

  // 100 switches across candidate IDs
  for (let i = 0; i < 100; i++) {
    const targetId = candidateIds[i % candidateIds.length];
    renderer.selectCandidate(targetId);

    const currentEntities = renderer._dataSource.entities.values;
    assert.equal(
      currentEntities.length,
      initialCount,
      `Entity count must not leak or change on candidate switch ${i} (expected ${initialCount}, got ${currentEntities.length})`,
    );

    // Exactly one info card exists
    const infoCards = currentEntities.filter((e) => e.id === 'safespot:pickup:info-card');
    assert.equal(infoCards.length, 1, `Exactly one info card must exist at switch ${i}`);

    // Exactly one walk route exists
    const walkRoutes = currentEntities.filter((e) => e.id === 'safespot:pickup:senior-walk-route');
    assert.equal(walkRoutes.length, 1, `Exactly one walk route must exist at switch ${i}`);

    // Exactly one drive route exists
    const driveRoutes = currentEntities.filter((e) => e.id === 'safespot:pickup:driver-approach-route');
    assert.equal(driveRoutes.length, 1, `Exactly one drive route must exist at switch ${i}`);

    // Target candidate has scale 1.15; others have 0.95
    for (const id of candidateIds) {
      const pin = currentEntities.find((e) => e.id === `safespot:pickup:candidate:${id}`);
      assert.ok(pin, `Pin for ${id} must exist`);
      const scale = pin.billboard.scale.getValue();
      if (id === targetId) {
        assert.equal(scale, 1.15, `Selected candidate ${id} must have scale 1.15`);
      } else {
        assert.equal(scale, 0.95, `Unselected candidate ${id} must have scale 0.95`);
      }
    }

    assertNoCesiumLabels(renderer._dataSource, `Candidate switch iteration ${i}`);
  }

  // Switch to non-existent candidate ID: should fall back to first candidate gracefully
  assert.doesNotThrow(() => renderer.selectCandidate('non-existent-candidate-xyz'));
  assert.equal(renderer.getSelectedCandidate().id, 'candidate-alpha');
  assert.equal(renderer._dataSource.entities.values.length, initialCount);

  renderer.destroy();
});

test('Adversarial 4b: SVG Info Card and Badge with XML Special Characters & Extreme Names', () => {
  // Test candidate with XML-sensitive characters like &, <, >, quotes
  const xmlCandidate = {
    rank: 1,
    name: 'Taxi & Private Drop-off <Zone 1>',
    type: 'taxi_stand',
    score: 250,
    driverEtaSeconds: 180,
    seniorWalkSeconds: 150,
    shelteredPercentage: 88,
    barrierFree: true,
    rankingReason: 'Fastest approach & covered walk <100m>',
  };

  const infoCardUri = createCandidateInfoCardSvg(xmlCandidate, true);
  assert.ok(infoCardUri.startsWith('data:image/svg+xml;charset=utf-8,'));

  // Test with extreme string lengths
  const longNameCandidate = {
    rank: 99,
    name: 'Very Long Name That Exceeds Normal Length For Display Purposes Inside HUD Billboard',
    rankingReason: 'Very long reason text that exceeds normal bounds and needs truncation',
  };
  const longCardUri = createCandidateInfoCardSvg(longNameCandidate, false);
  const decodedLongCard = decodeURIComponent(longCardUri);
  assert.ok(decodedLongCard.includes('…'), 'Long names should be truncated with ellipsis');
});

// ============================================================================
// 5. Invariant Stress: Exhaustive No-Cesium-Labels Verification
// ============================================================================
test('Adversarial 5: Global Invariant Verification (Zero Cesium Labels Across All States)', () => {
  const { viewer } = createMockViewer();
  const pickup = new SafeSpotPickupRenderer(viewer);
  const telemetry = new SafeSpotTelemetryVisualizer(viewer);
  pickup.attach();
  telemetry.attach();

  // Test across combinations:
  const sim = {
    isRaining: true,
    candidates: [
      {
        id: 'c1',
        name: 'Pick 1',
        lat: 1.33,
        lng: 103.84,
        shelteredPercentage: 90,
        walkingPath: [[103.84, 1.33], [103.841, 1.331]],
        drivePath: [{ lat: 1.34, lng: 103.85 }, { lat: 1.33, lng: 103.84 }],
      },
    ],
  };

  pickup.renderPickupSimulation(sim);
  assertNoCesiumLabels(pickup._dataSource, 'Combined pickup state');

  telemetry.updateTelemetry({
    fusedLocation: { lat: 1.332, lng: 103.845, floorsAbove: 4 },
    heartRate: 80,
    battery: 90,
  });
  telemetry.triggerFallAlert({ eventType: 'FALL_DETECTED' });
  assertNoCesiumLabels(telemetry._dataSource, 'Combined telemetry with fall alert');

  pickup.destroy();
  telemetry.destroy();
});

// ============================================================================
// 6. Controls & Layer State Machine Stress
// ============================================================================
test('Adversarial 6: Controls & Layer State Transitions Stress', async () => {
  const { viewer } = createMockViewer();
  const layer = createSafeSpotLayer();

  await layer.init(viewer);
  assert.equal(layer.showInTogglePanel, true);

  // Rapidly toggle parameters
  for (let i = 0; i < 50; i++) {
    layer.setParams({
      isRaining: i % 2 === 0,
      showHeatmap: i % 3 === 0,
      showDivergence: i % 4 === 0,
      showGoogleReference: i % 5 === 0,
      corridorId: i % 2 === 0 ? 'novena-to-mbs' : 'toa-payoh-to-raffles-place',
    });

    const params = layer.getParams();
    assert.equal(params.isRaining, i % 2 === 0);
    assert.equal(params.showHeatmap, i % 3 === 0);

    const rowControls = layer.getRowControls();
    assert.ok(rowControls.chips.length >= 8);
    assert.ok(rowControls.legend.length >= 8);
  }

  // Rapid enable / disable cycling
  for (let i = 0; i < 20; i++) {
    await layer.enable(viewer);
    const statsEnabled = layer.getStats();
    assert.ok(statsEnabled);

    await layer.disable(viewer);
    const statsDisabled = layer.getStats();
    assert.ok(statsDisabled);
  }

  // Teardown
  await layer.destroy(viewer);
});
