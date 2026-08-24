/**
 * The city layer: the whole GeoNames gazetteer as labels, banded by population.
 *
 * One `LabelCollection`, created once and mutated in place. No Cesium `Entity`, and the
 * collection is never rebuilt: labels are pooled by index, so a camera move rewrites the
 * text and position of labels that already exist rather than adding or removing any.
 *
 * Two things do the work, and the second is not optional.
 *
 * **Population banding.** Every city falls in one of six bands, and its band decides the
 * `DistanceDisplayCondition` its label carries. A capital is legible from orbit; a town only
 * appears once the camera is within 80km of it. That is what makes a world view read as
 * capitals and a city view read as towns, and it is a per-label range test the GPU does, so
 * it costs nothing per frame.
 *
 * **A label budget.** Banding alone would still put 34,072 labels in the collection, and a
 * Cesium label is not one primitive: `rebindAllGlyphs` builds one billboard per glyph as
 * soon as a label has text, whatever its display condition says. The whole gazetteer is
 * about 300,000 glyph billboards, which is hundreds of megabytes of vertex buffer and a
 * multi-second hitch on load, so the collection holds a working set instead. Every record
 * lives here in memory, sorted; the labels are the biggest cities that could be visible from
 * where the camera is now. Nothing is fetched again to change the picture.
 *
 * ponytail: the visible-set scan is a linear walk of the sorted records with an early exit,
 * no spatial index. 34,072 comparisons on a camera move measures as noise, and the exit
 * means a world view stops after the first few dozen. If a profile ever shows it, the
 * upgrade is a fixed longitude/latitude grid bucket, not a library.
 */

import {
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Matrix4,
  VerticalOrigin,
} from 'cesium';
import type { Label, Scene } from 'cesium';

import { badgeSlots } from '../badge-slots';
import { CLUSTER_CELL_PX, occludedByGlobe, projectToScreen } from '../cluster';
import { LARGEST_BADGE_PX } from '../palette';
import { cesiumColour } from '../colour';
import { pointInView } from '../project';
import type { ViewRect } from '../project';
import type { City } from '../../types/entities';

/**
 * The layer name the rail and `/api/capabilities` use.
 *
 * A plain string rather than a `LayerName`: the backend keeps cities out of that union on
 * purpose, because `LayerName` is the set of layers the WebSocket carries deltas for and a
 * weekly file has none. See `CITY_LAYER` in `src/tracker/api/routes_entities.py`.
 */
export const CITY_LAYER = 'cities';

/**
 * Prefix on the id stamped onto every drawn city label.
 *
 * `installPicking` in `globe/viewer.ts` reads whatever `id` the picked primitive carries and
 * hands it on as one string, so every layer's ids share one namespace and the whole namespace
 * has to be checked before a prefix is chosen. What is in it today:
 *
 * - **Aircraft**, in `layers/aircraft.ts` `acquire`: a bare lowercase six-hex ICAO 24-bit
 *   address, `4ca7b5`, on the mark and on the label.
 * - **Vessels**, in `layers/vessels.ts` `acquire`: a bare MMSI, nine decimal digits,
 *   `230123450`.
 * - **Satellites**, in `layers/satellites.ts` `acquire`: `satellite:` followed by the NORAD
 *   catalogue number.
 *
 * So `city:` is safe on both counts that matter. It cannot be read as an aircraft or a vessel,
 * because those two are bare identifiers with no colon in them and a GeoNames id is seven or
 * eight digits rather than six hex or nine decimal. And neither `city:` nor `satellite:` is a
 * prefix of the other, which is the test `startsWith` routing actually depends on: a scheme
 * like `c:` alongside a hypothetical `ci:` would route one layer's clicks to the other.
 *
 * A bare GeoNames id would have been the collision. `2643743` is seven digits, but catalogue
 * numbers have run past seven (the recorded Pechersk row is 13535745) and nothing stops one
 * landing on six digits, which is a valid ICAO 24-bit address in decimal characters. The
 * prefix is what keeps one click routing to one layer.
 */
export const CITY_PICK_PREFIX = 'city:';

/**
 * What this layer holds on the shared badge lattice, so a cluster badge is pushed off a name.
 *
 * A label sits on a fixed geographic point and reading it is the whole of its job. A badge is a
 * count over an area, has never claimed to mark a position, and is already free to move by up to
 * half a cell. So when the two want the same pixels the badge yields, and the way to make that
 * happen is for the label to take the points first. See `badge-slots.ts`.
 */
const CITY_SLOT_KEY = 'cities';

/**
 * How much wider and taller the painted label is than its glyphs.
 *
 * `outlineWidth: 3` with `FILL_AND_OUTLINE`, so three pixels each side, and the line box runs a
 * little past the cap height. Six and eight rather than a measurement, because a reservation that
 * is a pixel or two generous costs nothing and one that is short leaves a badge on the last letter.
 */
const LABEL_PAINT_MARGIN_PX = 6;
const LABEL_LINE_MARGIN_PX = 8;

/**
 * How much wider than the name the reservation has to be: the widest badge, so half of it each side.
 *
 * Measured 2026-08-24, and the first version of this was wrong without it. Holding only the cells a
 * name covers leaves the cell next door free, and the badge that lands there still overlaps the name:
 * two badges are a cell apart, 56 pixels, while a 48-pixel badge beside an 80-pixel name like "Dar es
 * Salaam" overlaps until their centres are 64 apart. So the first attempt moved thirty badges and
 * reduced collisions by nothing, which is the failure mode that looks like it worked.
 *
 * Growing the box by a whole badge means every point left free is genuinely clear of the name, which
 * is the property the reservation is for.
 */
const LABEL_KEEP_OUT_PX = LARGEST_BADGE_PX;

/** Reused for the view projection the reservation needs. Not the cell arithmetic's, which is flat. */
const scratchMatrix = new Matrix4();

/** Reused for the projected label position. Plain numbers: `projectToScreen` wants no Cesium type. */
const screenAt = { x: 0, y: 0 };

/**
 * A canvas context kept only to measure text, created on first use.
 *
 * The width of a name in pixels is not derivable from the string: Cesium renders the glyphs itself
 * and the only honest way to know how wide "Comodoro Rivadavia" is at `500 12px` is to ask the same
 * engine that will draw it.
 */
const measurer: { context: CanvasRenderingContext2D | null | undefined } = { context: undefined };

/**
 * Average width of a mixed-case Latin glyph as a fraction of the font size.
 *
 * Only used where there is no canvas to ask, which in practice means a test runner rather than a
 * browser. A proportion rather than zero on purpose: it keeps the reservation proportional to the
 * name, so "Comodoro Rivadavia" still reserves more than "Bath" and the width path is exercised
 * rather than skipped. Measured against the real metrics at 12px, an estimate within a few per cent.
 */
const ESTIMATED_GLYPH_WIDTH_RATIO = 0.5;

function textWidthPx(text: string, font: string, fontPx: number): number {
  measurer.context ??=
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (measurer.context === null) {
    return text.length * ESTIMATED_GLYPH_WIDTH_RATIO * fontPx;
  }
  measurer.context.font = font;
  return measurer.context.measureText(text).width;
}

/**
 * The GeoNames id in a picked id, or null when the pick was not a city.
 *
 * Returns a number, because `City.geonames_id` is a number in the contract and the search
 * route reaches the same city through `SearchHit.entity_id`, which is the same decimal digits
 * as a string with no prefix on them. Both routes therefore resolve to one numeric key and
 * cannot disagree about which city was asked for.
 *
 * Zero and below are refused as well as the non-integers. `Number('')` is 0 and
 * `Number.isSafeInteger(0)` is true, so a bare `city:` with nothing after it would otherwise
 * resolve to a GeoNames id of 0, which is a lookup that quietly finds nothing rather than a
 * pick that was not a city.
 */
export function geonamesFromPickId(id: string | null): number | null {
  if (!id?.startsWith(CITY_PICK_PREFIX)) {
    return null;
  }
  const parsed = Number(id.slice(CITY_PICK_PREFIX.length));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const LABEL_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Three weights across six bands, so size and colour both carry rank.
 *
 * Dimmer than the aircraft label colour (`#e6edf3`) at every step, because a city name is
 * context for the entities drawn on top of it and must not compete with them.
 */
const PROMINENT = { font: `600 13px ${LABEL_FAMILY}`, colour: '#dbe7f0' };
const NORMAL = { font: `500 12px ${LABEL_FAMILY}`, colour: '#b6c6d3' };
const QUIET = { font: `400 11px ${LABEL_FAMILY}`, colour: '#93a3b0' };

export interface PopulationBand {
  /** Smallest population in the band. */
  minPopulation: number;
  /**
   * Metres from the camera beyond which a label in this band is not drawn.
   *
   * Must never rise as `minPopulation` falls, or the early exit in `refresh` would skip
   * cities that should be visible. Asserted by a test.
   */
  farM: number;
  font: string;
  colour: string;
}

/**
 * The band every city below 50,000 people falls in, and the answer for anything the bands
 * above do not claim.
 */
const SMALLEST_BAND: PopulationBand = { minPopulation: 0, farM: 80_000, ...QUIET };

/**
 * The bands, biggest first.
 *
 * Thresholds were picked against the real file rather than as round numbers: measured
 * 2026-08-19, of 34,099 rows 59 are at or above 5M, 562 above 1M, 1,989 above 300k, 6,241
 * above 100k and 12,366 above 50k. The distances then follow from what a camera at that
 * height puts on screen, so a band appears at the zoom where its cities are the interesting
 * ones.
 *
 * - 5M and up, visible from 25,000km: the whole-globe view. 59 cities worldwide, so about
 *   thirty on the lit hemisphere. An empty ocean then has a horizon with Tokyo and Lagos on
 *   it rather than nothing, which is half the reason this layer ships, and thirty names is
 *   deliberate where three hundred is noise.
 * - 1M and up, from 6,000km: continent framing, 562 cities worldwide.
 * - 300k and up, from 2,000km: country framing, which is acceptance criterion 4's "readable
 *   at country zoom". At 800km over the UK that is roughly twenty names, and the 100k band
 *   is still excluded because its own limit is 700km.
 * - 100k and up, from 700km: one country, or a large region.
 * - 50k and up, from 250km: a metropolitan area and its neighbours.
 * - everything else, from 80km: the city view, where towns are what is left to add. At
 *   street zoom the view rectangle is a couple of kilometres across, so this is one or two
 *   names rather than an overdrawn map.
 */
export const POPULATION_BANDS: readonly PopulationBand[] = [
  { minPopulation: 5_000_000, farM: 25_000_000, ...PROMINENT },
  { minPopulation: 1_000_000, farM: 6_000_000, ...PROMINENT },
  { minPopulation: 300_000, farM: 2_000_000, ...NORMAL },
  { minPopulation: 100_000, farM: 700_000, ...NORMAL },
  { minPopulation: 50_000, farM: 250_000, ...QUIET },
  SMALLEST_BAND,
];

/**
 * The most labels the collection ever holds.
 *
 * Not a readability limit: banding and the view rectangle are stricter than this at every
 * zoom, and the budget only bites over somewhere as dense as the Randstad. It is a ceiling
 * on glyph billboards, so a pathological view cannot become a multi-second rebind. 600 names
 * is roughly 5,000 glyphs, which Cesium uploads without a hitch.
 */
export const CITY_LABEL_BUDGET = 600;

/**
 * The screen cell a city label claims, in pixels, and one label is drawn per cell.
 *
 * Banding and the budget decide *which* cities are candidates; nothing decided whether two of them
 * landed on top of each other. Measured 2026-08-23 against the real file, applying these bands and
 * this early exit at a 1400x800 viewport: at 300km over the Randstad 33 labels produced **22
 * overlapping pairs**, with 15 of the 33 in a collision. Over Tokyo it was **122 labels and 168
 * pairs**, which is the real worst case and is not city zoom at all. Unreadable text is worse than
 * absent text, so something had to give.
 *
 * 96 rather than 48 or 64, chosen by simulating the rule over the same views. Residual overlapping
 * pairs at 48px were 1, 6, 4, 5 and 11 across the Randstad, London, the Ruhr, the Randstad at 80km
 * and Tokyo. At 96px they are 0, 2, 0, 1 and 2. It costs labels: Tokyo keeps 40 of 122 rather than
 * 67. That is the right direction, because the ones kept are always the largest populations and 122
 * names in one frame was illegible whatever it said.
 *
 * It does not eliminate collisions and is not meant to. Cells are square and axis-aligned, so two
 * labels in neighbouring cells can still touch; removing the last pair needs real box-overlap
 * testing, which is quadratic in a method that runs on every camera move. Two pairs out of 122
 * candidates for linear cost is the trade.
 *
 * **What this measures changed on 2026-08-24 and so did the figure.** It used to be one label per
 * cell, sized to be roughly one name wide, and the exclusion distance was therefore this number. A
 * name now claims every cell its own painted box covers, so the exclusion distance is the name's
 * width and this is only the grid the box is quantised onto. Finer is strictly better for accuracy
 * and costs a slightly longer walk per label.
 *
 * Ninety-six was far too coarse once it meant that. A sixty-three pixel box straddling a boundary
 * claimed two cells, so it excluded a hundred and ninety-two pixels: three times its own width, and
 * names that would have fitted were dropped. Swept live against the real feeds at four zooms, with
 * overlapping label pairs at zero throughout and names kept as the thing to maximise:
 *
 * - 96px: 13, 14, 26 and 12 names at Europe 12,000km, China 12,000km, Europe 3,000km and Randstad
 *   300km
 * - 48px: 15, 19, 30, 16
 * - 32px: 14, 20, 30, 17
 * - **24px: 17, 25, 33, 20**
 *
 * Twenty-four keeps the most names and still has no pair touching, which is the whole point: the box
 * is what excludes, so a finer grid drops fewer names *without* letting any of them collide. It is
 * about a third of a typical name's width, so the quantisation error is bounded at a third of a name,
 * and going finer buys progressively less for a longer walk.
 *
 * Worth stating plainly because it is the unusual case: this is not a trade. Before any of it, a
 * China-centred view drew 22 names with Cairo and Baghdad colliding. It now draws 25 with nothing
 * colliding, so the fix costs no names at all and returns three.
 *
 * The projection is a real one now. This used to derive the cell from the view rectangle by linear
 * interpolation, and that flat arithmetic is what caused the label-on-label collisions near the limb:
 * see `projectCity` for the two frames that proved it.
 */
export const CITY_LABEL_CELL_PX = 24;

/**
 * What the camera can see, plus how high it is.
 *
 * The rectangle itself is `ViewRect` from `globe/project`, shared with the mover layers:
 * three layers now ask "is this point on screen" and one wrong antimeridian test in one of
 * them would be a plausible answer about the wrong half of the world.
 */
export interface CityView extends ViewRect {
  /** Metres above the ellipsoid. Also the smallest possible camera-to-label distance. */
  heightM: number;
}

const RADIANS_TO_DEGREES = 180 / Math.PI;

/**
 * What the camera currently sees.
 *
 * `computeViewRectangle` answers undefined when the view is not a rectangle on the
 * ellipsoid, which happens looking at the limb from a long way out, so that degrades to the
 * whole world rather than to an empty layer. The rectangle it does return has `west` greater
 * than `east` when the view crosses the antimeridian, which `inView` handles: this is one of
 * the four bounding-box conventions AGENTS.md lists, and it is Cesium's, in radians.
 */
export function cityView(scene: Scene): CityView {
  const heightM = scene.camera.positionCartographic.height;
  const rectangle = scene.camera.computeViewRectangle();
  if (rectangle === undefined) {
    return { west: -180, south: -90, east: 180, north: 90, heightM };
  }
  return {
    west: rectangle.west * RADIANS_TO_DEGREES,
    south: rectangle.south * RADIANS_TO_DEGREES,
    east: rectangle.east * RADIANS_TO_DEGREES,
    north: rectangle.north * RADIANS_TO_DEGREES,
    heightM,
  };
}

/** The band a population falls in. */
export function bandFor(population: number): PopulationBand {
  return POPULATION_BANDS.find((band) => population >= band.minPopulation) ?? SMALLEST_BAND;
}

function sameView(left: CityView | null, right: CityView): boolean {
  return (
    left !== null &&
    left.west === right.west &&
    left.south === right.south &&
    left.east === right.east &&
    left.north === right.north &&
    left.heightM === right.heightM
  );
}

const scratch = new Cartesian3();

export class CityLayer {
  private readonly labels: LabelCollection;
  /** The whole gazetteer, population descending. Sorted here, never trusted from the wire. */
  private records: readonly City[] = [];
  /** Labels by index. Below `drawn` is in use; at or above it is hidden and spare. */
  private readonly pool: Label[] = [];
  /** One `DistanceDisplayCondition` per band limit, so a refresh allocates none. */
  private readonly conditions = new Map<number, DistanceDisplayCondition>();
  /**
   * GeoNames id to record, built on the first lookup and null until then.
   *
   * Lazy rather than built in `load`, because `load` runs on every gazetteer read and most
   * sessions never click a city or search for one. Eager would be 34,099 entries that every
   * user pays for and almost none of them use, on the one path that already has the whole
   * file in hand and is competing with the first frame.
   *
   * It cannot be the `records` array itself: that is sorted by population, because the
   * visible-set scan and its early exit both depend on that order, so an id lookup over it
   * would be a linear walk of the whole gazetteer per click.
   */
  private index: Map<number, City> | null = null;
  private readonly scene: Scene;
  /** Cells already claimed this pass. Records run population-descending, so the first wins. */
  private readonly claimed = new Set<number>();
  private drawn = 0;
  private visible = true;
  private lastView: CityView | null = null;
  private scannedCount = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.labels = new LabelCollection({ scene });
    scene.primitives.add(this.labels);
  }

  /** How many labels are currently drawn. */
  get count(): number {
    return this.drawn;
  }

  /** How many cities the layer holds, drawn or not. */
  get held(): number {
    return this.records.length;
  }

  /**
   * Records the last `refresh` looked at before it stopped.
   *
   * Exposed so the early exit is proved rather than claimed: a world view must not walk
   * 34,072 rows to find the fifty-nine cities it draws.
   */
  get scanned(): number {
    return this.scannedCount;
  }

  /**
   * How many records the id index holds, and zero until something has asked for one.
   *
   * Exposed for the same reason `scanned` is: the laziness in `cityFor` is a claim about work
   * not done, and a claim about work not done is worth nothing unless a test can see it. This
   * is what stops a later edit quietly moving the build into `load` with every test still
   * green.
   */
  get indexed(): number {
    return this.index?.size ?? 0;
  }

  /**
   * The gazetteer row for one GeoNames id, or null when nothing is held for it.
   *
   * Here rather than in `main.ts` because two routes reach the same place card, a click on a
   * label and a pick from the search box, and one lookup in two places is how the two drift
   * apart. The layer already holds every record, so this is the accessor next to the data
   * rather than a second copy of it.
   *
   * Over everything held, not over what is drawn. Banding and the label budget mean most of
   * the gazetteer is not on screen at any zoom, and the search box reaches a town the camera
   * is nowhere near, so an index of the visible set would answer null for most real lookups.
   *
   * The id is GeoNames' own primary key and the merge key this layer sorts on, so there is no
   * last-one-wins question to answer here: two records cannot share one.
   */
  cityFor(geonamesId: number): City | null {
    this.index ??= new Map(this.records.map((city) => [city.geonames_id, city]));
    return this.index.get(geonamesId) ?? null;
  }

  /**
   * Take the gazetteer. Cities do not move, so this happens once and never on a cadence.
   *
   * Sorted here rather than relying on the server having done it. `/api/cities` does answer
   * population descending, but the budget below picks "the biggest cities in view" by taking
   * the first ones it finds and the early exit assumes the order too, so an out-of-order
   * payload would quietly draw the wrong cities. Sorting 34,072 records once costs
   * milliseconds and makes the invariant the layer's own.
   */
  load(cities: readonly City[]): void {
    this.records = cities.toSorted(
      (left, right) => right.population - left.population || left.geonames_id - right.geonames_id,
    );
    this.lastView = null;
    // Dropped rather than rebuilt, which is the whole of the laziness: a reload that nothing
    // ever looks up costs nothing, and one that is looked up rebuilds on that lookup. Holding
    // the old index here would answer a click with the previous gazetteer.
    this.index = null;
  }

  /**
   * Repaint for a camera position. Returns whether anything changed, so the caller knows
   * whether to ask for a frame.
   *
   * Cheap enough to call from anywhere, per frame included: an unchanged view is five number
   * comparisons and a switched-off layer is one boolean. Nothing here allocates, nothing is
   * added to or removed from the collection, and nothing touches the network.
   */
  refresh(view: CityView): boolean {
    if (!this.visible || sameView(this.lastView, view)) {
      return false;
    }
    this.lastView = view;
    this.claimed.clear();
    // Cell arithmetic once per pass rather than per city.
    const columns = Math.max(1, Math.ceil(this.scene.drawingBufferWidth / CITY_LABEL_CELL_PX));
    // The badge lattice, so a name can hold the pixels it occupies and push a cluster badge aside.
    // Released and re-made in the same pass, like every other holder, so it can never go stale.
    badgeSlots.begin(
      this.scene.drawingBufferWidth,
      this.scene.drawingBufferHeight,
      CLUSTER_CELL_PX,
    );
    badgeSlots.release(CITY_SLOT_KEY);
    const camera = this.scene.camera;
    Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, scratchMatrix);
    const eye = camera.positionWC;
    let used = 0;
    let scanned = 0;
    for (const city of this.records) {
      const band = bandFor(city.population);
      // The camera can be no closer to any point on the ellipsoid than its own height, so a
      // band whose limit is nearer than that is invisible everywhere in this view. Records
      // run population descending and band limits never rise as population falls, so every
      // record left is invisible too.
      if (band.farM < view.heightM) {
        break;
      }
      scanned += 1;
      if (!pointInView(view, city.point.lon, city.point.lat)) {
        continue;
      }
      // Where this city actually lands, through the camera's own projection. A cheap rectangle test
      // first, because projecting five thousand records to reject most of them is the wrong order.
      if (!this.projectCity(city, eye)) {
        continue;
      }
      // One name per patch of screen, and the first to claim one wins. Records run population
      // descending, so that is always the largest city in the patch, which is the right one to
      // keep: at 300km over Tokyo 122 labels produced 168 overlapping pairs, and unreadable text
      // is worse than absent text.
      const box = this.labelBox(band, city.name);
      if (this.crowded(box, columns)) {
        continue;
      }
      this.claim(box, columns);
      this.write(used, city, band);
      this.reserveLabelSpace(box);
      used += 1;
      if (used === CITY_LABEL_BUDGET) {
        break;
      }
    }
    this.hideFrom(used);
    this.drawn = used;
    this.scannedCount = scanned;
    return true;
  }

  /**
   * Switch the whole layer off from the rail.
   *
   * One flag on one collection, and `refresh` returns immediately while it is off, so a layer
   * that is switched off costs nothing at all: no per-frame work, no glyph rebind, no add or
   * remove on the collection, and no request. The labels stay exactly as they were, so
   * switching back on draws the picture already built and then repaints for wherever the
   * camera has moved to in the meantime, which is what clearing the remembered view does.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.labels.show = visible;
    if (visible) {
      this.lastView = null;
    } else {
      // A dark layer that kept its lattice points would push every other layer's badges aside for as
      // long as it stayed off, which reads as the other layers being wrong.
      badgeSlots.release(CITY_SLOT_KEY);
    }
  }

  /**
   * Retire the labels a smaller visible set no longer needs.
   *
   * Every index below `drawn` was written through `label`, so the pool always holds one, and
   * going back through the same accessor keeps that fact in one place instead of leaving a
   * branch here for a case that cannot happen.
   */
  private hideFrom(used: number): void {
    for (let index = used; index < this.drawn; index += 1) {
      const label = this.label(index);
      label.show = false;
      // Cleared as well as hidden: an empty label hands its glyph billboards back to Cesium's
      // own spare pool, where a hidden one holding text keeps them.
      label.text = '';
      // And the id goes with the text, the way the mover layers clear theirs in `release`. A
      // label with no text has no glyph billboards to pick, so this is belt and braces rather
      // than the guard, but a retired label still carrying an id is a click opening the card
      // for a city that left the screen.
      label.id = undefined;
    }
  }

  private write(index: number, city: City, band: PopulationBand): void {
    const label = this.label(index);
    // Written here rather than in `label`, because the pool reuses one label for a different
    // city on every camera move and the id has to follow the city rather than the slot. It is
    // metadata Cesium only ever hands back from `Scene#pick`: nothing about the label's
    // appearance, its glyphs, its display condition or the visible set depends on it, so the
    // picture this layer draws is byte for byte what it drew before.
    //
    // Set before the text on purpose, and that ordering is safe rather than lucky. Changing
    // the text is what rebinds the glyphs, and Cesium's rebind copies the label's current id
    // onto every glyph billboard it writes (`T.id = t._id` in the label glyph loop, verified
    // in the shipped 1.135 bundle) along with `pickPrimitive`. So the id survives the rebind
    // that the next line triggers. Setting it after would work too; assuming either without
    // checking is how a layer ends up unpickable with nothing to show for it.
    label.id = `${CITY_PICK_PREFIX}${city.geonames_id}`;
    label.text = city.name;
    label.font = band.font;
    label.fillColor = cesiumColour(band.colour);
    label.distanceDisplayCondition = this.condition(band.farM);
    Cartesian3.fromDegrees(city.point.lon, city.point.lat, 0, undefined, scratch);
    // The setter clones, so one scratch vector serves the whole refresh.
    label.position = scratch;
    label.show = true;
  }

  /**
   * Hold the pixels this label paints, so no cluster badge is drawn on top of the name.
   *
   * Placed on the point `projectCity` computed, which is the same point the decluttering cell uses
   * and the same space the badges live in. That agreement is the whole of why this works; see
   * `projectCity` for what happened when the two disagreed.
   */
  /**
   * Where a city lands on screen, or false when the camera cannot see it.
   *
   * **One projection per city, feeding both the decluttering cell and the label reservation.** They
   * used to disagree: the reservation projected properly while the cell interpolated longitude and
   * latitude linearly across the view rectangle, and that flat arithmetic is what caused the
   * label-on-label collisions this layer shipped with. Proved by two frames of the same build ten
   * minutes apart on 2026-08-24: centred on Europe, Shanghai and Hangzhou stacked and Chengdu ran
   * into Chongqing, all four on the right limb, while the centre was clean. Centred on China, the
   * same Shanghai read clean and separate and **Cairo and Baghdad stacked instead**, 13 degrees apart
   * on the new left limb. The collisions followed the limb rather than the cities.
   *
   * The reason is the one the deleted `cellFor` comment gave about itself: near the limb a degree of
   * longitude compresses to almost nothing on screen, so two cities thirteen degrees apart land in
   * the same few pixels while flat arithmetic puts them in different cells and lets both draw. The
   * grid was doing what it was told; it was being told the wrong positions.
   *
   * The occlusion test earns its place twice over here. It keeps the reservation off names nobody can
   * see, and it stops the label budget being spent on the far side of the globe, which the rectangle
   * test cannot catch because a hemisphere away is still inside a whole-world rectangle.
   */
  private projectCity(city: City, eye: Cartesian3): boolean {
    Cartesian3.fromDegrees(city.point.lon, city.point.lat, 0, undefined, scratch);
    if (occludedByGlobe(eye.x, eye.y, eye.z, scratch.x, scratch.y, scratch.z)) {
      return false;
    }
    return projectToScreen(
      scratchMatrix,
      scratch.x,
      scratch.y,
      scratch.z,
      this.scene.drawingBufferWidth,
      this.scene.drawingBufferHeight,
      screenAt,
    );
  }

  /**
   * The pixels a name paints, centred on `screenAt`.
   *
   * `measureText` answers in CSS pixels and both grids are in drawing-buffer pixels. They are the
   * same today, because Cesium leaves `pixelRatio` at one unless `resolutionScale` is changed, and
   * measured at device scale factors of one, two and three the buffer stayed equal to the client size
   * and a badge painted a constant 37 pixels. The ratio is carried anyway: it costs a divide and it is
   * the difference between this working and measuring half a name if anyone ever asks Cesium for a
   * sharper canvas.
   */
  private labelBox(band: PopulationBand, name: string): { width: number; height: number } {
    const perCssPx = this.scene.drawingBufferWidth / (this.scene.canvas.clientWidth || 1);
    const fontPx = Number(/(\d+)px/.exec(band.font)?.[1] ?? 12);
    return {
      width: textWidthPx(name, band.font, fontPx) * perCssPx + LABEL_PAINT_MARGIN_PX,
      height: fontPx * perCssPx + LABEL_LINE_MARGIN_PX,
    };
  }

  /**
   * Whether a name at `screenAt` would land on a patch a bigger name already holds.
   *
   * **Every cell the box covers, not the one its centre falls in.** That single-cell test is what left
   * Cairo and Alexandria touching after the projection was fixed: two and a half degrees apart, either
   * side of a cell boundary, so both claimed a free cell and both drew. It is the same defect the badge
   * lattice had, where reserving one cell left the cell next door free and the badge that landed there
   * still overlapped, and it takes the same answer.
   *
   * Conservative by a cell at worst. Two boxes sharing a cell might not actually intersect, if one ends
   * early in the cell and the next starts late, so this drops a name that would just have fitted. That
   * is the right direction to err and it is the direction the single-cell version erred in too.
   */
  private crowded(box: { width: number; height: number }, columns: number): boolean {
    return this.forEachCell(box, columns, (cell) => this.claimed.has(cell));
  }

  /** Hold every cell the box covers, so no smaller name is drawn onto this one. */
  private claim(box: { width: number; height: number }, columns: number): void {
    this.forEachCell(box, columns, (cell) => {
      this.claimed.add(cell);
      return false;
    });
  }

  /** Walk the cells a box centred on `screenAt` covers, stopping early if the visitor says so. */
  private forEachCell(
    box: { width: number; height: number },
    columns: number,
    visit: (cell: number) => boolean,
  ): boolean {
    const first = Math.floor((screenAt.x - box.width / 2) / CITY_LABEL_CELL_PX);
    const last = Math.floor((screenAt.x + box.width / 2) / CITY_LABEL_CELL_PX);
    const top = Math.floor((screenAt.y - box.height / 2) / CITY_LABEL_CELL_PX);
    const bottom = Math.floor((screenAt.y + box.height / 2) / CITY_LABEL_CELL_PX);
    const rows = Math.max(1, Math.ceil(this.scene.drawingBufferHeight / CITY_LABEL_CELL_PX));
    for (let column = Math.max(0, first); column <= Math.min(columns - 1, last); column += 1) {
      for (let row = Math.max(0, top); row <= Math.min(rows - 1, bottom); row += 1) {
        if (visit(row * columns + column)) {
          return true;
        }
      }
    }
    return false;
  }

  private reserveLabelSpace(box: { width: number; height: number }): void {
    badgeSlots.reserve(
      CITY_SLOT_KEY,
      screenAt.x,
      screenAt.y,
      box.width + LABEL_KEEP_OUT_PX,
      box.height + LABEL_KEEP_OUT_PX,
    );
  }

  /** The pooled label at this index, allocating only when the pool has never been this deep. */
  private label(index: number): Label {
    const existing = this.pool[index];
    if (existing !== undefined) {
      return existing;
    }
    const made = this.labels.add({
      position: Cartesian3.ZERO,
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      // Centred on the place rather than offset from a dot, because there is no dot. A city
      // is a name on the map; the aircraft treatment of a dot with the callsign beside it is
      // for things whose position is the thing being read.
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.CENTER,
    });
    this.pool.push(made);
    return made;
  }

  /**
   * The shared display condition for a band limit.
   *
   * Cesium's setter clones what it is given, so one object per band serves every label in it
   * and a refresh over six hundred cities allocates six of these at most, once.
   */
  private condition(farM: number): DistanceDisplayCondition {
    const existing = this.conditions.get(farM);
    if (existing !== undefined) {
      return existing;
    }
    const made = new DistanceDisplayCondition(0, farM);
    this.conditions.set(farM, made);
    return made;
  }
}
