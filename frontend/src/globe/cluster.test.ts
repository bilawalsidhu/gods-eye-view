/**
 * Tests for the screen-space clustering engine.
 *
 * Nothing here needs Cesium, a canvas or a camera: the projection is a multiply against a
 * column-major 4x4, so a test passes sixteen plain numbers and asserts on pixels. That is the
 * whole reason the module is shaped this way.
 *
 * What most of the file protects is the promise clustering makes to a viewer. Every mover the
 * camera can see is either drawn as itself or counted inside exactly one group, and the two
 * numbers add up to the total. If that stops holding, the layer rail starts telling people a
 * count that the globe disagrees with, and nothing else in the suite would notice.
 */

import { describe, expect, it } from 'vitest';

import {
  CLUSTER_CELL_PX,
  CLUSTER_FLY_FLOOR_M,
  CLUSTER_MIN_MEMBERS,
  CLUSTER_PICK_PREFIX,
  OFF_SCREEN,
  ScreenClusterer,
  clusterCameraHeight,
  clusterPickId,
  occludedByGlobe,
  parseClusterPickId,
  projectToScreen,
} from './cluster';
import { clusterBadgePx } from './palette';

const WIDTH = 1600;
const HEIGHT = 1000;

/**
 * A view-projection that maps x and y straight to canvas pixels and ignores z.
 *
 * Column-major, like Cesium's own `Matrix4`, and deliberately not a real camera: a real one would
 * make every expectation in this file a projection calculation rather than a statement about
 * clustering. `w` is pinned to 1, so there is no perspective divide to reason about.
 */
function pixelMatrix(widthPx = WIDTH, heightPx = HEIGHT): number[] {
  const m = Array.from({ length: 16 }, () => 0);
  m[0] = 2 / widthPx;
  m[12] = -1;
  // Negative, because normalised device coordinates run y up and a canvas runs y down.
  m[5] = -2 / heightPx;
  m[13] = 1;
  m[15] = 1;
  return m;
}

/** Earth radius the engine uses internally, for the occlusion tests. */
const R = 6_371_008.8;

describe('projectToScreen', () => {
  const out = { x: 0, y: 0 };

  it('puts the middle of the world in the middle of the canvas', () => {
    expect(projectToScreen(pixelMatrix(), WIDTH / 2, HEIGHT / 2, 0, WIDTH, HEIGHT, out)).toBe(true);
    expect(out).toEqual({ x: WIDTH / 2, y: HEIGHT / 2 });
  });

  it('maps a point to the pixel the matrix says, y flipped', () => {
    projectToScreen(pixelMatrix(), 400, 250, 0, WIDTH, HEIGHT, out);

    expect(out.x).toBeCloseTo(400, 6);
    expect(out.y).toBeCloseTo(250, 6);
  });

  it('refuses a point behind the camera rather than folding it onto the screen', () => {
    // A negative w is the far side of the eye. Dividing by it mirrors the point into view, which
    // would put an aircraft over the Pacific into a group over London.
    const m = pixelMatrix();
    m[15] = -1;

    expect(projectToScreen(m, 800, 500, 0, WIDTH, HEIGHT, out)).toBe(false);
  });

  it('refuses a point off the edge rather than clamping it to the edge', () => {
    // Clamping would collect everything beyond the left margin into the leftmost column and
    // report a group of forty where the screen shows nothing.
    expect(projectToScreen(pixelMatrix(), -20, 500, 0, WIDTH, HEIGHT, out)).toBe(false);
    expect(projectToScreen(pixelMatrix(), WIDTH + 1, 500, 0, WIDTH, HEIGHT, out)).toBe(false);
    expect(projectToScreen(pixelMatrix(), 800, -1, 0, WIDTH, HEIGHT, out)).toBe(false);
    expect(projectToScreen(pixelMatrix(), 800, HEIGHT, 0, WIDTH, HEIGHT, out)).toBe(false);
  });

  it('leaves the output alone when it refuses, so a stale pixel cannot be read as fresh', () => {
    out.x = -1;
    out.y = -1;

    projectToScreen(pixelMatrix(), -500, -500, 0, WIDTH, HEIGHT, out);

    expect(out).toEqual({ x: -1, y: -1 });
  });
});

describe('occludedByGlobe', () => {
  const camera = { x: 0, y: 0, z: 20_000_000 };

  it('shows a point on the near side', () => {
    expect(occludedByGlobe(camera.x, camera.y, camera.z, 0, 0, R)).toBe(false);
  });

  it('hides a point on the far side', () => {
    expect(occludedByGlobe(camera.x, camera.y, camera.z, 0, 0, -R)).toBe(true);
  });

  it('shows a satellite above the far limb, which the horizon-plane shortcut gets wrong', () => {
    // This is why the test is a segment against a sphere rather than `dot(p, camera) < r squared`.
    // A satellite 400 km up, out at ninety degrees from the sub-camera point, is genuinely in
    // view from twenty thousand kilometres, and the plane test calls it hidden. Counting it into
    // a group on the near side would make that group's number a claim about the other side of the
    // world.
    const altitude = R + 400_000;

    expect(occludedByGlobe(camera.x, camera.y, camera.z, altitude, 0, 0)).toBe(false);
  });

  it('hides an aircraft just past the horizon', () => {
    // Ten kilometres up, a hundred degrees round from the sub-camera point: past the limb.
    const radians = (100 * Math.PI) / 180;
    const radius = R + 10_000;

    expect(
      occludedByGlobe(
        camera.x,
        camera.y,
        camera.z,
        radius * Math.sin(radians),
        0,
        radius * Math.cos(radians),
      ),
    ).toBe(true);
  });

  it('hides nothing from a camera at the earth centre, which is what the layer tests lean on', () => {
    expect(occludedByGlobe(0, 0, 0, R, 0, 0)).toBe(false);
  });

  it('shows a point the camera is sitting on, rather than dividing by zero', () => {
    expect(occludedByGlobe(R, 0, 0, R, 0, 0)).toBe(false);
  });
});

/** Positions that project to a given pixel under `pixelMatrix`, at a plausible earth radius. */
function atPixel(x: number, y: number): [number, number, number] {
  return [x, y, 0];
}

/**
 * `count` positions that all land in the same cell.
 *
 * Ten across and one apart down, so any count used here stays inside a single grid cell whatever
 * `CLUSTER_CELL_PX` is, and a test can say "a cell holding this many" without doing the arithmetic.
 */
function crowd(count: number, originX = 100, originY = 100): [number, number, number][] {
  return Array.from({ length: count }, (_unused, index) =>
    atPixel(originX + (index % 10), originY + Math.floor(index / 10)),
  );
}

/** One full binning pass over a set of positions: begin, offer each, resolve. */
function pass(
  points: readonly (readonly [number, number, number])[],
  clusterer = new ScreenClusterer(),
) {
  clusterer.begin(WIDTH, HEIGHT);
  const cells = points.map(([x, y, z]) => clusterer.offer(pixelMatrix(), 0, 0, 0, x, y, z));
  clusterer.resolve();
  return { clusterer, cells };
}

describe('ScreenClusterer', () => {
  it('leaves a cell one short of the minimum drawn as itself', () => {
    // A badge hides the globe under it, so one replacing only a handful of marks costs the picture
    // more than the crowding it clears. Below the line, the marks stay.
    const short = CLUSTER_MIN_MEMBERS - 1;
    const { clusterer, cells } = pass(crowd(short));

    expect(new Set(cells).size).toBe(1);
    expect(clusterer.grouped(cells[0]!)).toBe(false);
    expect(clusterer.state).toMatchObject({ individuals: short, groups: 0, inGroups: 0 });
  });

  it('groups a cell once it holds the minimum', () => {
    const { clusterer, cells } = pass(crowd(CLUSTER_MIN_MEMBERS));

    expect(clusterer.grouped(cells[0]!)).toBe(true);
    expect(clusterer.state).toMatchObject({
      onScreen: CLUSTER_MIN_MEMBERS,
      individuals: 0,
      groups: 1,
      inGroups: CLUSTER_MIN_MEMBERS,
    });
  });

  it('respects a minimum a layer sets for itself', () => {
    // The satellite layer runs at thirty, because for it a badge is a step backwards until the pile
    // is genuinely large. A layer has to be able to say so.
    const strict = new ScreenClusterer(CLUSTER_CELL_PX, 30);
    pass(crowd(20), strict);

    expect(strict.state).toMatchObject({ individuals: 20, groups: 0 });
    pass(crowd(30), strict);
    expect(strict.state).toMatchObject({ groups: 1, inGroups: 30 });
  });

  it('keeps the count honest, which is the promise clustering makes', () => {
    // The invariant the layer rail rests on. One crowded cell, two loose pairs, one alone.
    const grouped = CLUSTER_MIN_MEMBERS + 2;
    const { clusterer } = pass([
      ...crowd(grouped),
      atPixel(500, 500),
      atPixel(505, 505),
      atPixel(900, 300),
    ]);

    const state = clusterer.state;
    expect(state.onScreen).toBe(grouped + 3);
    expect(state.individuals).toBe(3);
    expect(state.inGroups).toBe(grouped);
    expect(state.groups).toBe(1);
    expect(state.individuals + state.inGroups).toBe(state.onScreen);
  });

  it('reports the largest group, so a rail can say how bad the worst pile is', () => {
    const big = CLUSTER_MIN_MEMBERS + 6;
    const { clusterer } = pass([...crowd(big), ...crowd(CLUSTER_MIN_MEMBERS, 600, 600)]);

    expect(clusterer.state.largestGroup).toBe(big);
    expect(clusterer.state.groups).toBe(2);
  });

  it('counts nothing the camera cannot see', () => {
    const { clusterer, cells } = pass([atPixel(100, 100), atPixel(-40, 100), atPixel(100, -40)]);

    expect(cells[1]).toBe(OFF_SCREEN);
    expect(cells[2]).toBe(OFF_SCREEN);
    expect(clusterer.state.onScreen).toBe(1);
  });

  it('bins nothing that the globe is standing in front of', () => {
    // A mover on the far side projects onto the canvas perfectly happily. Binning it would put
    // aircraft over Australia into a group over London and publish a count for a place the
    // viewer cannot see.
    const clusterer = new ScreenClusterer();
    clusterer.begin(WIDTH, HEIGHT);

    const near = clusterer.offer(pixelMatrix(), 0, 0, 20_000_000, 100, 100, R);
    const far = clusterer.offer(pixelMatrix(), 0, 0, 20_000_000, 100, 100, -R);
    clusterer.resolve();

    expect(near).not.toBe(OFF_SCREEN);
    expect(far).toBe(OFF_SCREEN);
    expect(clusterer.state.onScreen).toBe(1);
  });

  it('treats an off-screen cell as ungrouped rather than throwing', () => {
    const { clusterer } = pass([atPixel(100, 100)]);

    expect(clusterer.grouped(OFF_SCREEN)).toBe(false);
  });

  it('splits movers a cell apart into different cells', () => {
    const { cells } = pass([atPixel(10, 10), atPixel(10 + CLUSTER_CELL_PX, 10)]);

    expect(cells[0]).not.toBe(cells[1]);
  });

  it('forgets the last pass when a new one begins', () => {
    const clusterer = new ScreenClusterer();
    pass([atPixel(100, 100), atPixel(101, 100), atPixel(102, 100)], clusterer);

    pass([atPixel(100, 100)], clusterer);

    expect(clusterer.state).toMatchObject({ onScreen: 1, individuals: 1, groups: 0, inGroups: 0 });
    expect([...clusterer.marks()]).toHaveLength(0);
  });

  it('refuses to hand out marks before the counts behind them exist', () => {
    // Returning marks without resolving would let a caller draw badges on the globe while the
    // rail read a group total of zero.
    const clusterer = new ScreenClusterer();
    clusterer.begin(WIDTH, HEIGHT);
    clusterer.offer(pixelMatrix(), 0, 0, 0, 100, 100, 0);

    expect(() => [...clusterer.marks()]).toThrow('resolve');
  });
});

/** Three positions a few kilometres apart on a sphere of this radius, all in one screen cell. */
function nearbyOnSphere(radiusM: number) {
  return Array.from({ length: CLUSTER_MIN_MEMBERS }, (_unused, index) => {
    const angle = index * 0.001;
    return [radiusM * Math.cos(angle), radiusM * Math.sin(angle), 0] as const;
  });
}

function markFor(points: readonly (readonly [number, number, number])[]) {
  // A matrix that collapses everything to one pixel, so the members land in one cell whatever
  // their earth-fixed coordinates are.
  const m = Array.from({ length: 16 }, () => 0);
  m[12] = 0;
  m[13] = 0;
  m[15] = 1;
  const clusterer = new ScreenClusterer();
  clusterer.begin(WIDTH, HEIGHT);
  for (const [x, y, z] of points) {
    clusterer.offer(m, 0, 0, 0, x, y, z);
  }
  clusterer.resolve();
  return [...clusterer.marks()][0]!;
}

describe('a cluster mark', () => {
  it('sits on one of its own members, not at an averaged point inside the globe', () => {
    // Two bugs in one assertion. The mean of points on a sphere is *inside* the sphere, because a
    // chord's midpoint is, and a badge placed there is swallowed by the globe's own depth buffer.
    // And a centroid can land anywhere in its cell, so neighbouring badges could end up almost on
    // top of each other: a whole-globe view came back with "703" and "55" overlapping into
    // nonsense. Anchoring to a real member fixes both.
    const radius = 6_771_000;
    const members = nearbyOnSphere(radius);

    const mark = markFor(members);

    expect(Math.hypot(mark.x, mark.y, mark.z)).toBeCloseTo(radius, 3);
    const onAMember = members.some(
      ([x, y, z]) =>
        Math.abs(x - mark.x) < 1e-6 && Math.abs(y - mark.y) < 1e-6 && Math.abs(z - mark.z) < 1e-6,
    );
    expect(onAMember).toBe(true);
  });

  it('keeps a satellite group at satellite altitude, not at sea level', () => {
    const low = markFor(nearbyOnSphere(6_771_000));
    const high = markFor(nearbyOnSphere(42_164_000));

    expect(Math.hypot(high.x, high.y, high.z)).toBeGreaterThan(Math.hypot(low.x, low.y, low.z) * 5);
  });

  it('picks the member closest to the middle of the cell', () => {
    // Which is what keeps badges about a cell apart. The member at the cell centre wins over one
    // out at its edge, however many are piled at the edge.
    const centre: [number, number, number] = [WIDTH / 2, HEIGHT / 2, 111];
    const clusterer = new ScreenClusterer(WIDTH, CLUSTER_MIN_MEMBERS);
    clusterer.begin(WIDTH, HEIGHT);
    const edge = crowd(CLUSTER_MIN_MEMBERS - 1, 40, 40);
    for (const point of edge) {
      clusterer.offer(pixelMatrix(), 0, 0, 0, point[0], point[1], point[2]);
    }
    clusterer.offer(pixelMatrix(), 0, 0, 0, centre[0], centre[1], centre[2]);
    clusterer.resolve();

    // One cell covering the whole canvas, so every offer lands in it and only the distance from
    // the centre decides which position the badge takes.
    expect([...clusterer.marks()][0]?.z).toBe(111);
  });

  it('bounds how far apart its members are, for the fly-to', () => {
    const members: [number, number, number][] = [
      [6_371_000, 0, 0],
      [6_371_000, 30_000, 0],
      [6_371_000, 0, 40_000],
      // Padding inside the same box, so the group reaches the minimum without widening it.
      ...Array.from(
        { length: CLUSTER_MIN_MEMBERS - 3 },
        (_unused, index) => [6_371_000, index * 10, index * 10] as [number, number, number],
      ),
    ];

    const mark = markFor(members);

    // The diagonal of the members' earth-fixed bounding box: a bound rather than a measurement,
    // and earth-fixed so it has no antimeridian to fall over.
    expect(mark.spreadM).toBeCloseTo(Math.hypot(30_000, 40_000), 3);
    expect(mark.count).toBe(CLUSTER_MIN_MEMBERS);
  });

  it('is found by its cell, and only while that cell is still a group', () => {
    const { clusterer, cells } = pass(crowd(CLUSTER_MIN_MEMBERS));
    const cell = cells[0]!;

    expect(clusterer.markFor(cell)?.count).toBe(CLUSTER_MIN_MEMBERS);
    expect(clusterer.markFor(cell + 1)).toBeNull();
  });
});

describe('cluster pick ids', () => {
  it('round-trips a layer and a cell', () => {
    const id = clusterPickId('military', 417);

    expect(id.startsWith(CLUSTER_PICK_PREFIX)).toBe(true);
    expect(parseClusterPickId(id)).toEqual({ layerKey: 'military', cellId: 417 });
  });

  it('refuses anything that is not one of ours, so a click routes to one layer', () => {
    expect(parseClusterPickId(null)).toBeNull();
    expect(parseClusterPickId('abc123')).toBeNull();
    expect(parseClusterPickId('satellite:25544')).toBeNull();
    expect(parseClusterPickId('city:2643743')).toBeNull();
  });

  it('refuses a malformed id rather than resolving it to cell zero', () => {
    // Same trap `noradFromPickId` had: `Number('')` is 0 and `Number.isSafeInteger(0)` is true,
    // so a bare prefix would read as a lookup that quietly finds nothing.
    expect(parseClusterPickId('cluster:')).toBeNull();
    expect(parseClusterPickId('cluster:vessels:')).toBeNull();
    expect(parseClusterPickId('cluster::4')).toBeNull();
    expect(parseClusterPickId('cluster:vessels:-1')).toBeNull();
    expect(parseClusterPickId('cluster:vessels:2.5')).toBeNull();
    expect(parseClusterPickId('cluster:vessels:abc')).toBeNull();
  });

  it('accepts cell zero, which is a real cell in the top-left corner', () => {
    expect(parseClusterPickId('cluster:aircraft:0')).toEqual({ layerKey: 'aircraft', cellId: 0 });
  });
});

describe('clusterCameraHeight', () => {
  it('never drops below the floor, so a tight group does not put the camera inside it', () => {
    expect(clusterCameraHeight(0)).toBe(CLUSTER_FLY_FLOOR_M);
    expect(clusterCameraHeight(100)).toBe(CLUSTER_FLY_FLOOR_M);
  });

  it('opens out for a group spread over a wider area', () => {
    expect(clusterCameraHeight(2_000_000)).toBeGreaterThan(2_000_000);
    expect(clusterCameraHeight(4_000_000)).toBeGreaterThan(clusterCameraHeight(2_000_000));
  });
});

/** Where a badge actually lands: the anchor member's pixel plus the nudge. */
function drawnAt(points: readonly (readonly [number, number, number])[], min = 2) {
  const { clusterer } = pass(points, new ScreenClusterer(CLUSTER_CELL_PX, min));
  return [...clusterer.marks()].map((mark) => ({
    cellId: mark.cellId,
    count: mark.count,
    // `pixelMatrix` maps world x,y straight to screen pixels, so the anchor's pixel is its x,y.
    x: mark.x + mark.nudgeX,
    y: mark.y + mark.nudgeY,
    size: clusterBadgePx(mark.count),
  }));
}

describe('the badge nudge', () => {
  it('puts the badge on its cell centre wherever inside the cell the members sit', () => {
    // Two groups in one cell's worth of space, offered at opposite corners of that cell. Both must
    // come out at the same drawn point, because both are the same cell.
    const cell = CLUSTER_CELL_PX;
    const lowCorner = drawnAt([
      atPixel(2 * cell + 1, 2 * cell + 1),
      atPixel(2 * cell + 2, 2 * cell + 1),
    ]);
    const highCorner = drawnAt([
      atPixel(3 * cell - 2, 3 * cell - 2),
      atPixel(3 * cell - 3, 3 * cell - 2),
    ]);

    expect(lowCorner[0]?.x).toBeCloseTo(2.5 * cell, 6);
    expect(lowCorner[0]?.y).toBeCloseTo(2.5 * cell, 6);
    expect(highCorner[0]?.x).toBeCloseTo(lowCorner[0]?.x ?? -1, 6);
    expect(highCorner[0]?.y).toBeCloseTo(lowCorner[0]?.y ?? -1, 6);
  });

  it('never lets two badges overlap, however the members are arranged', () => {
    // The property the nudge exists for, tested where it used to fail: members pressed against the
    // edge they share. Before the nudge these two badges were drawn a couple of pixels apart.
    const cell = CLUSTER_CELL_PX;
    const edge = 5 * cell;
    const badges = drawnAt([
      atPixel(edge - 2, edge + 10),
      atPixel(edge - 1, edge + 10),
      atPixel(edge + 1, edge + 10),
      atPixel(edge + 2, edge + 10),
    ]);

    expect(badges).toHaveLength(2);
    const [a, b] = badges;
    const gap = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
    expect(gap).toBeGreaterThanOrEqual(((a?.size ?? 0) + (b?.size ?? 0)) / 2);
  });

  it('holds for every badge size, because the lattice is what guarantees it', () => {
    // Two badges are at worst one cell apart centre to centre, so the largest badge being narrower
    // than a cell is what makes overlap impossible. `palette.test.ts` asserts that relationship; this
    // asserts the spacing that relies on it, across the whole range of counts a badge can carry.
    for (const count of [2, 5, 20, 100, 5000]) {
      expect(clusterBadgePx(count)).toBeLessThan(CLUSTER_CELL_PX);
    }
  });

  it('is zero when the anchor already sits on the cell centre', () => {
    const cell = CLUSTER_CELL_PX;
    const centre = 4.5 * cell;
    const { clusterer } = pass(
      [atPixel(centre, centre), atPixel(centre + 1, centre + 1)],
      new ScreenClusterer(CLUSTER_CELL_PX, 2),
    );

    const mark = [...clusterer.marks()][0];

    expect(mark?.nudgeX).toBeCloseTo(0, 6);
    expect(mark?.nudgeY).toBeCloseTo(0, 6);
  });

  it('moves a badge by less than half a cell diagonal, so it stays over its own members', () => {
    // The cost side of the trade. A badge that could wander further than its own cell would be
    // pointing at ground none of its members are on.
    const limit = (CLUSTER_CELL_PX / 2) * Math.SQRT2;
    for (const offset of [0, 1, 13, 27, 41, 55]) {
      const { clusterer } = pass(
        crowd(3, 200 + offset, 200 + offset),
        new ScreenClusterer(CLUSTER_CELL_PX, 2),
      );
      const mark = [...clusterer.marks()][0];
      expect(Math.hypot(mark?.nudgeX ?? 0, mark?.nudgeY ?? 0)).toBeLessThanOrEqual(limit);
    }
  });
});
