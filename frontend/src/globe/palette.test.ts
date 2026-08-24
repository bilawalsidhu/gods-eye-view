import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLUSTER_CELL_PX } from './cluster';
import {
  AIRCRAFT_EMERGENCY_ICON_PX,
  AIRCRAFT_ICON_PX,
  AIRCRAFT_SELECTED_ICON_PX,
  CLASS_COLOURS,
  CLASS_LABELS,
  CLUSTER_ALERT_FILL,
  CLUSTER_ALERT_TEXT,
  CLUSTER_CASING,
  CLUSTER_FILL,
  CLUSTER_TEXT,
  EMERGENCY_COLOUR,
  FONT_STEPS,
  GLYPH_WIDTH_RATIO,
  SMALLEST_FONT_PX,
  SOCIAL_COLOUR,
  TRANSIT_COLOUR,
  badgeInnerPx,
  clusterBadgePx,
  clusterBadgeText,
  clusterFontPx,
  colourFor,
  contrastRatio,
  iconSizeFor,
  relativeLuminance,
} from './palette';
import { BADGE_FILL_OPACITY, clusterBadgeImage } from './icons';

/**
 * The class list is read from the committed contract rather than repeated here.
 *
 * That is what makes this a totality check: a class added to the backend enum arrives in
 * `openapi.json`, and a missing colour fails here instead of rendering as an invisible
 * point on the globe.
 */
function contractAircraftClasses(): string[] {
  // Relative to the frontend workspace root, which is where vitest runs.
  const contract = path.resolve(process.cwd(), '../openapi.json');
  const schema = JSON.parse(readFileSync(contract, 'utf8')) as {
    components: { schemas: { AircraftClass: { enum: string[] } } };
  };
  return schema.components.schemas.AircraftClass.enum;
}

describe('the class palette', () => {
  it('covers every aircraft class in the contract', () => {
    const classes = contractAircraftClasses();

    const expected = classes.toSorted((left, right) => left.localeCompare(right));

    expect(classes.length).toBeGreaterThan(0);
    expect(Object.keys(CLASS_COLOURS).toSorted((a, b) => a.localeCompare(b))).toEqual(expected);
    expect(Object.keys(CLASS_LABELS).toSorted((a, b) => a.localeCompare(b))).toEqual(expected);
  });

  it('gives every class its own hue, so two classes are never confusable', () => {
    const hues = Object.values(CLASS_COLOURS);

    expect(new Set(hues).size).toBe(hues.length);
  });

  it('reserves the alert colour, so nothing routine is drawn in red', () => {
    expect(Object.values(CLASS_COLOURS)).not.toContain(EMERGENCY_COLOUR);
  });

  it('paints an emergency red whatever the class', () => {
    for (const aircraftClass of Object.keys(CLASS_COLOURS) as (keyof typeof CLASS_COLOURS)[]) {
      expect(colourFor(aircraftClass, true)).toBe(EMERGENCY_COLOUR);
      expect(colourFor(aircraftClass, false)).toBe(CLASS_COLOURS[aircraftClass]);
    }
  });

  it('also encodes an emergency in size, because colour alone is not accessible', () => {
    expect(iconSizeFor(true, false)).toBe(AIRCRAFT_EMERGENCY_ICON_PX);
    expect(AIRCRAFT_EMERGENCY_ICON_PX).toBeGreaterThan(AIRCRAFT_ICON_PX);
  });

  it('draws a selected aircraft larger than an unselected one', () => {
    expect(iconSizeFor(false, true)).toBeGreaterThan(iconSizeFor(false, false));
  });

  it('never shrinks an emergency by selecting it', () => {
    // Selection wins the size here, which is the reverse of the old point sizing. It is
    // only safe because the selected mark keeps the red fill: the alert survives in hue and
    // in the halo, so a bigger mark cannot dress it down.
    expect(iconSizeFor(true, true)).toBe(AIRCRAFT_SELECTED_ICON_PX);
    expect(AIRCRAFT_SELECTED_ICON_PX).toBeGreaterThan(AIRCRAFT_EMERGENCY_ICON_PX);
  });

  it('draws every mark large enough to read, for an audience that may not see well', () => {
    // The old dot was seven pixels. A silhouette needs enough pixels to still be one, and
    // this is the assertion that stops a later tidy-up shrinking them back.
    expect(AIRCRAFT_ICON_PX).toBeGreaterThanOrEqual(20);
  });
});

/**
 * The widest string of one, two, three and four characters at each font size the ladder offers.
 *
 * Measured in a real browser against `700 <size>px system-ui`, the font `BADGE_FONT_FAMILY` resolves
 * to, taking the worst of all-digits and digits-plus-suffix. Literals on purpose: a test that asked
 * `palette.ts` how wide its own text was would agree with itself whatever it said.
 */
const MEASURED_TEXT_PX: Record<number, readonly number[]> = {
  11: [7.7, 18, 25.5, 33.1],
  12: [8.4, 19.4, 27.6, 35.8],
  14: [9.6, 22.4, 31.8, 41.2],
  16: [10.8, 25.3, 35.9, 46.5],
};

/**
 * The usable flat run across each badge width, in pixels.
 *
 * The badge is a flat-top hexagon of radius 42 in a 96-unit box with a 16-wide casing, half of it
 * painted outside the outline, so the run is `badgePx * 2 * (42 - 8) / 96`. Written out rather than
 * computed for the same reason as the widths above.
 */
const MEASURED_INNER_PX: Record<number, number> = {
  30: 21.25,
  38: 26.91,
  48: 34,
  52: 36.83,
};

/**
 * The colour each layer draws its own marks in, which is also what `main.ts` hands the rail as that
 * row's legend mark. Listed here so a badge casing can be checked against the association a viewer
 * is being taught, rather than merely against itself.
 */
const LAYER_COLOURS: readonly (readonly [string, string])[] = [
  ['aircraft', CLASS_COLOURS.unknown],
  ['military', CLASS_COLOURS.military],
  ['vessels', '#2ec8d8'],
  ['satellites', '#7fe3ff'],
  ['transit', TRANSIT_COLOUR],
  ['social', SOCIAL_COLOUR],
];

/** Extremes of the NASA basemap: deep ocean, the brightest cloud, and Sahara sand. */
const BASEMAP = { ocean: '#0b1a2b', cloud: '#f2f4f6', desert: '#c8a86a' };

/** The body colour a viewer actually sees, once the casing bleeds through at the body's opacity. */
function tintedFill(casing: string): string {
  const mix = (at: number) => {
    const fill = Number.parseInt(CLUSTER_FILL.replace('#', '').slice(at, at + 2), 16);
    const rim = Number.parseInt(casing.replace('#', '').slice(at, at + 2), 16);
    return Math.round(fill * BADGE_FILL_OPACITY + rim * (1 - BADGE_FILL_OPACITY));
  };
  return `#${[0, 2, 4].map((at) => mix(at).toString(16).padStart(2, '0')).join('')}`;
}

describe('contrast arithmetic', () => {
  it('anchors on black and white, which is what fixes the scale', () => {
    // Black and white also exercise the low-channel branch of the sRGB transfer, which every colour
    // in this palette is too bright to reach.
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
  });

  it('is one for a colour against itself, and does not care which way round', () => {
    expect(contrastRatio(CLUSTER_FILL, CLUSTER_FILL)).toBe(1);
    expect(contrastRatio(CLUSTER_TEXT, CLUSTER_FILL)).toBe(
      contrastRatio(CLUSTER_FILL, CLUSTER_TEXT),
    );
  });
});

describe('badge contrast, which is a requirement rather than a preference', () => {
  it('keeps the count at AAA against the body, for every layer', () => {
    // The one thing on a badge that has to be readable at a glance, and the reason the layer hue went
    // on the casing rather than behind the number. Behind the number it measured 1.1:1 to 2.2:1, which
    // is unreadable; on the casing the count is untouched except for the fourteen per cent of hue that
    // bleeds into the body, which costs 15.14:1 down to 10.65:1 at worst.
    expect(contrastRatio(CLUSTER_TEXT, CLUSTER_FILL)).toBeGreaterThanOrEqual(7);
    for (const [, colour] of LAYER_COLOURS) {
      expect(contrastRatio(CLUSTER_TEXT, tintedFill(colour))).toBeGreaterThanOrEqual(7);
    }
  });

  it('never puts the layer hue behind the count', () => {
    // The failure mode this whole scheme avoids, asserted directly rather than implied. A hue bright
    // enough to identify a layer is a hue the near-white count disappears against.
    for (const [, colour] of LAYER_COLOURS) {
      expect(contrastRatio(CLUSTER_TEXT, colour)).toBeLessThan(4.5);
    }
  });

  it('keeps every casing visible against the body it rims', () => {
    // Three to one is the WCAG floor for a graphical element that has to be told apart from what it
    // sits on. The weakest is the aircraft grey-blue at 6.9:1, which is more than double it.
    for (const [, colour] of LAYER_COLOURS) {
      expect(contrastRatio(colour, CLUSTER_FILL)).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the badge separable from both extremes of the basemap', () => {
    // The two-channel construction, and each channel does one half. Over dark ocean the casing
    // separates the badge; over bright cloud and bright sand the dark body does. Neither channel has
    // to do both, which is what lets the casing carry a hue at all.
    for (const [, colour] of LAYER_COLOURS) {
      expect(contrastRatio(colour, BASEMAP.ocean)).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(CLUSTER_FILL, BASEMAP.cloud)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(CLUSTER_FILL, BASEMAP.desert)).toBeGreaterThanOrEqual(3);
  });

  it('gives every layer a different badge, which is the point of the exercise', () => {
    // Before this, all five layers rendered an identical grey hexagon and a badge reading "6k" could
    // have been six thousand ships or six thousand buses, with both in the frame at once.
    const images = LAYER_COLOURS.map(([, colour]) => clusterBadgeImage(38, CLUSTER_FILL, colour));

    expect(new Set(images).size).toBe(LAYER_COLOURS.length);
  });

  it('leaves the alert badge carrying both its alert and its layer', () => {
    // Red is the fill, so the alert reads. The casing still says which layer, because losing the
    // identity at the moment something is wrong is the worst time to lose it.
    const alert = clusterBadgeImage(38, CLUSTER_ALERT_FILL, CLASS_COLOURS.military);
    const plain = clusterBadgeImage(38, CLUSTER_FILL, CLASS_COLOURS.military);

    expect(alert).not.toBe(plain);
    expect(contrastRatio(CLUSTER_ALERT_TEXT, CLUSTER_ALERT_FILL)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the cluster badge', () => {
  it('is always larger than the individual mark it stands in for', () => {
    // A badge carries a number that has to be read, so it cannot be the same size as a mark that
    // carries none. The smallest badge against the largest routine mark.
    expect(clusterBadgePx(3)).toBeGreaterThan(AIRCRAFT_ICON_PX);
  });

  it('grows with the count, so the magnitude reads without the digits', () => {
    // Size is the redundant channel here, exactly as it is for an emergency. Someone who cannot
    // resolve "523" can still see it is a bigger badge than one reading "9".
    //
    // Three levels, sampled at one, two and three characters. They used to be sampled at 10, 100 and
    // 1000, which stopped working when the ladder capped at 48: a group of 100 and a group of 13,000
    // both draw at the cap. That is deliberate rather than a regression. A fourth level at 52 was
    // built and reverted, because on screen it read as the same size as 48 while halving the clearance
    // between neighbouring badges from eight pixels to four.
    const steps = [clusterBadgePx(2), clusterBadgePx(10), clusterBadgePx(100)];

    expect(steps).toEqual(steps.toSorted((left, right) => left - right));
    expect(new Set(steps).size).toBe(3);
  });

  it('caps every badge at 48, so neighbours keep a clear eight pixels between them', () => {
    // The clearance is what stops the badge-on-badge overlap that has had to be fixed twice, and it is
    // a property of the cap rather than of any one count. Badges are drawn on 56-pixel lattice points,
    // so the gap between two neighbours is the cell less the badge.
    const counts = [2, 99, 100, 999, 1000, 13_054, 99_999, 999_499, 999_500, 5e12, 5e18];
    const widest = Math.max(...counts.map((count) => clusterBadgePx(count)));

    expect(widest).toBe(48);
    expect(CLUSTER_CELL_PX - widest).toBeGreaterThanOrEqual(8);
  });

  it('never shrinks as the count rises, including across the abbreviation boundary', () => {
    // The inversion the size rule exists to stop. Text length alone would draw 1,000 ("1k", two
    // characters) smaller than 999 ("999", three), which is the magnitude cue running backwards at
    // the boundary where a reader most needs it.
    let previous = 0;
    for (const count of [2, 9, 10, 99, 100, 500, 998, 999, 1000, 1001, 9999, 13_054, 250_000]) {
      const size = clusterBadgePx(count);
      expect(size).toBeGreaterThanOrEqual(previous);
      previous = size;
    }
  });

  it('fits its text inside the badge for every count, measured rather than derived', () => {
    // The test that should have existed, written so it cannot move with the implementation. The one
    // it replaces multiplied the character count by 0.62 and compared it against the badge's *outer*
    // width, and both halves were wrong: a bold digit is up to 0.80 of the font size and the usable
    // run is the hexagon's flat inner width. Every count of 100 or more overflowed, transit's 13,054
    // by 21 pixels on a 48-pixel badge, and that test passed throughout.
    //
    // A first attempt at replacing it read `GLYPH_WIDTH_RATIO` and `badgeInnerPx` out of the module,
    // which made it self-referential: mutating either moved the implementation and the expectation
    // together and the test stayed green. So the numbers below are literals, measured in a real
    // browser on 2026-08-24 against the font the badges actually use, and nothing in `palette.ts` can
    // change them.
    for (const count of [
      2, 9, 10, 42, 99, 100, 523, 999, 1000, 1499, 1500, 1999, 2450, 5181, 13_054, 99_999, 999_499,
      999_500, 1_000_000, 13_000_000, 999_500_000, 5e12, 5e18,
    ]) {
      const text = clusterBadgeText(count);
      const measuredTextPx = MEASURED_TEXT_PX[clusterFontPx(count)]?.[text.length - 1];
      const measuredInnerPx = MEASURED_INNER_PX[clusterBadgePx(count)];
      expect(measuredTextPx).toBeDefined();
      expect(measuredInnerPx).toBeDefined();
      expect(measuredTextPx ?? 0).toBeLessThanOrEqual(measuredInnerPx ?? 0);
    }
  });

  it('gives the text the largest standard font that fits, rather than defaulting small', () => {
    // The other half of the same rule. Fitting is easy if everything is drawn tiny, and small text on
    // a globe some of this audience cannot read well is its own failure. So the chosen size has to be
    // the first entry of the ladder that fits, never a later one.
    for (const count of [2, 99, 100, 999, 1000, 13_054, 99_999]) {
      const text = clusterBadgeText(count);
      const budget = badgeInnerPx(clusterBadgePx(count));
      const largestThatFits =
        FONT_STEPS.find((size) => text.length * GLYPH_WIDTH_RATIO * size <= budget) ??
        SMALLEST_FONT_PX;

      expect(clusterFontPx(count)).toBe(largestThatFits);
    }
  });

  it('never grows wider than a grid cell, or two counts print on top of each other', () => {
    // Cells are packed edge to edge, so a badge wider than a cell overlaps the badge next door.
    // The first version had 44-pixel cells and a 52-pixel badge, and a whole-globe view came back
    // with "523" and "44" printed over each other above the North Sea.
    for (const count of [10, 99, 100, 999, 1000, 4000]) {
      expect(clusterBadgePx(count)).toBeLessThan(CLUSTER_CELL_PX);
    }
  });

  it('prints the exact count up to 999', () => {
    for (const count of [2, 9, 10, 99, 100, 523, 999]) {
      expect(clusterBadgeText(count)).toBe(String(count));
    }
  });

  it('abbreviates from a thousand, in lower case', () => {
    expect(clusterBadgeText(1000)).toBe('1k');
    expect(clusterBadgeText(13_054)).toBe('13k');
    expect(clusterBadgeText(1_000_000)).toBe('1m');
    // Lower case throughout, so a count is never read as a unit symbol.
    expect(clusterBadgeText(13_054)).not.toContain('K');
    expect(clusterBadgeText(1_000_000)).not.toContain('M');
  });

  it('rounds to nearest and never down out of its own magnitude', () => {
    // 1,999 drawn as "1k" would understate a group by nearly half while looking authoritative, which
    // is worse than no badge. Rounding to nearest is what rules it out.
    expect(clusterBadgeText(1999)).toBe('2k');
    expect(clusterBadgeText(1500)).toBe('2k');
    // Rounding down inside a magnitude is fine and unavoidable: 1,499 is nearer 1k than 2k.
    expect(clusterBadgeText(1499)).toBe('1k');
    for (const count of [1000, 1001, 1499, 1500, 1999, 9999, 99_999]) {
      const printed = Number(clusterBadgeText(count).replace('k', '')) * 1000;
      expect(printed).toBeGreaterThanOrEqual(count / 2);
    }
  });

  it('rolls over before the abbreviation grows a character', () => {
    // 999,500 rounded to the nearest thousand is 1,000, and "1000k" is five characters that fit no
    // badge narrower than a cell. So the rollover sits at 999,500 rather than at the round million.
    expect(clusterBadgeText(999_499)).toBe('999k');
    expect(clusterBadgeText(999_500)).toBe('1m');
    expect(clusterBadgeText(999_499_999)).toBe('999m');
    expect(clusterBadgeText(999_500_000)).toBe('1b');
  });

  it('never prints more than four characters, whatever it is handed', () => {
    // The property the sizes are built on: no badge under a cell holds five characters at a readable
    // font, so the text has to be bounded rather than merely usually short.
    for (const count of [2, 999, 1000, 999_499, 999_500, 999_499_999, 999_500_000, 5e12]) {
      expect(clusterBadgeText(count).length).toBeLessThanOrEqual(4);
    }
  });

  it('reads as interface rather than as an entity, and inverts for an alert', () => {
    // Every entity mark is a bright fill inside a black casing. A badge is the other way round on
    // purpose: that is how a viewer knows not to read it as one aircraft.
    expect(CLUSTER_FILL).not.toBe(CLUSTER_CASING);
    expect(CLUSTER_TEXT).toBe(CLUSTER_CASING);
    expect(CLUSTER_ALERT_FILL).toBe(EMERGENCY_COLOUR);
    // Dark text on red, because white on this red is under half the contrast.
    expect(CLUSTER_ALERT_TEXT).toBe(CLUSTER_FILL);
  });

  it('never dresses a routine group in a colour that already means something', () => {
    // Cyan means under way, yellow means military. A badge standing for forty mixed movers has no
    // business claiming either, so it takes no class hue at all.
    expect(Object.values(CLASS_COLOURS)).not.toContain(CLUSTER_FILL);
    expect(Object.values(CLASS_COLOURS)).not.toContain(CLUSTER_CASING);
  });
});
