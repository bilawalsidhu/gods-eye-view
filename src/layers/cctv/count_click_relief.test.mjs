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

function run({ aspectRatio, fovy, eye, pairs, groundM }) {
  const viewer = {};
  const flights = [];
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ fovy, aspectRatio, position: eye }),
      flyToBounds: (bounds, options) => flights.push({ bounds, options }),
    },
    canvas: { clientHeight: 600, clientWidth: Math.round(600 * aspectRatio) },
  });
  try {
    const members = [];
    const cells = pairs.map(({ eastM = 0, northM = 0, h }, i) => {
      const cell = createCameraCell(String(i));
      for (const d of [0, 10]) {
        const m = { lon: (eastM + d) / M, lat: northM / M, h };
        addCellCamera(cell, { lat: m.lat, lon: m.lon, absoluteHeightM: h });
        members.push(m);
      }
      cell.groundM = h;
      return cell;
    });
    const screens = [
      { x: 400, y: 300 },
      { x: 420, y: 300 },
    ];
    const groups = mergeCountCells(
      cells,
      () => screens.shift(),
      () => ({ width: 40, height: 40 }),
      2,
    );
    assert.equal(groups.length, 1);
    groups[0].groundM = groundM;
    createNavigation({ state: { _viewer: viewer }, parts: {} }).zoomToCell(
      groups[0],
    );
    const { range } = flights[0].options.offset;
    const c = toLonLatH(flights[0].bounds.center);
    const eyeH = c.height + range;
    const tanY = Math.tan(fovy / 2);
    const inFrame = members.filter((m) => {
      const depth = eyeH - m.h;
      if (!(depth > 0)) return false;
      return (
        Math.abs((m.lon - c.lon) * M) <= depth * tanY * aspectRatio &&
        Math.abs((m.lat - c.lat) * M) <= depth * tanY
      );
    });
    return { range, inFrame: inFrame.length, centerH: c.height };
  } finally {
    unbind();
  }
}

test('a count click on pairs 300 m above the ground under the group centre keeps a member in the frame', () => {
  const aspectRatio = 4 / 3;
  const fovy = 2 * Math.atan(Math.tan(Math.PI / 6) / aspectRatio);
  const r = run({
    aspectRatio,
    fovy,
    eye: fromDegrees(0, 0, 900),
    pairs: [
      { eastM: 3000, h: 800 },
      { eastM: 5000, h: 800 },
    ],
    groundM: 500,
  });

  const flat = run({
    aspectRatio,
    fovy,
    eye: fromDegrees(0, 0, 900),
    pairs: [
      { eastM: 3000, h: 500 },
      { eastM: 5000, h: 500 },
    ],
    groundM: 500,
  });

  assert.equal(flat.inFrame, 4);
  assert.ok(r.inFrame > 0, `no member in frame: ${JSON.stringify(r)}`);
});
