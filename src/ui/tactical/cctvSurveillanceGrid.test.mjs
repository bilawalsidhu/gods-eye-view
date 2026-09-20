import test from 'node:test';
import assert from 'node:assert/strict';
import { CctvSurveillanceGrid } from './cctvSurveillanceGrid.js';

test('CctvSurveillanceGrid manages feeds, limits, and dom presentation', () => {
  const domElements = [];
  const mockDoc = {
    createElement: (tag) => {
      const el = {
        tagName: tag,
        className: '',
        style: {},
        innerHTML: '',
        children: [],
        appendChild: (child) => el.children.push(child),
        querySelectorAll: () => [],
        querySelector: () => null,
        remove: () => {},
      };
      domElements.push(el);
      return el;
    },
    body: {
      appendChild: (el) => domElements.push(el),
    },
  };

  let flyToTarget = null;
  const mockViewer = {
    camera: {
      flyTo: (opts) => {
        flyToTarget = opts;
      },
    },
  };

  const cues = [];
  const grid = new CctvSurveillanceGrid({
    viewer: mockViewer,
    documentRef: mockDoc,
    playCue: (cue) => cues.push(cue),
  });

  assert.equal(grid.feeds.length, 0);

  // Add 4 feeds
  for (let i = 1; i <= 4; i++) {
    const ok = grid.addFeed({
      id: `cam_${i}`,
      name: `Tokyo Cam ${i}`,
      agency: 'Tokyo Police',
      city: 'Tokyo',
      longitude: 139.7 + i * 0.01,
      latitude: 35.6 + i * 0.01,
    });
    assert.equal(ok, true);
  }

  assert.equal(grid.feeds.length, 4);
  assert.equal(cues.includes('data'), true);

  // Add 5th feed - should evict oldest feed (cam_1)
  grid.addFeed({
    id: 'cam_5',
    name: 'Paris Cam 1',
    agency: 'Paris Police',
    city: 'Paris',
    longitude: 2.3,
    latitude: 48.8,
  });

  assert.equal(grid.feeds.length, 4);
  assert.equal(grid.feeds.some((f) => f.id === 'cam_1'), false);
  assert.equal(grid.feeds.some((f) => f.id === 'cam_5'), true);

  // Remove cam_2
  assert.equal(grid.removeFeed('cam_2'), true);
  assert.equal(grid.feeds.length, 3);

  // Fly to cam_5
  globalThis.Cesium = {
    Cartesian3: {
      fromDegrees: (lon, lat, alt) => ({ lon, lat, alt }),
    },
    Math: {
      toRadians: (deg) => deg,
    },
  };

  const cam5 = grid.feeds.find((f) => f.id === 'cam_5');
  grid.flyToFeed(cam5);
  assert.ok(flyToTarget !== null);
  assert.equal(flyToTarget.destination.lon, 2.3);

  // Clear all
  grid.clearAll();
  assert.equal(grid.feeds.length, 0);
});
