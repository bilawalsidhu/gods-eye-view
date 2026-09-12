// src/data/trafficOptimization.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCoordInBounds,
  roadIntersectsBounds,
  prioritizeRoadsForViewport,
  computeNeighborRingBounds,
  calculateAdaptiveDotCap,
} from './trafficBounds.js';
import trafficLayer from './traffic.js';
import { reduceTrafficSyncFeedback, createTrafficSyncFeedbackState } from '../loadingFeedback.js';

const AUSTIN_BOUNDS = { south: 30.25, north: 30.28, west: -97.76, east: -97.72 };
const CENTER = { lat: 30.265, lon: -97.74 };

test('isCoordInBounds accurately checks inclusion', () => {
  assert.equal(isCoordInBounds(30.26, -97.74, AUSTIN_BOUNDS), true);
  assert.equal(isCoordInBounds(30.20, -97.74, AUSTIN_BOUNDS), false);
  assert.equal(isCoordInBounds(30.26, -97.80, AUSTIN_BOUNDS), false);
  assert.equal(isCoordInBounds(30.26, -97.74, null), false);
});

test('roadIntersectsBounds detects points and bounding intersections', () => {
  const inRoad = {
    coords: [
      [-97.745, 30.260],
      [-97.740, 30.265],
    ],
  };
  assert.equal(roadIntersectsBounds(inRoad, AUSTIN_BOUNDS), true);

  const outRoad = {
    coords: [
      [-97.85, 30.10],
      [-97.84, 30.11],
    ],
  };
  assert.equal(roadIntersectsBounds(outRoad, AUSTIN_BOUNDS), false);

  // Spanning across without any vertex strictly inside
  const crossingRoad = {
    coords: [
      [-97.74, 30.20],
      [-97.74, 30.35],
    ],
  };
  assert.equal(roadIntersectsBounds(crossingRoad, AUSTIN_BOUNDS), true);
});

test('prioritizeRoadsForViewport places in-view and central roads first', () => {
  const roadDowntown = {
    id: 'downtown',
    type: 'primary',
    coords: [[-97.74, 30.265], [-97.741, 30.266]], // inside bounds, at center
  };
  const roadFarOut = {
    id: 'farOut',
    type: 'motorway',
    coords: [[-97.90, 30.10], [-97.91, 30.11]], // outside bounds
  };
  const roadEdge = {
    id: 'edge',
    type: 'residential',
    coords: [[-97.721, 30.251], [-97.722, 30.252]], // inside bounds, but near edge
  };

  const prioritized = prioritizeRoadsForViewport([roadFarOut, roadEdge, roadDowntown], AUSTIN_BOUNDS, CENTER);
  assert.equal(prioritized[0].id, 'downtown', 'central in-view road must come first');
  assert.equal(prioritized[1].id, 'edge', 'in-view edge road must come before out-of-view road');
  assert.equal(prioritized[2].id, 'farOut', 'out-of-view road must come last despite motorway class');
});

test('computeNeighborRingBounds creates 8 surrounding tile bounds with correct span offsets', () => {
  const neighbors = computeNeighborRingBounds(AUSTIN_BOUNDS);
  assert.equal(neighbors.length, 8);

  const directions = neighbors.map(n => n.direction);
  assert.deepEqual(directions, ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

  const latSpan = AUSTIN_BOUNDS.north - AUSTIN_BOUNDS.south;
  const lonSpan = AUSTIN_BOUNDS.east - AUSTIN_BOUNDS.west;

  const northNeighbor = neighbors.find(n => n.direction === 'N');
  assert.ok(Math.abs(northNeighbor.bounds.south - AUSTIN_BOUNDS.north) < 1e-9);
  assert.ok(Math.abs((northNeighbor.bounds.north - northNeighbor.bounds.south) - latSpan) < 1e-9);

  const eastNeighbor = neighbors.find(n => n.direction === 'E');
  assert.ok(Math.abs(eastNeighbor.bounds.west - AUSTIN_BOUNDS.east) < 1e-9);
  assert.ok(Math.abs((eastNeighbor.bounds.east - eastNeighbor.bounds.west) - lonSpan) < 1e-9);
});

test('calculateAdaptiveDotCap smoothly steps down on high frame times and recovers on headroom', () => {
  // Normal 60 FPS (16.7ms) -> maintains or recovers toward maxCap
  assert.equal(calculateAdaptiveDotCap(16.6, 5000), 5100);

  // Severe frame drop (33.3ms = 30 FPS) -> reduces cap by stepDown (300)
  assert.equal(calculateAdaptiveDotCap(33.3, 5000), 4700);

  // Frame drop respects minimum floor (minCap = 3000)
  assert.equal(calculateAdaptiveDotCap(40.0, 3100), 3000);

  // High headroom respects maximum ceiling (maxCap = 6000)
  assert.equal(calculateAdaptiveDotCap(15.0, 5950), 6000);

  // Non-finite or zero values leave cap unchanged
  assert.equal(calculateAdaptiveDotCap(NaN, 4500), 4500);
  assert.equal(calculateAdaptiveDotCap(-5, 4500), 4500);
});

test('trafficLayer.getStats includes multi-phase progress and prefetch stats', () => {
  const stats = trafficLayer.getStats();
  assert.ok('phaseProgressPct' in stats, 'must have phaseProgressPct');
  assert.ok('phaseLabel' in stats, 'must have phaseLabel');
  assert.ok('prewarmQueueDepth' in stats, 'must have prewarmQueueDepth');
  assert.ok('adaptiveDotCap' in stats, 'must have adaptiveDotCap');

  assert.equal(stats.phaseProgressPct, 100);
  assert.equal(stats.prewarmQueueDepth, 0);
  assert.equal(stats.adaptiveDotCap, 6000);
});

test('reduceTrafficSyncFeedback presents multi-phase progress when traffic layer is busy', () => {
  const busyStats = {
    loading: true,
    phaseProgressPct: 65,
    phaseLabel: 'loading local streets',
    prewarmQueueDepth: 3,
    loadingLabel: 'SIMULATED — add TomTom key for live',
  };

  const state = reduceTrafficSyncFeedback(createTrafficSyncFeedbackState(), {
    enabled: true,
    stats: busyStats,
  }, 100);

  assert.equal(state.busy, true);
  assert.equal(state.visible, true);
  assert.equal(state.progressText, '65%');
  assert.equal(state.label, 'loading local streets');
});
