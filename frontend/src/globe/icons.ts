/**
 * The mover marks: one silhouette per kind of thing on the globe, generated here.
 *
 * Every icon is an inline SVG in a `data:` URL built at runtime. No sprite sheet, no
 * font, no network: this project runs on one laptop with no CDN, so an icon that has to
 * be fetched is an icon that is missing.
 *
 * Two rules drive every number below, and both come from the audience rather than from
 * taste. Some of the people this is shown to have poor vision.
 *
 * **A silhouette, not an outline.** Each mark is a solid fill with a thick black casing
 * around it. That is the only construction that holds contrast against both halves of
 * the NASA GIBS basemap: over dark ocean the bright fill carries the shape, over bright
 * cloud the black casing does. A thin stroked outline disappears over cloud, which is why
 * there is not one here.
 *
 * **The shape carries the meaning, not just the hue.** Five silhouettes, chosen to be
 * told apart at eighteen pixels: a swept plan-view aircraft, a circle, a hull, a
 * cut-cornered square and a diamond. Round, square and diamond are the three simple marks
 * that stay distinguishable when they are small, so they carry the three cases where there
 * is nothing directional to draw.
 *
 * **Every silhouette is compact, and that is a hard constraint rather than a style.** A
 * mark's cost to the picture is the area of the globe it hides, which is its extent and not
 * its ink, so a shape with spikes charges for a large square and delivers a small one. An
 * earlier version of the satellite mark was a four-point star: at seven hundred objects
 * across a whole-globe view its points overlapped into a lattice that hid the continents,
 * for no more information than the plain diamond that replaced it carries.
 *
 * **Colour is baked into the image rather than applied as a Cesium billboard tint.** A
 * tint multiplies the texture, so only black survives it unchanged, and a white selection
 * ring inside a tinted texture would come out in the entity's own hue. Baking costs one
 * atlas entry per state that is actually drawn, built lazily, which is a few dozen small
 * images for the whole app.
 *
 * Renderer-free on purpose, exactly like `palette.ts`: nothing here imports Cesium, so the
 * geometry and the markup are both testable without a WebGL context.
 */

import { CLUSTER_CASING, SELECTION_COLOUR } from './palette';

/**
 * The five marks.
 *
 * `plane`, `ship` and `vehicle` point along a reported direction. `disc`, `block` and `diamond` do
 * not point anywhere, which is the whole reason they exist: a record with no reported track,
 * course or bearing must not be drawn as an arrow, because an arrow that defaults to north is a
 * measurement nobody made.
 *
 * `pin` is a third kind. It does not point along a direction and it is not symmetric either: it has
 * a tip, and the tip is the claim. Nothing that moves uses it. It marks a place a source named
 * exactly, which is the one thing on this globe that is neither a mover nor a guess.
 */
export type IconShape = 'plane' | 'disc' | 'ship' | 'block' | 'diamond' | 'vehicle' | 'pin';

/** A vertex in the icon coordinate box. */
export type IconPoint = readonly [number, number];

/**
 * The coordinate box every silhouette is drawn in, and the disc it has to stay inside.
 *
 * Vertices are kept within `SILHOUETTE_RADIUS` of the centre so the selected variant can
 * put a circular halo around any of the five without tuning the halo per shape.
 */
export const ICON_CENTRE = 50;
export const SILHOUETTE_RADIUS = 40;

/** Rounded so the generated markup stays short; the box is 100 units wide. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Aircraft in plan view, nose up.
 *
 * Swept wings forward of the centre and a tailplane aft, with the notch between them wide
 * enough to survive the casing. The casing grows outward by eight units on every edge, so
 * any concave gap narrower than sixteen units closes up and the aircraft reads as a blob:
 * the wing trailing edge and the tailplane leading edge are spaced for that and not for
 * the look of the outline.
 */
const PLANE: readonly IconPoint[] = [
  [50, 12],
  [57, 34],
  [85, 54],
  [84, 62],
  [57, 52],
  [57, 68],
  [68, 78],
  [66, 84],
  [50, 80],
  [34, 84],
  [32, 78],
  [43, 68],
  [43, 52],
  [16, 62],
  [15, 54],
  [43, 34],
];

/**
 * Hull in plan view, bow up: pointed forward, widest amidships, transom aft.
 *
 * No deckhouse, no funnel, no internal detail of any kind. At twenty-two pixels the casing
 * fills in anything finer than a sixteen-unit gap, so detail drawn here would not survive
 * to the screen and would only cost legibility on the way.
 */
const SHIP: readonly IconPoint[] = [
  [50, 14],
  [74, 46],
  [70, 80],
  [30, 80],
  [26, 46],
];

/**
 * A cut-cornered square, for a vessel whose course the feed did not report.
 *
 * Square rather than round so it cannot be confused with the aircraft fallback, and the
 * corners are cut because a full square's diagonal would push outside
 * `SILHOUETTE_RADIUS` and collide with the selection halo.
 */
const BLOCK: readonly IconPoint[] = [
  [28, 17],
  [72, 17],
  [83, 28],
  [83, 72],
  [72, 83],
  [28, 83],
  [17, 72],
  [17, 28],
];

/**
 * Satellites: a plain diamond, and plain is the whole point.
 *
 * This is the densest layer in the app and the one drawn furthest away, so its mark is the
 * one that has to give the globe back. A diamond is the most compact shape that is still
 * obviously not a circle, and it degrades gracefully: shrink a star and its points go first,
 * leaving a lumpy blob, whereas a shrunken diamond is still a diamond.
 *
 * Rotationally symmetric on purpose. There is no attitude on a propagated element set, so a
 * satellite mark that could point somewhere would be inventing a fact.
 */
const DIAMOND: readonly IconPoint[] = [
  [50, 10],
  [90, 50],
  [50, 90],
  [10, 50],
];

/**
 * A road or rail vehicle in plan view, front forward.
 *
 * Deliberately not a bus and not a train, and the name says so. `TransitVehicle` carries no mode:
 * there is no `route_type`, no `vehicle_type` and no `mode` field on the contract, and none is
 * derived in `sources/gtfsrt.py` either. Resolving one would need each operator's static
 * `routes.txt`, which the project does not fetch. Two silhouettes would therefore mean guessing
 * which vehicles are trains, so there is one, and it is drawn as the thing all of them have in
 * common: a long body that travels along its own length.
 *
 * Told apart from the other marks by proportion rather than by detail, which is what survives being
 * small. It is 32 units across and 72 long, a ratio of 1:2.25, where the vessel hull is 1:1.4 and
 * beamy with a pointed bow. Flat at both ends and tapered towards the front, so the direction is a
 * property of the whole shape rather than a feature the casing can swallow: the casing grows eight
 * units outward on every edge, which is enough to erase a windscreen bevel but not a taper.
 *
 * No hexagon anywhere in here on purpose. The cluster badge owns that outline.
 */
const VEHICLE: readonly IconPoint[] = [
  [38, 14],
  [62, 14],
  [66, 86],
  [34, 86],
];

/**
 * A map pin, tip at the bottom, for a post whose source supplied the coordinate.
 *
 * ADR 005 uses this word itself, and the shape is chosen for what the tip asserts: *here*, at this
 * point, exactly. That is a true claim for a Commons geosearch result, which is a photograph of a
 * place, and a false one for a location worked out from a post's words. So this mark is only ever
 * drawn for `location_basis` of `upstream`, and the ring below carries the other case.
 *
 * Nothing that moves is drawn as a pin, and nothing drawn as a pin moves. Between the two, the
 * outline alone says which class of thing a mark belongs to before colour is considered at all.
 */
/** The pin's lowest vertex, which is its tip. Named because `pinTipOffsetPx` is derived from it. */
const PIN_TIP_UNITS = 88;

const PIN: readonly IconPoint[] = [
  [ICON_CENTRE, PIN_TIP_UNITS],
  [36, 62],
  [27, 46],
  [27, 34],
  [33, 21],
  [43, 14],
  [57, 14],
  [67, 21],
  [73, 34],
  [73, 46],
  [64, 62],
];

/** How many sides stand in for the circle. Twenty-eight is round at every size drawn here. */
const DISC_SIDES = 28;

/**
 * A circle, for an aircraft whose track the feed did not report.
 *
 * The first vertex sits on the vertical centreline, like every other silhouette here, so
 * one test can assert that each mark is built the same way up.
 */
const DISC: readonly IconPoint[] = Array.from({ length: DISC_SIDES }, (_, index) => {
  const angle = (index / DISC_SIDES) * 2 * Math.PI - Math.PI / 2;
  return [
    round(ICON_CENTRE + SILHOUETTE_RADIUS * Math.cos(angle)),
    round(ICON_CENTRE + SILHOUETTE_RADIUS * Math.sin(angle)),
  ] as const satisfies IconPoint;
});

/**
 * Every silhouette, by name.
 *
 * A `Record` over the union, so adding a shape to the type fails to compile until it has
 * geometry rather than rendering as an empty billboard.
 */
export const ICON_SILHOUETTES: Record<IconShape, readonly IconPoint[]> = {
  plane: PLANE,
  disc: DISC,
  ship: SHIP,
  block: BLOCK,
  diamond: DIAMOND,
  vehicle: VEHICLE,
  pin: PIN,
};

/** The casing. Black, because black is what stays black under any compositing. */
const CASING_COLOUR = '#000000';

/**
 * Casing stroke width in box units, so four units of black on every edge.
 *
 * Half the stroke lands inside the silhouette and is then painted over by the fill, so the
 * visible casing is half this figure: about two pixels at the sizes the layers draw.
 */
const CASING_WIDTH = 16;

/**
 * Tight to the silhouette plus its casing, which reaches eight units past the vertices.
 *
 * A vertex sits at most `SILHOUETTE_RADIUS` from the centre, so 40 plus half the casing is
 * 48 in every direction: a 96-unit box centred on the 100-unit coordinate space.
 */
const NORMAL_BOX_UNITS = SILHOUETTE_RADIUS * 2 + CASING_WIDTH;
const NORMAL_VIEW_BOX = `${ICON_CENTRE - NORMAL_BOX_UNITS / 2} ${ICON_CENTRE - NORMAL_BOX_UNITS / 2} ${NORMAL_BOX_UNITS} ${NORMAL_BOX_UNITS}`;

/**
 * How many screen pixels of black casing a mark of this size actually gets.
 *
 * The number that decides whether the mark survives the bright half of the basemap. Half
 * the stroke is painted over by the fill, and the box is `NORMAL_BOX_UNITS` wide, so this is
 * the arithmetic behind `CASING_WIDTH` rather than a taste judgement. Asserted in the tests
 * against the smallest size any layer *authors* a mark at.
 *
 * The authored size is the floor, not the drawn size. Every layer shrinks its marks with
 * camera distance, and past a certain range that takes the casing below a pixel. That is a
 * deliberate trade and not a regression: at the range where it happens the layer is reading
 * as a field rather than as a set of objects, and the casing returns the moment the camera
 * comes in. Contrast is guaranteed at the size a mark can actually be read at.
 */
export function casingPixels(sizePx: number): number {
  return (CASING_WIDTH / 2 / NORMAL_BOX_UNITS) * sizePx;
}

/**
 * The selection halo: a white ring, cased in black on both sides so it reads over cloud
 * and over ocean alike.
 *
 * A ring outside the silhouette rather than a thicker casing on it. Dilating the outline of
 * a swept aircraft by twenty units closes every notch in it and the mark stops being an
 * aircraft at the moment it is selected, which is precisely when it needs to be readable.
 */
const HALO_RADIUS = 65;
const HALO_CASING_WIDTH = 30;
const HALO_RING_WIDTH = 16;

/** Centre plus eighty: the outer edge of the halo casing, at `HALO_RADIUS` plus half of 30. */
const SELECTED_BOX_UNITS = HALO_RADIUS * 2 + HALO_CASING_WIDTH;
const SELECTED_BOX_ORIGIN = ICON_CENTRE - SELECTED_BOX_UNITS / 2;
const SELECTED_VIEW_BOX = `${SELECTED_BOX_ORIGIN} ${SELECTED_BOX_ORIGIN} ${SELECTED_BOX_UNITS} ${SELECTED_BOX_UNITS}`;

/**
 * How far below the image's bottom edge a pin must be drawn for its tip to land on the coordinate.
 *
 * An anchored mark makes a claim about one exact point, so the point the tip touches has to be the
 * point the record reports. Cesium's `VerticalOrigin.BOTTOM` puts the *image* bottom on the anchor,
 * and the pin's painted tip is not at the image bottom: the silhouette's lowest vertex sits at
 * `PIN_TIP_UNITS`, the casing reaches half a stroke past it, and the view box is padded beyond that.
 * So the tip floats above the coordinate by exactly the leftover padding unless it is nudged down.
 *
 * Measured 2026-08-23 and it corrected two mistakes. The layer had been using `casingPixels`, which
 * is four times too large for the normal mark, and the same value again for the selected mark, where
 * the view box is `SELECTED_BOX_UNITS` rather than `NORMAL_BOX_UNITS` and the true figure is roughly
 * ten times larger. So a selected pin's tip sat about six pixels above its own coordinate.
 *
 * Derived from the geometry rather than written down, so editing the `PIN` path or either casing
 * moves the anchor with it instead of silently leaving it behind.
 */
export function pinTipOffsetPx(sizePx: number, selected: boolean): number {
  const boxUnits = selected ? SELECTED_BOX_UNITS : NORMAL_BOX_UNITS;
  const boxOrigin = selected ? SELECTED_BOX_ORIGIN : ICON_CENTRE - NORMAL_BOX_UNITS / 2;
  const paintedTip = PIN_TIP_UNITS + CASING_WIDTH / 2;
  return ((boxOrigin + boxUnits - paintedTip) / boxUnits) * sizePx;
}

const cache = new Map<string, string>();

/** `M x y L x y ... Z` for a closed silhouette. */
export function iconPath(points: readonly IconPoint[]): string {
  return `M${points.map(([x, y]) => `${x} ${y}`).join('L')}Z`;
}

/**
 * The SVG markup for one mark.
 *
 * `sizePx` becomes the SVG's own width and height, which is what an `<img>` rasterises at,
 * so the texture is generated at exactly the size Cesium draws it and never resampled.
 */
export function iconSvg(shape: IconShape, fill: string, selected: boolean, sizePx: number): string {
  const path = iconPath(ICON_SILHOUETTES[shape]);
  const halo = selected
    ? `<circle cx="${ICON_CENTRE}" cy="${ICON_CENTRE}" r="${HALO_RADIUS}" fill="none" stroke="${CASING_COLOUR}" stroke-width="${HALO_CASING_WIDTH}"/>` +
      `<circle cx="${ICON_CENTRE}" cy="${ICON_CENTRE}" r="${HALO_RADIUS}" fill="none" stroke="${SELECTION_COLOUR}" stroke-width="${HALO_RING_WIDTH}"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" ` +
    `viewBox="${selected ? SELECTED_VIEW_BOX : NORMAL_VIEW_BOX}">` +
    halo +
    // Casing first, then the fill over the top. The stroke is centred on the outline, so
    // painting the fill afterwards is what keeps the black on the outside of the shape
    // rather than eating four units into it.
    `<path d="${path}" fill="${CASING_COLOUR}" stroke="${CASING_COLOUR}" ` +
    `stroke-width="${CASING_WIDTH}" stroke-linejoin="round"/>` +
    `<path d="${path}" fill="${fill}"/>` +
    '</svg>'
  );
}

/**
 * A `data:` URL for one mark, built once and remembered.
 *
 * The identity of the returned string is what makes this safe to assign on every update:
 * Cesium keys its billboard texture atlas on the image id, so the same string means the
 * same atlas entry and a repeat assignment is an early return rather than a second upload.
 * A fresh string per call would put one atlas entry on the GPU per mover.
 */
export function iconImage(
  shape: IconShape,
  fill: string,
  selected: boolean,
  sizePx: number,
): string {
  const key = `${shape}|${fill}|${selected ? 's' : 'n'}|${sizePx}`;
  const held = cache.get(key);
  if (held !== undefined) {
    return held;
  }
  const url = `data:image/svg+xml,${encodeURIComponent(iconSvg(shape, fill, selected, sizePx))}`;
  cache.set(key, url);
  return url;
}

/**
 * The cluster badge, a flat-topped hexagon.
 *
 * A sixth shape, and deliberately not a member of `IconShape`: that union is the set of marks
 * that stand for one mover, and the cards read it to draw the same silhouette the globe does. A
 * badge stands for many movers and belongs to no card, so putting it in there would invite a
 * card to draw one.
 *
 * Flat-topped rather than pointy-topped because the count goes inside it, and a flat top is the
 * orientation that is widest where the digits sit. Hexagonal rather than round or square so it
 * cannot be read as the aircraft layer's no-track circle or the vessel layer's no-course square.
 */
const BADGE_RADIUS = 42;
const BADGE: readonly IconPoint[] = Array.from({ length: 6 }, (_, index) => {
  const angle = (index / 6) * 2 * Math.PI;
  return [
    round(ICON_CENTRE + BADGE_RADIUS * Math.cos(angle)),
    round(ICON_CENTRE + BADGE_RADIUS * Math.sin(angle)),
  ] as const satisfies IconPoint;
});

/** The badge's casing, in units. Wider than a mark's, because it is the channel doing the work. */
const BADGE_CASING_WIDTH = 12;

/**
 * How much of the casing shows through the badge body.
 *
 * **Corrected 2026-08-24: this does not let the map through and never did.** The comment here used
 * to say it did, on the reasoning that a badge covers the globe and grouping is supposed to give the
 * globe back. But the casing path is *filled* as well as stroked, so it lays an opaque hexagon under
 * the body and the map reaches nowhere. What the fourteen per cent actually mixes is the casing
 * colour into the body.
 *
 * That turns out to be useful rather than merely harmless. Now that the casing carries the layer's
 * identity, the body picks up a seventh of that hue too, so a badge is tinted as well as rimmed and
 * the identity survives being seen small. Measured against the count: the darkest mix is 10.65:1 and
 * the lightest 12.15:1, both above WCAG AAA's 7:1 for normal text, against 15.14:1 with a white
 * casing. So the tint costs contrast and does not spend anywhere near what it has.
 */
export const BADGE_FILL_OPACITY = 0.86;

/** The polygon a badge is drawn from, exposed so a test can hold it to the same rules. */
export const CLUSTER_BADGE_SILHOUETTE: readonly IconPoint[] = BADGE;

/**
 * The SVG markup for a cluster badge of this size, filled in this colour.
 *
 * Casing first and fill over the top, exactly as a mark is built, but with the two colours the
 * other way round: a bright ring outside a dark body. The count is not in here. It is a Cesium
 * label drawn on top, because baking a number into the image would put one texture atlas entry
 * on the GPU per distinct count, and the counts change on every camera movement.
 */
export function clusterBadgeSvg(
  sizePx: number,
  fill: string,
  casing: string = CLUSTER_CASING,
): string {
  const path = iconPath(BADGE);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" ` +
    `viewBox="${NORMAL_VIEW_BOX}">` +
    `<path d="${path}" fill="${casing}" stroke="${casing}" ` +
    `stroke-width="${BADGE_CASING_WIDTH}" stroke-linejoin="round"/>` +
    `<path d="${path}" fill="${fill}" fill-opacity="${BADGE_FILL_OPACITY}"/>` +
    '</svg>'
  );
}

/**
 * A `data:` URL for a cluster badge, built once and remembered.
 *
 * Same identity contract as `iconImage`, and it shares the same cache: the returned string is the
 * texture atlas key, so the badge sizes cost one atlas entry each per layer colour however many
 * groups are on the globe. Six layers times three sizes is eighteen entries, which is the price of
 * a badge saying what it is a badge of.
 */
export function clusterBadgeImage(
  sizePx: number,
  fill: string,
  casing: string = CLUSTER_CASING,
): string {
  const key = `badge|${fill}|${casing}|${sizePx}`;
  const held = cache.get(key);
  if (held !== undefined) {
    return held;
  }
  const url = `data:image/svg+xml,${encodeURIComponent(clusterBadgeSvg(sizePx, fill, casing))}`;
  cache.set(key, url);
  return url;
}

/**
 * The ring, for a post whose position was worked out from its words rather than reported.
 *
 * Hollow on purpose, and it is the most load-bearing shape decision in this module. ADR 005 exists
 * to stop a city-level gazetteer match being presented as an observation, and a filled mark with a
 * centre is exactly that presentation: it says *here*. A ring says *somewhere in this*, which is
 * the truth about a match on the word "London". It has no tip and no centre to read as a point.
 *
 * **What this does not do, deliberately.** It is not drawn at the true scale of the uncertainty.
 * Cesium can size a billboard in metres, and a ring a few kilometres across would be the literally
 * honest picture, but at the opening view a city is well under a pixel and the layer would render
 * as nothing at all. So the ring is a fixed pixel size and carries its meaning in its shape rather
 * than in its radius. The card carries the phrase and the matched place, per ADR 005, which is
 * where the precision is stated in words.
 */
const RING_RADIUS = 28;
const RING_CASING_WIDTH = 26;
const RING_FILL_WIDTH = 14;

/** One stroked circle, which is all a ring and a halo are made of. */
function strokedCircle(radius: number, stroke: string, width: number): string {
  return (
    `<circle cx="${ICON_CENTRE}" cy="${ICON_CENTRE}" r="${radius}" fill="none" ` +
    `stroke="${stroke}" stroke-width="${width}"/>`
  );
}

/** The SVG for one ring, of this size and colour. */
export function areaRingSvg(sizePx: number, fill: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" ` +
    `viewBox="${NORMAL_VIEW_BOX}">` +
    // Casing first and the bright band over the middle of it, so black remains on both edges of
    // the ring. Same two-channel trick as every mark here: the bright band carries it over dark
    // ground and the black edges carry it over anything pale.
    strokedCircle(RING_RADIUS, CASING_COLOUR, RING_CASING_WIDTH) +
    strokedCircle(RING_RADIUS, fill, RING_FILL_WIDTH) +
    '</svg>'
  );
}

/**
 * A `data:` URL for a ring, built once and remembered.
 *
 * Shares `iconImage`'s cache and its identity contract: the same arguments return the same string,
 * which is the texture atlas key, so a thousand derived posts cost one atlas entry.
 */
export function areaRingImage(sizePx: number, fill: string, selected: boolean): string {
  const key = `ring|${fill}|${sizePx}|${selected ? 's' : 'n'}`;
  const held = cache.get(key);
  if (held !== undefined) {
    return held;
  }
  const svg = selected ? selectedAreaRingSvg(sizePx, fill) : areaRingSvg(sizePx, fill);
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(key, url);
  return url;
}

/** The selected ring: the same ring inside the app's selection halo. */
function selectedAreaRingSvg(sizePx: number, fill: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" ` +
    `viewBox="${SELECTED_VIEW_BOX}">` +
    strokedCircle(HALO_RADIUS, CASING_COLOUR, HALO_CASING_WIDTH) +
    strokedCircle(HALO_RADIUS, SELECTION_COLOUR, HALO_RING_WIDTH) +
    strokedCircle(RING_RADIUS, CASING_COLOUR, RING_CASING_WIDTH) +
    strokedCircle(RING_RADIUS, fill, RING_FILL_WIDTH) +
    '</svg>'
  );
}

/** Something with the three fields of a Cesium `Cartesian3`, and nothing else. */
export interface IconAxis {
  x: number;
  y: number;
  z: number;
}

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * The direction of travel as an earth-fixed unit vector, written into `out`.
 *
 * This is what points a directional mark, via a billboard's `alignedAxis`, and it is a
 * world-space direction rather than a screen-space angle for one reason: a screen angle is
 * only correct while north is up. Drag the globe round and every aircraft set by a screen
 * angle is then pointing somewhere no feed reported, which is worse than not pointing at
 * all. Cesium projects the axis per frame, so the mark follows the camera for free.
 *
 * `out` is written in place and returned. The caller keeps one scratch vector for the whole
 * layer: Cesium's `alignedAxis` setter clones, so a frame allocates nothing.
 */
export function orientAxis(
  lonDeg: number,
  latDeg: number,
  bearingDeg: number,
  out: IconAxis,
): IconAxis {
  const lat = latDeg * DEGREES_TO_RADIANS;
  const lon = lonDeg * DEGREES_TO_RADIANS;
  const bearing = bearingDeg * DEGREES_TO_RADIANS;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const sinBearing = Math.sin(bearing);
  const cosBearing = Math.cos(bearing);
  // Local north and east at (lon, lat), combined by the bearing. Both are unit vectors and
  // they are orthogonal, so the result is a unit vector without a normalise step.
  out.x = -sinLat * cosLon * cosBearing - sinLon * sinBearing;
  out.y = -sinLat * sinLon * cosBearing + cosLon * sinBearing;
  out.z = cosLat * cosBearing;
  return out;
}
