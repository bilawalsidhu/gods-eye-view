import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindRenderer } from '../../render/rendererOf.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import {
  addCellCamera,
  createCameraCell,
  mergeCountCells,
} from '../../data/cctvCellCounts.js';
import { createNavigation } from './navigation.js';

const M = 111_320;

// Cesium's default 60 degree field of view spans the wider side, so a 4:3
// window has a vertical fovy of about 46.8 degrees. Two pairs 50 km and 80 km
// east of an eye 800 m up merge into one count. At half the distance all four
// fit in the frame (the group is wide, not tall), so the flight must keep all
// four in frame instead of approaching only the near pair.
test('a count click on an east-west group that fits keeps every member in the frame', () => {
  const viewer = {};
  const flights = [];
  const aspectRatio = 800 / 600;
  const fovy = 2 * Math.atan(Math.tan(Math.PI / 6) / aspectRatio);
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ fovy, aspectRatio, position: fromDegrees(0, 0, 800) }),
      flyToBounds: (bounds, options) => flights.push({ bounds, options }),
    },
    canvas: { clientHeight: 600, clientWidth: 800 },
  });
  try {
    const members = [];
    const cells = [50_000, 80_000].map((start) => {
      const cell = createCameraCell(String(start));
      for (const eastM of [start, start + 10]) {
        const lon = eastM / M;
        addCellCamera(cell, { lat: 0, lon, absoluteHeightM: 8 });
        members.push(lon);
      }
      return cell;
    });
    const screens = [
      { x: 400, y: 300 },
      { x: 433, y: 300 },
    ];
    const groups = mergeCountCells(
      cells,
      () => screens.shift(),
      () => ({ width: 40, height: 40 }),
      2,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 4);
    // Reference: a north-up top-down frame at half the distance holds all four.
    const halfwayM = 65_005 / 2;
    const refHalfX = halfwayM * Math.tan(fovy / 2) * aspectRatio;
    assert.ok(members.every((lon) => Math.abs(lon * M - 65_005) <= refHalfX));
    createNavigation({ state: { _viewer: viewer }, parts: {} }).zoomToCell(
      groups[0],
    );
    assert.equal(flights.length, 1);
    const { range } = flights[0].options.offset;
    const center = toLonLatH(flights[0].bounds.center);
    const halfX = range * Math.tan(fovy / 2) * aspectRatio;
    const inFrame = members.filter(
      (lon) => Math.abs((lon - center.lon) * M) <= halfX,
    );
    assert.equal(
      inFrame.length,
      4,
      `only ${inFrame.length} of 4 members in frame (range ${Math.round(range)} m)`,
    );
  } finally {
    unbind();
  }
});
