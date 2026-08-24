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
  VerticalOrigin,
} from 'cesium';
import type { Label, Scene } from 'cesium';

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
 * Roughly one label wide, which is why the figure is physical rather than tuned: a ten-character
 * name is about 66px at 12px type and a long one passes 100px.
 *
 * The cell is derived from the view rectangle and the viewport rather than from a real projection.
 * `globe/cluster.ts` would give a better answer, with a proper camera matrix and a horizon test,
 * and it is what the mover layers use. It is not used here because this layer's whole suite runs
 * against a mocked Cesium whose `Cartesian3.fromDegrees` passes degrees straight through, so real
 * projection maths cannot consume it, and switching would mean giving 45 tests a real camera and
 * changing them from rectangle semantics to camera semantics. That is the rewrite this fix was
 * asked not to become. The cost of the cheaper route is that the cell inherits the rectangle's
 * known unreliability at altitude, which is already recorded as a limitation: where the rectangle
 * is wrong the cells are wrong in the same direction, so this makes nothing worse than it was.
 */
export const CITY_LABEL_CELL_PX = 96;

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
      // One label per screen cell, and the first to claim one wins. Records run population
      // descending, so that is always the largest city in the cell, which is the right one to
      // keep: at 300km over Tokyo 122 labels produced 168 overlapping pairs, and unreadable text
      // is worse than absent text.
      const cell = this.cellFor(view, city.point.lon, city.point.lat, columns);
      if (this.claimed.has(cell)) {
        continue;
      }
      this.claimed.add(cell);
      this.write(used, city, band);
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

  /**
   * Which screen cell a point falls in, from the view rectangle and the viewport.
   *
   * The same wrap convention as `pointInView`: a rectangle whose `west` exceeds its `east` crosses
   * the antimeridian, and the longitude offset has to be taken the long way round for it.
   *
   * Latitude is used as it comes rather than corrected for the projection. Over a view a few
   * hundred kilometres across the error is small, and the cell is a legibility heuristic rather
   * than a measurement: being a cell out at the top of a tall view costs one name.
   */
  private cellFor(view: CityView, lon: number, lat: number, columns: number): number {
    const spanLon = view.west <= view.east ? view.east - view.west : 360 - view.west + view.east;
    const spanLat = view.north - view.south;
    const offsetLon = lon >= view.west ? lon - view.west : 360 - view.west + lon;
    // A degenerate rectangle would divide by zero and put every city in cell 0, which is a
    // one-label view rather than a crash.
    const fx = spanLon > 0 ? offsetLon / spanLon : 0;
    const fy = spanLat > 0 ? (view.north - lat) / spanLat : 0;
    const column = Math.floor((fx * this.scene.drawingBufferWidth) / CITY_LABEL_CELL_PX);
    const row = Math.floor((fy * this.scene.drawingBufferHeight) / CITY_LABEL_CELL_PX);
    return row * columns + column;
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
