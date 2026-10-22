import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  PICKUP_COLORS,
  createRankBadgeSvg,
  createCandidateInfoCardSvg,
  createSeniorPinSvg,
  createDriverPinSvg,
  SafeSpotPickupRenderer,
} from './pickup.js';

test('Pickup color palette and constants', () => {
  assert.equal(PICKUP_COLORS.WALK_SHELTERED, '#10b981');
  assert.equal(PICKUP_COLORS.WALK_UNSHELTERED, '#38bdf8');
  assert.equal(PICKUP_COLORS.DRIVE_APPROACH, '#f59e0b');
  assert.equal(PICKUP_COLORS.SENIOR_PIN, '#06b6d4');
  assert.equal(PICKUP_COLORS.DRIVER_PIN, '#f59e0b');
  assert.equal(PICKUP_COLORS.RANK_GOLD, '#10b981');
  assert.equal(PICKUP_COLORS.RANK_SILVER, '#0284c7');
  assert.equal(PICKUP_COLORS.RANK_BRONZE, '#8b5cf6');
});

test('SVG Rank badge data URI generator', () => {
  const badge1 = createRankBadgeSvg(1, 94, true);
  assert.ok(badge1.startsWith('data:image/svg+xml;charset=utf-8,'));
  const decoded1 = decodeURIComponent(badge1);
  assert.ok(decoded1.includes('#1'), 'Badge should display rank #1');
  assert.ok(decoded1.includes('94%'), 'Badge should show sheltered percentage');
  assert.ok(decoded1.includes(PICKUP_COLORS.RANK_GOLD), 'Rank 1 should use gold/emerald color');

  const badge2 = createRankBadgeSvg(2, 50, false);
  const decoded2 = decodeURIComponent(badge2);
  assert.ok(decoded2.includes('#2'));
  assert.ok(decoded2.includes('50%'));
  assert.ok(decoded2.includes(PICKUP_COLORS.RANK_SILVER));
});

test('SVG Candidate info card billboard HUD generator', () => {
  const mockCandidate = {
    rank: 1,
    name: 'Toa Payoh Central Taxi Stand',
    type: 'taxi_stand',
    score: 285,
    driverEtaSeconds: 240,
    seniorWalkSeconds: 180,
    shelteredPercentage: 94,
    barrierFree: true,
    rankingReason: 'Covered linkway connection, barrier-free access',
  };

  const cardSvg = createCandidateInfoCardSvg(mockCandidate, true);
  assert.ok(cardSvg.startsWith('data:image/svg+xml;charset=utf-8,'));
  const decoded = decodeURIComponent(cardSvg);

  assert.ok(decoded.includes('#1'), 'Card must show rank #1');
  assert.ok(decoded.includes('Toa Payoh Central'), 'Card must show candidate name');
  assert.ok(decoded.includes('3m 0s'), 'Card must show senior walk duration');
  assert.ok(decoded.includes('94% roof'), 'Card must show sheltered percentage');
  assert.ok(decoded.includes('4 min'), 'Card must show driver ETA');
  assert.ok(decoded.includes('285 pts'), 'Card must show Dijkstra score');
  assert.ok(decoded.includes('RAIN ADAPTED'), 'Card must show rain adapted badge when raining');
  assert.ok(decoded.includes('Covered linkway connection'), 'Card must show ranking reason');
});

test('SVG Senior and Driver origin pin generators', () => {
  const seniorPin = createSeniorPinSvg();
  assert.ok(seniorPin.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.ok(decodeURIComponent(seniorPin).includes('#06b6d4'));

  const driverPin = createDriverPinSvg();
  assert.ok(driverPin.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.ok(decodeURIComponent(driverPin).includes('#f59e0b'));
});

test('SafeSpotPickupRenderer lifecycle and 3D draped Cesium primitives', () => {
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
    },
  };

  const renderer = new SafeSpotPickupRenderer(mockViewer);
  assert.equal(renderer._attached, false);

  // Attach
  renderer.attach();
  assert.equal(renderer._attached, true);
  assert.equal(addedDataSources.length, 1);
  assert.equal(addedDataSources[0].show, true);

  // Mock simulation data
  const mockSimData = {
    isRaining: true,
    candidates: [
      {
        id: 'stand-1',
        name: 'Toa Payoh Hub Taxi Stand 1',
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
        name: 'Lorong 2 Toa Payoh Drop-off',
        type: 'kerbside',
        lat: 1.33150,
        lng: 103.84650,
        score: 410,
        rankingReason: 'Unsheltered road kerbside',
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

  renderer.renderPickupSimulation(mockSimData, {
    seniorLocation: { lat: 1.3327, lng: 103.8479 },
    driverLocation: { lat: 1.3390, lng: 103.8420 },
  });

  const entities = renderer._dataSource.entities.values;
  assert.ok(entities.length >= 6, 'Should create senior, driver, candidate pins, routes, and card');

  // Verify Senior Pin
  const seniorEntity = entities.find((e) => e.id === 'safespot:pickup:senior-origin');
  assert.ok(seniorEntity, 'Must create senior origin pin');
  assert.equal(seniorEntity.billboard.disableDepthTestDistance.getValue(), Number.POSITIVE_INFINITY);

  // Verify Driver Pin
  const driverEntity = entities.find((e) => e.id === 'safespot:pickup:driver-origin');
  assert.ok(driverEntity, 'Must create driver origin pin');

  // Verify Candidate Pins
  const cand1 = entities.find((e) => e.id === 'safespot:pickup:candidate:stand-1');
  const cand2 = entities.find((e) => e.id === 'safespot:pickup:candidate:kerb-1');
  assert.ok(cand1, 'Candidate 1 pin must exist');
  assert.ok(cand2, 'Candidate 2 pin must exist');
  assert.equal(cand1.billboard.disableDepthTestDistance.getValue(), Number.POSITIVE_INFINITY);

  // Verify Senior Walk Route Drape
  const walkRoute = entities.find((e) => e.id === 'safespot:pickup:senior-walk-route');
  assert.ok(walkRoute, 'Senior walk route entity must exist');
  assert.equal(walkRoute.polyline.clampToGround.getValue(), true, 'Walking route must drape with clampToGround: true');
  assert.equal(
    walkRoute.polyline.classificationType.getValue(),
    Cesium.ClassificationType.BOTH,
    'Walking route must use ClassificationType.BOTH for terrain and 3D tiles',
  );
  assert.equal(walkRoute.polyline.width.getValue(), 6);

  // Verify Driver Approach Route Drape
  const driveRoute = entities.find((e) => e.id === 'safespot:pickup:driver-approach-route');
  assert.ok(driveRoute, 'Driver approach route entity must exist');
  assert.equal(driveRoute.polyline.clampToGround.getValue(), true, 'Driver route must drape with clampToGround: true');
  assert.equal(
    driveRoute.polyline.classificationType.getValue(),
    Cesium.ClassificationType.BOTH,
    'Driver route must use ClassificationType.BOTH for terrain and 3D tiles',
  );
  assert.equal(driveRoute.polyline.width.getValue(), 7);

  // Verify Info Card Billboard
  const infoCard = entities.find((e) => e.id === 'safespot:pickup:info-card');
  assert.ok(infoCard, 'Info card billboard entity must exist');
  assert.equal(infoCard.billboard.disableDepthTestDistance.getValue(), Number.POSITIVE_INFINITY);

  // Candidate selection switching
  assert.equal(renderer.getSelectedCandidate().id, 'stand-1');
  renderer.selectCandidate('kerb-1');
  assert.equal(renderer.getSelectedCandidate().id, 'kerb-1');

  // Detach & Destroy
  renderer.detach();
  assert.equal(renderer._attached, false);
  assert.equal(addedDataSources[0].show, false);

  renderer.destroy();
  assert.equal(removedDataSources.length, 1);
});
