/**
 * Tests for the mover marks.
 *
 * Nothing here needs a canvas, a document or a WebGL context, which is the whole reason the
 * icons are SVG strings rather than drawn to a canvas: the geometry and the markup are both
 * plain data and can be asserted directly.
 *
 * Most of what follows is a design rule turned into a check. A mark that points nowhere has
 * to look the same whichever way up it is drawn, a mark that does point has to be
 * symmetrical about its own nose, and every vertex has to stay inside the disc the selection
 * halo goes round. Those are the three things that break silently: the drawing still
 * appears, it is just wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  ICON_CENTRE,
  ICON_SILHOUETTES,
  SILHOUETTE_RADIUS,
  casingPixels,
  iconImage,
  iconPath,
  iconSvg,
  orientAxis,
  pinTipOffsetPx,
} from './icons';
import type { IconPoint, IconShape } from './icons';
import { SELECTION_COLOUR } from './palette';

const ALL_SHAPES = Object.keys(ICON_SILHOUETTES) as IconShape[];

/** The marks that point along a reported bearing. */
const DIRECTIONAL: IconShape[] = ['plane', 'ship', 'vehicle'];

/** The marks drawn when there is no bearing to point along. */
const UNDIRECTED: IconShape[] = ['disc', 'block', 'diamond'];

/**
 * The marks that claim one exact place rather than a direction or an area.
 *
 * A third category, and the reason it exists is that a pin is neither of the other two: it does not
 * turn to a bearing, and it must not be symmetric, because the tip is the whole assertion. A pin
 * drawn upside down still looks like a pin and would point at the wrong place, which is the kind of
 * mistake nothing else here would catch.
 */
const ANCHORED: IconShape[] = ['pin'];

/** The smallest size any layer *authors* a mark at, from `layers/satellites.ts`. */
const SMALLEST_MARK_PX = 18;

function radius([x, y]: IconPoint): number {
  return Math.hypot(x - ICON_CENTRE, y - ICON_CENTRE);
}

/** True when `points` contains something within a hundredth of a unit of `target`. */
function contains(points: readonly IconPoint[], target: IconPoint): boolean {
  return points.some(([x, y]) => Math.abs(x - target[0]) < 0.01 && Math.abs(y - target[1]) < 0.01);
}

describe('the silhouettes', () => {
  it('has one for every shape in the type, and every one is a closed polygon', () => {
    expect(ALL_SHAPES.length).toBe(7);
    for (const shape of ALL_SHAPES) {
      expect(ICON_SILHOUETTES[shape].length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps every vertex inside the disc the selection halo goes round', () => {
    // The halo is one circle for all five marks. A vertex outside this radius would poke
    // through the white ring, which is the sort of thing that looks like a rendering bug
    // rather than a geometry mistake.
    for (const shape of ALL_SHAPES) {
      const points = ICON_SILHOUETTES[shape];
      for (const point of points) {
        expect(radius(point)).toBeLessThanOrEqual(SILHOUETTE_RADIUS + 0.01);
      }
    }
  });

  it('fills the disc it is given, so no mark is quietly smaller than the others', () => {
    for (const shape of ALL_SHAPES) {
      const reach = Math.max(...ICON_SILHOUETTES[shape].map((point) => radius(point)));
      expect(reach).toBeGreaterThan(SILHOUETTE_RADIUS * 0.9);
    }
  });

  it('points a directional mark at the top of the image, centred on the centreline', () => {
    // `alignedAxis` turns the image so its top follows the direction of travel, so a front drawn
    // anywhere else points the mover somewhere it is not going.
    //
    // The front is tested as an edge rather than as a single vertex. A plan-view aircraft and a
    // hull come to a point, but a road or rail vehicle is flat-fronted and has two topmost
    // vertices, and demanding one would have been a rule about the first two shapes rather than
    // about pointing. What has to hold either way is that whatever is at the top is centred: an
    // off-centre or sideways front is the mistake worth catching.
    for (const shape of DIRECTIONAL) {
      const points = ICON_SILHOUETTES[shape];
      const highest = Math.min(...points.map(([, y]) => y));
      const front = points.filter(([, y]) => y === highest);
      expect(front.length).toBeGreaterThan(0);
      const middle = front.reduce((sum, [x]) => sum + x, 0) / front.length;
      expect(middle).toBeCloseTo(ICON_CENTRE, 6);
      expect(highest).toBeLessThan(ICON_CENTRE);
      // And the front is genuinely the narrow end, so the taper reads as a direction rather than
      // the shape being symmetrical end to end.
      const lowest = Math.max(...points.map(([, y]) => y));
      const back = points.filter(([, y]) => y === lowest);
      const frontWidth = Math.max(...front.map(([x]) => x)) - Math.min(...front.map(([x]) => x));
      const backWidth = Math.max(...back.map(([x]) => x)) - Math.min(...back.map(([x]) => x));
      expect(frontWidth).toBeLessThan(backWidth);
    }
  });

  it('makes a directional mark symmetrical about its own nose', () => {
    // An aircraft with one wing longer than the other reads as a rendering fault, and a
    // hand-typed vertex list is exactly where that happens.
    for (const shape of DIRECTIONAL) {
      const points = ICON_SILHOUETTES[shape];
      for (const [x, y] of points) {
        expect(contains(points, [2 * ICON_CENTRE - x, y])).toBe(true);
      }
    }
  });

  it('leaves an undirected mark looking the same at every quarter turn', () => {
    // This is what stops a fallback mark implying a bearing nobody reported. A quarter turn
    // about the centre maps (x, y) to (100 - y, x).
    for (const shape of UNDIRECTED) {
      const points = ICON_SILHOUETTES[shape];
      for (const [x, y] of points) {
        expect(contains(points, [2 * ICON_CENTRE - y, x])).toBe(true);
      }
    }
  });

  it('puts an anchored mark tip down, on the centreline, and nowhere else', () => {
    // The tip is the claim: this exact point. Upside down or off-centre it points at somewhere
    // nobody reported, and it would still look like a pin.
    for (const shape of ANCHORED) {
      const points = ICON_SILHOUETTES[shape];
      const lowest = Math.max(...points.map(([, y]) => y));
      const tip = points.filter(([, y]) => y === lowest);
      expect(tip).toEqual([[ICON_CENTRE, lowest]]);
      expect(lowest).toBeGreaterThan(ICON_CENTRE);
      // Mirror-symmetric about its own tip, so it cannot lean.
      for (const [x, y] of points) {
        expect(contains(points, [2 * ICON_CENTRE - x, y])).toBe(true);
      }
    }
  });

  it('never makes an anchored mark look like one that points nowhere', () => {
    // If a pin were symmetric at quarter turns it would be indistinguishable from the marks that
    // exist precisely to avoid claiming a direction, and the tip would mean nothing.
    for (const shape of ANCHORED) {
      const points = ICON_SILHOUETTES[shape];
      const quarterTurned = points.every(([x, y]) => contains(points, [2 * ICON_CENTRE - y, x]));
      expect(quarterTurned).toBe(false);
    }
  });

  it('sorts every shape into exactly one of the three kinds', () => {
    // A shape nobody categorised is a shape none of the rules above apply to.
    const categorised = [...DIRECTIONAL, ...UNDIRECTED, ...ANCHORED];
    expect(categorised.toSorted((a, b) => a.localeCompare(b))).toEqual(
      ALL_SHAPES.toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it('gives every shape a different outline, so colour is never the only cue', () => {
    const outlines = ALL_SHAPES.map((shape) => iconPath(ICON_SILHOUETTES[shape]));

    expect(new Set(outlines).size).toBe(outlines.length);
  });
});

describe('iconPath', () => {
  it('writes a closed path through every vertex in order', () => {
    expect(
      iconPath([
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
    ).toBe('M1 2L3 4L5 6Z');
  });
});

describe('iconSvg', () => {
  it('declares its own pixel size, which is what an image element rasterises at', () => {
    // Without width and height an SVG in an img element has no intrinsic size and Cesium
    // gets a zero-by-zero texture, which draws nothing and reports nothing.
    const svg = iconSvg('plane', '#4da3ff', false, 26);

    expect(svg).toContain('width="26"');
    expect(svg).toContain('height="26"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('draws the casing before the fill, so the black stays outside the shape', () => {
    // The casing is a stroke centred on the outline. Painted after the fill it would eat
    // half its width into the mark instead of adding to it, and every silhouette would come
    // out thinner and darker than it was drawn.
    const svg = iconSvg('ship', '#2ec8d8', false, 22);
    const casing = svg.indexOf('stroke-width');
    const fill = svg.indexOf('fill="#2ec8d8"');

    expect(casing).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(casing);
  });

  it('carries the requested colour and a black casing', () => {
    const svg = iconSvg('block', '#4d6373', false, 22);

    expect(svg).toContain('fill="#4d6373"');
    expect(svg).toContain('stroke="#000000"');
  });

  it('adds the selection halo, in the app selection colour, only when selected', () => {
    const plain = iconSvg('diamond', '#7fe3ff', false, 18);
    const chosen = iconSvg('diamond', '#7fe3ff', true, 36);

    expect(plain).not.toContain('<circle');
    expect(plain).not.toContain(SELECTION_COLOUR);
    // Two circles: the white ring and the black casing that keeps it readable over cloud as
    // well as over ocean.
    expect(chosen.match(/<circle/g)).toHaveLength(2);
    expect(chosen).toContain(`stroke="${SELECTION_COLOUR}"`);
  });

  it('widens the view box for the halo rather than shrinking the mark inside it', () => {
    const plain = iconSvg('plane', '#4da3ff', false, 26);
    const chosen = iconSvg('plane', '#4da3ff', true, 48);

    expect(plain).toContain('viewBox="2 2 96 96"');
    expect(chosen).toContain('viewBox="-30 -30 160 160"');
  });
});

describe('iconImage', () => {
  it('returns a self-contained data URL, with no fetch anywhere in it', () => {
    // This project runs on one laptop with no CDN. An icon that has to be fetched is an
    // icon that is missing.
    const url = iconImage('plane', '#4da3ff', false, 26);

    expect(url.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(url.slice('data:image/svg+xml,'.length))).toBe(
      iconSvg('plane', '#4da3ff', false, 26),
    );
  });

  it('hands back the same string for the same mark, which is the texture atlas contract', () => {
    // Cesium keys its billboard atlas on the image id. A fresh string per call would put one
    // atlas entry on the GPU per mover, so this identity is a performance guarantee and not
    // a tidiness one.
    const first = iconImage('ship', '#2ec8d8', false, 22);
    const second = iconImage('ship', '#2ec8d8', false, 22);

    expect(second).toBe(first);
  });

  it('keeps shape, colour, selection and size apart in the cache', () => {
    const base = iconImage('ship', '#2ec8d8', false, 22);

    expect(iconImage('block', '#2ec8d8', false, 22)).not.toBe(base);
    expect(iconImage('ship', '#4d6373', false, 22)).not.toBe(base);
    expect(iconImage('ship', '#2ec8d8', true, 22)).not.toBe(base);
    expect(iconImage('ship', '#2ec8d8', false, 40)).not.toBe(base);
  });
});

describe('the casing', () => {
  it('is thick enough to hold contrast over cloud at the smallest size authored', () => {
    // Some of the people this is shown to have poor vision, and the basemap is half dark
    // ocean and half bright cloud. Under about a pixel and a half the black edge stops
    // separating the mark from the cloud behind it and the layer looks broken over land.
    //
    // The authored size is the floor. Every layer shrinks its marks with camera distance and
    // that deliberately goes below this, but it is bounded from below by the size a mark is
    // drawn at when the camera is close enough for anyone to be reading one.
    expect(casingPixels(SMALLEST_MARK_PX)).toBeGreaterThanOrEqual(1.5);
  });
});

describe('orientAxis', () => {
  const scratch = { x: 0, y: 0, z: 0 };

  it('writes into the vector it is given and returns it, allocating nothing', () => {
    const returned = orientAxis(0, 0, 0, scratch);

    expect(returned).toBe(scratch);
  });

  it('gives a unit vector, so no normalise step is needed downstream', () => {
    for (const lat of [-89, -45, 0, 12.5, 51.5, 89]) {
      for (const lon of [-179, -90, 0, 45, 179]) {
        for (const bearing of [0, 37, 90, 180, 271, 359]) {
          const axis = orientAxis(lon, lat, bearing, { x: 0, y: 0, z: 0 });
          expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it('points due north along the earth-fixed polar axis, on the equator at the prime meridian', () => {
    const axis = orientAxis(0, 0, 0, { x: 0, y: 0, z: 0 });

    expect(axis.x).toBeCloseTo(0, 12);
    expect(axis.y).toBeCloseTo(0, 12);
    expect(axis.z).toBeCloseTo(1, 12);
  });

  it('points due east along the earth-fixed y axis from the same place', () => {
    const axis = orientAxis(0, 0, 90, { x: 0, y: 0, z: 0 });

    expect(axis.x).toBeCloseTo(0, 12);
    expect(axis.y).toBeCloseTo(1, 12);
    expect(axis.z).toBeCloseTo(0, 12);
  });

  it('turns clockwise from north, which is how a bearing is defined', () => {
    // South and west, the other two cardinals, so a sign error in either term shows up.
    const south = orientAxis(0, 0, 180, { x: 0, y: 0, z: 0 });
    const west = orientAxis(0, 0, 270, { x: 0, y: 0, z: 0 });

    expect(south.z).toBeCloseTo(-1, 12);
    expect(west.y).toBeCloseTo(-1, 12);
  });

  it('tilts north away from the pole with latitude, rather than staying axis-parallel', () => {
    // Local north at 45 degrees north on the prime meridian leans away from the earth's
    // axis by exactly the latitude. A version of this that ignored latitude would pass every
    // equator test above and point every aircraft in Europe the wrong way.
    const axis = orientAxis(0, 45, 0, { x: 0, y: 0, z: 0 });

    expect(axis.x).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(axis.y).toBeCloseTo(0, 12);
    expect(axis.z).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('follows the meridian round, so longitude is not ignored either', () => {
    // Due north at the equator on the 90th meridian east points along the polar axis too,
    // but due east there points along negative x. Longitude dropped from the east term would
    // put every eastbound aircraft in Asia on a western heading.
    const axis = orientAxis(90, 0, 90, { x: 0, y: 0, z: 0 });

    expect(axis.x).toBeCloseTo(-1, 12);
    expect(axis.y).toBeCloseTo(0, 12);
    expect(axis.z).toBeCloseTo(0, 12);
  });
});

/**
 * Measure the painted extent of a pin out of its own SVG, rather than trusting the constants.
 *
 * The offset exists to put the pin's drawn tip on the coordinate, so the only honest check is
 * against the markup that gets drawn: parse the view box and the lowest vertex out of the SVG and
 * work out where the painted tip actually falls inside the image. A test that recomputed the same
 * expression as the implementation would pass whatever either of them said.
 */
function paintedTipFromBottom(sizePx: number, selected: boolean): number {
  const svg = iconSvg('pin', '#ffffff', selected, sizePx);
  const box = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  const casing = /stroke-width="([\d.]+)"[^>]*stroke-linejoin/.exec(svg);
  if (box === null || casing === null) {
    throw new Error('the pin svg did not carry a view box and a cased path');
  }
  const top = Number(box[2]);
  const units = Number(box[4]);
  const path = /<path d="([^"]+)"/.exec(svg)?.[1] ?? '';
  let lowest = -Infinity;
  for (const vertex of path.matchAll(/[ML] ?[\d.-]+ ([\d.-]+)/g)) {
    lowest = Math.max(lowest, Number(vertex[1]));
  }
  // Half the casing stroke is painted outside the outline, so that is where the drawn tip ends.
  const paintedTip = lowest + Number(casing[1]) / 2;
  return ((top + units - paintedTip) / units) * sizePx;
}

describe('pinTipOffsetPx', () => {
  it('lands the drawn tip on the coordinate for a normal mark', () => {
    for (const sizePx of [16, 20, 26, 32]) {
      expect(pinTipOffsetPx(sizePx, false)).toBeCloseTo(paintedTipFromBottom(sizePx, false), 9);
    }
  });

  it('lands the drawn tip on the coordinate for a selected mark too', () => {
    // The halo widens the view box, so the same pin sits differently inside its own image and the
    // offset is a different fraction of the drawn size. This is the case that was wrong.
    for (const sizePx of [36, 46, 56]) {
      expect(pinTipOffsetPx(sizePx, true)).toBeCloseTo(paintedTipFromBottom(sizePx, true), 9);
    }
  });

  it('needs a much larger nudge when selected, which is why one figure cannot serve both', () => {
    expect(pinTipOffsetPx(46, true) / 46).toBeGreaterThan((pinTipOffsetPx(46, false) / 46) * 5);
  });

  it('scales with the mark, so the tip stays put down the whole distance ramp', () => {
    expect(pinTipOffsetPx(52, false)).toBeCloseTo(pinTipOffsetPx(26, false) * 2, 9);
    expect(pinTipOffsetPx(0, false)).toBe(0);
  });

  it('nudges down rather than up, and by less than the mark is tall', () => {
    // Sign and magnitude. Cesium screen offsets are y-down, so a positive value moves the mark
    // towards the bottom of the screen, and an offset larger than the mark would put the image
    // entirely below the point it describes.
    for (const selected of [false, true]) {
      expect(pinTipOffsetPx(26, selected)).toBeGreaterThan(0);
      expect(pinTipOffsetPx(26, selected)).toBeLessThan(26);
    }
  });
});
