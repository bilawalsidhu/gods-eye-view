import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindRenderer } from '../../render/rendererOf.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { distance } from '../../geo/vector.js';
import {
  addCellCamera,
  createCameraCell,
  mergeCountCells,
} from '../../data/cctvCellCounts.js';
import { createNavigation } from './navigation.js';

const M = 111_320;

/**
 * Merge `cells` into one count from a camera at `eye`, click it and return
 * where the single flight went.
 */
function flyToGroup({
  aspectRatio,
  fovy,
  eye,
  cells,
  screens,
  size = () => ({ width: 40, height: 40 }),
  prepare = () => {},
}) {
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
    const groups = mergeCountCells(cells, () => screens.shift(), size, 2);
    assert.equal(groups.length, 1);
    prepare(groups[0]);
    createNavigation({ state: { _viewer: viewer }, parts: {} }).zoomToCell(
      groups[0],
    );
    assert.equal(flights.length, 1);
    const [flight] = flights;
    return {
      group: groups[0],
      range: flight.options.offset.range,
      pitch: flight.options.offset.pitch,
      center: flight.bounds.center,
    };
  } finally {
    unbind();
  }
}

/** Pairs of cameras 10 m apart east-west, each pair one cell at height `h`. */
function run({ aspectRatio, fovy, eye, pairs, groundM }) {
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
  const { range, center } = flyToGroup({
    aspectRatio,
    fovy,
    eye,
    cells,
    screens: [
      { x: 400, y: 300 },
      { x: 420, y: 300 },
    ],
    prepare: (group) => {
      group.groundM = groundM;
    },
  });
  const c = toLonLatH(center);
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
}

// A count of four merged in a tilted view: two pairs 10 km and 40 km north of
// an eye 800 m up. After the click, at least one member must be in frame.
test('a count click from a tilted view keeps the group members in the frame', () => {
  const fovy = Math.PI / 3;
  const members = [];
  const cells = [10_000, 40_000].map((start) => {
    const cell = createCameraCell(String(start));
    for (const northM of [start, start + 10]) {
      const lat = northM / M;
      addCellCamera(cell, { lat, lon: 0, absoluteHeightM: 8 });
      members.push(fromDegrees(0, lat, 8));
    }
    return cell;
  });
  const { group, range, pitch, center } = flyToGroup({
    aspectRatio: 800 / 600,
    fovy,
    eye: fromDegrees(0, 0, 800),
    cells,
    screens: [
      { x: 400, y: 300 },
      { x: 433, y: 300 },
    ],
  });
  assert.equal(group.count, 4);
  assert.equal(pitch, -Math.PI / 2);
  const halfSpanM = range * Math.tan(fovy / 2);
  assert.ok(
    members.some((point) => distance(point, center) <= halfSpanM),
    'no member of the group is in the final frame',
  );
  assert.ok(range < distance(fromDegrees(0, 0, 800), center));
});

// Cesium's default 60 degree field of view spans the wider side, so a 4:3
// window has a vertical fovy of about 46.8 degrees. Two pairs 50 km and 80 km
// east of an eye 800 m up merge into one count. At half the distance all four
// fit in the frame (the group is wide, not tall), so the flight must keep all
// four in frame instead of approaching only the near pair.
test('a count click on an east-west group that fits keeps every member in the frame', () => {
  const aspectRatio = 800 / 600;
  const fovy = 2 * Math.atan(Math.tan(Math.PI / 6) / aspectRatio);
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
  const { group, range, center } = flyToGroup({
    aspectRatio,
    fovy,
    eye: fromDegrees(0, 0, 800),
    cells,
    screens: [
      { x: 400, y: 300 },
      { x: 433, y: 300 },
    ],
  });
  assert.equal(group.count, 4);
  // Reference: a north-up top-down frame at half the distance holds all four.
  const halfwayM = 65_005 / 2;
  const refHalfX = halfwayM * Math.tan(fovy / 2) * aspectRatio;
  assert.ok(members.every((lon) => Math.abs(lon * M - 65_005) <= refHalfX));
  const { lon: centerLon } = toLonLatH(center);
  const halfX = range * Math.tan(fovy / 2) * aspectRatio;
  const inFrame = members.filter(
    (lon) => Math.abs((lon - centerLon) * M) <= halfX,
  );
  assert.equal(
    inFrame.length,
    4,
    `only ${inFrame.length} of 4 members in frame (range ${Math.round(range)} m)`,
  );
});

// A count of 40 cameras 40 km north of an eye 800 m up takes in a lone camera
// 10 km north that is drawn just below it. The click must not land on the lone
// camera alone: at least one of the 40 counted cameras must be in the frame.
test('a count click does not fly to a lone camera that joined the count', () => {
  const fovy = Math.PI / 3;
  const crowd = createCameraCell('crowd');
  const counted = [];
  for (let i = 0; i < 40; i++) {
    const lat = (40_000 + i / 4) / M;
    addCellCamera(crowd, { lat, lon: 0, absoluteHeightM: 8 });
    counted.push(lat);
  }
  const lone = createCameraCell('lone');
  addCellCamera(lone, { lat: 10_000 / M, lon: 0, absoluteHeightM: 8 });
  const { group, range, center } = flyToGroup({
    aspectRatio: 800 / 600,
    fovy,
    eye: fromDegrees(0, 0, 800),
    cells: [crowd, lone],
    screens: [
      { x: 400, y: 300 },
      { x: 400, y: 330 },
    ],
    size: (count) =>
      count > 1 ? { width: 40, height: 40 } : { width: 24, height: 24 },
  });
  assert.equal(group.count, 41);
  const { lat: centerLat } = toLonLatH(center);
  const halfY = range * Math.tan(fovy / 2);
  const inFrame = counted.filter(
    (lat) => Math.abs((lat - centerLat) * M) <= halfY,
  );
  assert.ok(
    inFrame.length > 0,
    `none of the 40 counted cameras is in the frame (range ${Math.round(range)} m, centre ${Math.round(centerLat * M)} m north)`,
  );
});

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

test('a count click on a north-south group in a 32:9 window keeps every member in the frame', () => {
  const aspectRatio = 32 / 9;
  const fovy = 2 * Math.atan(Math.tan(Math.PI / 6) / aspectRatio);
  const r = run({
    aspectRatio,
    fovy,
    eye: fromDegrees(0, 0, 800),
    pairs: [
      { northM: 15_000, h: 8 },
      { northM: 17_000, h: 8 },
    ],
    groundM: 8,
  });

  assert.equal(r.inFrame, 4, JSON.stringify(r));
});
