/**
 * One fixed hue per aircraft class, the alert encoding, and the sizes the marks are drawn at.
 *
 * CSS colour strings rather than Cesium colours so the same values drive the map, the
 * info card and the status banner, and so the mapping can be tested without importing a
 * renderer. Red and orange are held back for alert states: nothing routine is allowed to
 * use them, or an emergency stops standing out.
 */

import type { AircraftClass } from '../types/entities';

/**
 * Total by construction: `Record` over the union means adding a class to the contract
 * fails to compile until it has a colour, rather than rendering as an invisible point.
 */
export const CLASS_COLOURS: Record<AircraftClass, string> = {
  unknown: '#8fa3b8',
  commercial: '#4da3ff',
  business_jet: '#b98cff',
  general_aviation: '#4ddbb0',
  military: '#ffd24d',
  helicopter: '#7ee081',
  anonymous: '#6f7a88',
};

/** Alert colour. Reserved: no class hue may be red. */
export const EMERGENCY_COLOUR = '#ff4d4d';

/** The colour of the selection halo, whatever the mark it goes round. */
export const SELECTION_COLOUR = '#ffffff';

/**
 * Aircraft mark size in pixels.
 *
 * Bigger than the seven-pixel dot this layer used to draw, and deliberately so: some of
 * the people this is shown to have poor vision, and a silhouette needs enough pixels to
 * still be a silhouette. Twenty-six leaves about twenty-two pixels of coloured shape
 * inside two pixels of black casing, which is the smallest a swept aircraft holds together
 * at.
 */
export const AIRCRAFT_ICON_PX = 26;

/**
 * Emergency aircraft are drawn larger as well as red.
 *
 * Colour alone would exclude anyone with a red/green deficiency, which is roughly one in
 * twelve men. Size is the redundant channel, so the state is legible without hue.
 */
export const AIRCRAFT_EMERGENCY_ICON_PX = 32;

/**
 * The selected aircraft, which is at most one at a time.
 *
 * Close to double, because the selected mark carries the halo as well as the silhouette and
 * the halo takes half the image. At forty-eight the coloured shape inside the halo is still
 * larger than an unselected mark, so selecting something never makes it smaller.
 */
export const AIRCRAFT_SELECTED_ICON_PX = 48;

/**
 * Public transport, in a magenta nothing else uses.
 *
 * Chosen by elimination rather than taste. Red and orange are reserved for alerts across the whole
 * app; cyan already means a vessel under way and pale cyan a satellite; the aircraft classes have
 * taken blue, purple, teal, yellow, green and two greys. Magenta sits clear of all of them and, at
 * hue 325 degrees, clear of the alert reds at 0 to 30, so it cannot be mistaken for one. It also
 * holds up over the two backgrounds transit actually sits on, which are green land and grey urban
 * imagery rather than ocean.
 *
 * **One colour, not two.** The vessel layer draws under-way and stopped apart because AIS reports
 * a speed on 99.8% of records. GTFS-Realtime reports one on 39.9%, so a moving/stopped split would
 * be a claim about six vehicles in ten that the feed never made. Where the data does not support a
 * distinction, there is no distinction.
 */
export const TRANSIT_COLOUR = '#ff79c6';

/**
 * Social posts, in a lime nothing else uses.
 *
 * The palette is crowded by this point, so this was chosen by elimination like the transit magenta.
 * Red and orange are reserved for alerts; blue, purple, teal, yellow, green and two greys belong to
 * the aircraft classes; cyan is a vessel under way and pale cyan a satellite; magenta is transit.
 * Lime at hue 75 is the widest gap left, and it is furthest from magenta, which matters because
 * posts and transit vehicles are the two layers that both sit in cities.
 *
 * **One colour for both bases, and that is deliberate.** A post whose coordinate was reported and
 * one whose coordinate was worked out from its words are told apart by outline, a pin against a
 * hollow ring, which is the strongest shape difference in this app. Adding a colour axis on top
 * would be a second thing to learn for information the shape already carries, and it would weaken
 * the rule this project keeps everywhere else: a mark is told apart by its outline first.
 */
export const SOCIAL_COLOUR = '#c6f24a';

/**
 * The cluster badge: dark fill, bright casing, bright text.
 *
 * Deliberately the inverse of every entity mark, which is a bright fill inside a black casing.
 * A group is a piece of interface rather than a thing in the world, and looking like interface
 * is how a viewer knows not to read it as one aircraft. It also sidesteps the trap of dressing
 * a mixed group in a colour that means something: cyan means under way, yellow means military,
 * and a badge standing for forty movers has no business claiming either.
 *
 * The casing is bright rather than black for the same reason the marks' casing is black: it is
 * the channel that has to survive the other half of the basemap. A dark badge over dark ocean
 * is carried by its light ring, and over bright cloud by its dark fill.
 */
export const CLUSTER_FILL = '#101820';
export const CLUSTER_CASING = '#e6edf3';
export const CLUSTER_TEXT = '#e6edf3';

/**
 * A group holding an aircraft in distress is drawn in the alert colour, text inverted.
 *
 * The one exception to a group having no colour, and it is not decoration. Red is reserved for
 * alerts across the whole app, so a group that swallowed an emergency without saying so would
 * be the one case where clustering genuinely hides something that matters.
 */
export const CLUSTER_ALERT_FILL = EMERGENCY_COLOUR;
export const CLUSTER_ALERT_TEXT = '#101820';

/**
 * The widest a bold digit gets, as a fraction of the font size.
 *
 * Measured 2026-08-24 in the browser against the font the badges actually use: "99" is 22.3px at
 * 14px, which is 0.796 per character, and that is the worst of the set because '9' and '0' are the
 * widest glyphs while '1', 'k' and '.' are all narrower. So 0.80 is an upper bound rather than an
 * average, and sizing against it means a count cannot overflow its badge whatever digits it happens
 * to contain. `palette.test.ts` holds the relationship.
 */
export const GLYPH_WIDTH_RATIO = 0.8;

/**
 * How much of a badge's width the text can actually use.
 *
 * The badge is a flat-top hexagon of radius 42 in a 96-unit box (see `icons.ts`), cased with a
 * 16-wide stroke of which half is painted outside the outline. So the usable flat run across the
 * middle is 2 * (42 - 8) of 96, and it is that rather than the badge's width that a count has to fit
 * inside. Getting this wrong is what let every count of 100 or more spill onto the basemap.
 */
export function badgeInnerPx(badgePx: number): number {
  return (badgePx * (2 * (42 - 8))) / 96;
}

/**
 * What a badge prints: the exact count up to 999, then thousands and millions.
 *
 * **Why abbreviate at all.** Measured 2026-08-24, every count of 100 or more overflowed its badge:
 * three digits by 2 to 5 pixels, four by 7 to 13, and transit's 13,054 by 21 pixels on a 48-pixel
 * badge. The digits spilled past the casing onto bare basemap, which over cloud is bright text on a
 * bright background and is the vanishing-outline failure this project already refuses to make with
 * marks. Neither alternative was available: shrinking the font is against the standing rule, and
 * growing the badge past `CLUSTER_CELL_PX` reintroduces the badge-on-badge overlap the lattice in
 * `badge-slots.ts` exists to prevent.
 *
 * **It does not weaken the count.** The rule a badge lives under is that a viewer is never shown one
 * mark that quietly stands for forty. "13k" says the magnitude out loud and the exact figure is one
 * glance away on the rail, which carries `ClusterState`. What would break the rule is a badge with no
 * count on it, or one that rounded down out of its own magnitude.
 *
 * **It rounds to nearest, never down past a magnitude.** 1,999 prints "2k" and never "1k". The
 * rollovers are at 999,500 and 999,500,000 rather than at the round million and billion, because
 * rounding 999,500 to the nearest thousand gives 1,000 and "1000k" is a five-character badge that
 * fits nothing. Lower-case `k` and `m` throughout, so a count is never mistaken for a unit.
 */
export function clusterBadgeText(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  let scaled = count;
  for (const suffix of ABBREVIATIONS) {
    scaled /= 1000;
    // Below 999.5 the rounded mantissa is at most three digits, so the badge is at most four
    // characters. At or above it, rounding would print "1000k" and the next suffix is the answer.
    if (scaled < 999.5) {
      return `${Math.round(scaled)}${suffix}`;
    }
  }
  // Past a quadrillion in one cell. Clamped rather than left to grow a fifth character, because a
  // badge that does not fit is worse than one that saturates.
  return `999${LARGEST_ABBREVIATION}`;
}

/** Named, so the saturating case above needs no fallback for an index that cannot be out of range. */
const LARGEST_ABBREVIATION = 'q';

/** Thousand, million, billion, trillion, quadrillion. Lower case, so a count never reads as a unit. */
const ABBREVIATIONS: readonly string[] = ['k', 'm', 'b', 't', LARGEST_ABBREVIATION];

/**
 * Badge size in pixels: the larger of what the count's magnitude deserves and what its text needs.
 *
 * Larger than an individual mark, which is the point: it carries a number that has to be read. Only
 * just larger, though, and that is the correction to a first attempt that shipped a sixty-pixel
 * badge: a badge hides the globe under it, so one much bigger than the marks it replaces costs the
 * picture more than the smear it was meant to clear. Measured against a whole-globe view, where a
 * mark is drawn at seven to nine pixels. The ceiling is the grid rather than taste: badges are drawn
 * on `CLUSTER_CELL_PX` lattice points, so one wider than a cell reaches into its neighbour.
 *
 * **Two things set it, and taking the larger is what stops a size inversion.** The magnitude steps
 * are what a viewer reads as "more", and the text steps are what makes the digits fit. On their own
 * the text steps would draw a group of 1,000 ("1k", two characters) smaller than a group of 999
 * ("999", three), which is the size cue running backwards at exactly the boundary where the reader
 * most needs it. Taking the larger keeps the size non-decreasing in the count, which `palette.test.ts`
 * asserts across the whole range.
 *
 * **The ladder stops at 48, and a fourth level was tried and rejected.** Three characters need 48
 * whatever they mean, so at 48 a group of 100 and a group of 13,000 draw identically and the size
 * cue has three levels rather than four. A 52-pixel top step restores the fourth, and it was built
 * and then reverted on 2026-08-24 for two reasons that both point the same way. On screen, in a live
 * Europe view, 52 next to 48 read as the same size, and a distinction a viewer cannot perceive is not
 * a cue: least of all for this audience, which includes people with poor vision, for whom four pixels
 * at the top of the ladder is exactly the difference that will not land. Against that, the clearance
 * is real in the geometry: badges sit on a 56-pixel lattice, so a 48-pixel cap leaves eight pixels
 * between neighbours where 52 leaves four, and that clearance is the only thing standing between this
 * and the badge-on-badge overlap that has already had to be fixed twice.
 *
 * So the count carries the magnitude and the size is the redundant channel, which is the right way
 * round. Do not restore 52 on the arithmetic alone: the arithmetic favours it and the measurement
 * does not.
 */
export function clusterBadgePx(count: number): number {
  const hundreds = count >= 100 ? 38 : 30;
  const byMagnitude = count >= 1000 ? LARGEST_BADGE_PX : hundreds;
  const chars = clusterBadgeText(count).length;
  let byText = SMALLEST_BADGE_PX;
  for (const [index, step] of BADGE_STEPS.entries()) {
    if (index < chars) {
      byText = step;
    }
  }
  return Math.max(byMagnitude, byText);
}

/**
 * Badge width by character count, from the measurement.
 *
 * One, two and three characters are what this app can actually produce, and each holds its text with
 * room to spare: 10.8 of 21.25 at 16 pixels, 25.3 of 26.91 at 16, and 31.8 of 34 at 14. Four
 * characters also fit 48, at 11 pixels for 33.1 of 34, so the ladder needs no wider step and the cap
 * holds everywhere rather than only for the counts this app can reach. That case starts at a hundred
 * thousand movers in one cell and cannot occur here; it is sized rather than ignored so the function
 * cannot overflow for any input at all.
 */
const SMALLEST_BADGE_PX = 30;
const LARGEST_BADGE_PX = 48;
const BADGE_STEPS: readonly number[] = [SMALLEST_BADGE_PX, 38, LARGEST_BADGE_PX, LARGEST_BADGE_PX];

/**
 * Count font size in pixels: the largest of the standard sizes whose text fits the badge.
 *
 * Derived rather than tabulated, so it cannot disagree with `clusterBadgePx`. Everything this app can
 * produce lands on 16 or 14. The smaller sizes exist only for counts past a hundred thousand in one
 * cell, where a font that fits is better than digits on the basemap.
 */
export function clusterFontPx(count: number): number {
  const budget = badgeInnerPx(clusterBadgePx(count));
  const chars = clusterBadgeText(count).length;
  for (const size of FONT_STEPS) {
    if (chars * GLYPH_WIDTH_RATIO * size <= budget) {
      return size;
    }
  }
  // Reached rather than defensive: four characters do not fit a 52-pixel badge at twelve, and
  // `SMALLEST_FONT_PX` is chosen so they fit at eleven, 35.2 pixels of 36.8. Falling out of the loop
  // is the answer for that case, not a guard against one that cannot happen, so there is no
  // unreachable branch here for a test to leave uncovered.
  return SMALLEST_FONT_PX;
}

/** Largest first, so the loop above takes the biggest that fits rather than the first that works. */
export const FONT_STEPS: readonly number[] = [16, 14, 12];

/**
 * The floor, for text no offered size fits: four characters, which starts at a hundred thousand
 * movers in one cell and cannot occur here. Small, and better than digits printed on the basemap.
 */
export const SMALLEST_FONT_PX = 11;

/**
 * WCAG relative luminance of a `#rrggbb` colour.
 *
 * Here rather than in a test helper because the accessibility requirement on this project is a
 * requirement rather than a preference: some of the people this is demonstrated to have poor vision,
 * and the badge count is the one thing on screen that must stay readable at a glance. A number a test
 * can assert is worth more than a claim in a comment, and the arithmetic is eight lines.
 */
export function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const linearise = (at: number): number => {
    const channel = Number.parseInt(value.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearise(0) + 0.7152 * linearise(2) + 0.0722 * linearise(4);
}

/** WCAG contrast ratio between two colours, 1 for identical and 21 for black against white. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Human label for a class, for the card and any list view. */
export const CLASS_LABELS: Record<AircraftClass, string> = {
  unknown: 'Unclassified',
  commercial: 'Commercial',
  business_jet: 'Business jet',
  general_aviation: 'General aviation',
  military: 'Military',
  helicopter: 'Helicopter',
  anonymous: 'Anonymous (privacy address)',
};

/** The colour an aircraft of this class and state is drawn in. */
export function colourFor(aircraftClass: AircraftClass, inEmergency: boolean): string {
  return inEmergency ? EMERGENCY_COLOUR : CLASS_COLOURS[aircraftClass];
}

/**
 * Mark size in pixels for this state.
 *
 * Selection wins the size, which is the reverse of the old point sizing and is safe here
 * because the emergency state no longer depends on being the biggest thing on screen: the
 * selected mark keeps the red fill and adds a halo, so both states show at once and neither
 * is dressed down by the other.
 */
export function iconSizeFor(inEmergency: boolean, selected: boolean): number {
  if (selected) {
    return AIRCRAFT_SELECTED_ICON_PX;
  }
  return inEmergency ? AIRCRAFT_EMERGENCY_ICON_PX : AIRCRAFT_ICON_PX;
}
