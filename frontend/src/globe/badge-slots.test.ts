/**
 * Tests for the shared badge lattice.
 *
 * The property that matters is not "a badge gets a point" but "two layers never get the same point",
 * because the failure it exists to stop is silent: two badges drawn on the identical pixel look like
 * one badge with one count, and a viewer has no way to tell that a second layer's number is under it.
 * So most of this file is about what happens on the second and third claim, not the first.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CLUSTER_CELL_PX } from './cluster';
import { badgeSlots } from './badge-slots';
import type { BadgeSlot } from './badge-slots';
import { clusterBadgePx } from './palette';

const WIDTH = 1600;
const HEIGHT = 1000;

/** Claim a point and get the answer back as a fresh object, so a caller cannot alias the scratch. */
function claim(layer: string, x: number, y: number): BadgeSlot {
  const out: BadgeSlot = { x: 0, y: 0 };
  badgeSlots.claim(layer, x, y, out);
  return { x: out.x, y: out.y };
}

/** The centre of the cell holding this pixel, which is what an uncontested claim returns. */
function centreOf(x: number, y: number): BadgeSlot {
  return {
    x: (Math.floor(x / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX,
    y: (Math.floor(y / CLUSTER_CELL_PX) + 0.5) * CLUSTER_CELL_PX,
  };
}

beforeEach(() => {
  badgeSlots.reset();
  badgeSlots.begin(WIDTH, HEIGHT, CLUSTER_CELL_PX);
});

describe('an uncontested claim', () => {
  it('returns the centre of the cell asked for', () => {
    expect(claim('aircraft', 300, 400)).toEqual(centreOf(300, 400));
  });

  it('snaps anywhere in a cell to the same point, so the lattice is the lattice', () => {
    const cell = CLUSTER_CELL_PX;
    const low = claim('aircraft', 5 * cell + 1, 5 * cell + 1);
    badgeSlots.release('aircraft');
    const high = claim('aircraft', 6 * cell - 1, 6 * cell - 1);

    expect(low).toEqual(high);
  });
});

describe('a contested claim', () => {
  it('gives the second layer a different point', () => {
    const first = claim('aircraft', 300, 400);
    const second = claim('vessels', 300, 400);

    expect(second).not.toEqual(first);
  });

  it('keeps every layer far enough apart that the widest badge cannot reach', () => {
    // The guarantee, and it rests on the lattice rather than on any distance arithmetic: points are a
    // cell apart and the widest badge is narrower than a cell.
    const points = ['aircraft', 'military', 'vessels', 'transit', 'social'].map((layer) =>
      claim(layer, 300, 400),
    );
    const widest = clusterBadgePx(Number.MAX_SAFE_INTEGER);

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        const gap = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
        expect(gap).toBeGreaterThanOrEqual(widest);
      }
    }
  });

  it('moves sideways before it moves up or down', () => {
    // A displaced badge reads better beside the data it counts than above it, and this is the only
    // test that holds that decision. The order is otherwise invisible.
    const first = claim('aircraft', 300, 400);
    const second = claim('vessels', 300, 400);

    expect(second.y).toBe(first.y);
    expect(Math.abs(second.x - first.x)).toBe(CLUSTER_CELL_PX);
  });

  it('gives the same layer its point back rather than shuffling it along', () => {
    // Two badges of one layer never contend, because a layer releases before it claims. Without that
    // a layer would displace itself every frame and its badges would crawl across the map.
    const before = claim('aircraft', 300, 400);
    badgeSlots.release('aircraft');
    const after = claim('aircraft', 300, 400);

    expect(after).toEqual(before);
  });

  it('falls back to the wanted point when everything near it is taken', () => {
    // A badge on top of another is bad. A badge flung across the map away from what it counts, or not
    // drawn at all, is worse. Twenty-five layers is far past anything real. Note it gives back the
    // wanted cell's *centre*, not the raw pixel: every answer is a lattice point.
    const wanted = centreOf(500, 500);
    for (let i = 0; i < 40; i += 1) {
      claim(`layer${i}`, 500, 500);
    }

    expect(claim('one-too-many', 500, 500)).toEqual(wanted);
  });
});

describe('reserve, for a label a badge must not sit on', () => {
  it('pushes a badge off the point a label occupies', () => {
    // The whole point of it. A city label sits on a fixed geographic point and reading it is its job;
    // a badge is a count over an area and has always been free to move. So the badge yields.
    const wanted = claim('probe', 300, 400);
    badgeSlots.release('probe');
    badgeSlots.reserve('cities', 300, 400, 10, 10);

    expect(claim('transit', 300, 400)).not.toEqual(wanted);
  });

  it('takes more than one point for a label wider than a cell', () => {
    // "Moscow" at 13 pixels runs to about 55, which is a cell and part of the next. Reserving only
    // the centre would leave a badge sitting on the second half of the word.
    badgeSlots.reset();
    badgeSlots.begin(WIDTH, HEIGHT, CLUSTER_CELL_PX);

    const narrow = badgeSlots.reserve('cities', 300, 400, 8, 8);
    badgeSlots.release('cities');
    const wide = badgeSlots.reserve('cities', 300, 400, 55, 13);

    expect(narrow).toBe(1);
    expect(wide).toBeGreaterThan(1);
  });

  it('reports how many points it took, and takes none when it is off the lattice', () => {
    badgeSlots.reset();

    expect(badgeSlots.reserve('cities', 300, 400, 55, 13)).toBe(0);
  });

  it('never steals a point another layer is already drawing on', () => {
    // First holder wins. A reservation arriving after a badge has claimed its point must not move a
    // badge that is already placed, because the layers run in an order nobody controls and a
    // reservation that could evict would make the badge positions depend on that order.
    const held = claim('transit', 300, 400);

    const taken = badgeSlots.reserve('cities', 300, 400, 8, 8);

    expect(taken).toBe(0);
    expect(claim('transit-again', 300, 400)).not.toEqual(held);
  });

  it('is released like any other holding, so a label leaving frees its points', () => {
    const wanted = claim('probe', 700, 500);
    badgeSlots.release('probe');
    badgeSlots.reserve('cities', 700, 500, 8, 8);

    badgeSlots.release('cities');

    expect(claim('transit', 700, 500)).toEqual(wanted);
  });

  it('clips to the lattice rather than reserving off screen', () => {
    // A label against the left edge has half its box outside the viewport, and a negative column
    // would index behind the start of the map.
    badgeSlots.reset();
    badgeSlots.begin(WIDTH, HEIGHT, CLUSTER_CELL_PX);

    const taken = badgeSlots.reserve('cities', 4, 4, 120, 40);

    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThanOrEqual(3 * 2);
  });
});

describe('release', () => {
  it('frees only the releasing layer', () => {
    const air = claim('aircraft', 300, 400);
    const ves = claim('vessels', 300, 400);

    badgeSlots.release('vessels');

    // The freed point goes to whoever asks next, and the held one still does not.
    expect(claim('transit', 300, 400)).toEqual(ves);
    expect(claim('social', 300, 400)).not.toEqual(air);
  });

  it('frees every point one layer holds, not just the last', () => {
    claim('transit', 100, 100);
    claim('transit', 300, 300);
    claim('transit', 500, 500);
    expect(badgeSlots.claimed).toBe(3);

    badgeSlots.release('transit');

    expect(badgeSlots.claimed).toBe(0);
  });

  it('is harmless for a layer holding nothing', () => {
    claim('aircraft', 300, 400);

    badgeSlots.release('a-layer-that-never-drew');

    expect(badgeSlots.claimed).toBe(1);
  });
});

describe('begin', () => {
  it('drops every claim when the viewport changes, because the points have moved', () => {
    claim('aircraft', 300, 400);
    claim('vessels', 300, 400);

    badgeSlots.begin(900, 700, CLUSTER_CELL_PX);

    expect(badgeSlots.claimed).toBe(0);
  });

  it('drops every claim when the cell size changes', () => {
    claim('aircraft', 300, 400);

    badgeSlots.begin(WIDTH, HEIGHT, CLUSTER_CELL_PX * 2);

    expect(badgeSlots.claimed).toBe(0);
  });

  it('keeps claims when nothing changed, or every layer would wipe the others every frame', () => {
    // The one that makes the design work. Five layers call `begin` per frame and only the first of
    // them is doing anything; if it cleared unconditionally, layer five would erase layers one to
    // four and the collisions would come straight back.
    claim('aircraft', 300, 400);

    badgeSlots.begin(WIDTH, HEIGHT, CLUSTER_CELL_PX);
    badgeSlots.begin(WIDTH, HEIGHT, CLUSTER_CELL_PX);

    expect(badgeSlots.claimed).toBe(1);
  });
});

describe('edges', () => {
  it('never hands out a point off screen', () => {
    // A badge on the boundary has neighbours outside the viewport, and those must not be offered.
    for (const [x, y] of [
      [1, 1],
      [WIDTH - 1, 1],
      [1, HEIGHT - 1],
      [WIDTH - 1, HEIGHT - 1],
    ]) {
      badgeSlots.release('a');
      badgeSlots.release('b');
      claim('a', x ?? 0, y ?? 0);
      const pushed = claim('b', x ?? 0, y ?? 0);
      expect(pushed.x).toBeGreaterThan(0);
      expect(pushed.y).toBeGreaterThan(0);
      expect(pushed.x).toBeLessThan(WIDTH);
      expect(pushed.y).toBeLessThan(HEIGHT);
    }
  });

  it('answers with the wanted point when no geometry has been declared', () => {
    // Defensive rather than reachable: a layer always calls `begin` first. Returning the wanted point
    // means a mistake here shows up as the old collision rather than as a badge at the origin.
    badgeSlots.reset();

    expect(claim('aircraft', 321, 654)).toEqual({ x: 321, y: 654 });
  });
});
