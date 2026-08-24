/**
 * The cloud layer: what the weather satellites see right now, as three imagery sheets.
 *
 * Keyless, straight from NASA GIBS, the same host and the same WMTS endpoint as the basemap
 * in `globe/viewer.ts`. Nothing here touches our backend: the browser asks NASA for tiles
 * and NASA answers, so this layer works against a backend that is not running and reports
 * its own availability rather than reading it off `/api/capabilities`.
 *
 * **Geostationary, not polar-orbiting, and that is the whole reason it says "now".** The
 * basemap is a polar-orbiter mosaic: one pass per day per spacecraft, stitched, and a day
 * old by the time it is complete. A geostationary satellite stares at one face of the Earth
 * and GIBS publishes a fresh frame every ten minutes, which is what makes a cloud on this
 * layer a cloud that is there rather than a cloud that was there yesterday.
 *
 * **Three sheets because GIBS carries three geostationary satellites and no composite.**
 * Verified against the WMTS GetCapabilities document on 2026-08-23: GOES-East, GOES-West and
 * Himawari, at ten-minute cadence, and nothing that merges them. There is no Meteosat layer
 * at all, so longitudes from the Greenwich meridian to 60°E have no cloud imagery here,
 * and {@link cloudGapInView} exists so the rail can say that rather than let a user read an
 * empty Africa as a broken renderer.
 *
 * **`Band13_Clean_Infrared` rather than `GeoColor`, and not for looks.** GeoColor is the
 * prettier product but GIBS publishes it for the two GOES satellites only, so it would leave
 * the western Pacific and Australia uncovered. Band 13 is the 10.3 micron clean infrared
 * window, published for all three, and it is thermal: it sees cloud tops at night as well as
 * by day, where a visible band would go black over half the globe every frame. Cloud tops
 * are cold, so they come out bright, and the warm surface underneath comes out mid grey.
 *
 * **A 404 from this host has three different meanings and only one of them is a fault.**
 * Anyone opening the console will see one eventually, so they are worth telling apart, and all
 * three were measured on 2026-08-23 rather than inferred.
 *
 * A tile outside the satellite's own footprint answers 404 rather than serving transparency.
 * `GOES-East` at level 2, row 1, column 3 is longitudes 90°E to 180°E, on the far side of the
 * planet from a spacecraft over Brazil, and it answered 404 on six of six attempts. The
 * per-satellite slices below exist to stop Cesium ever asking: with them in place, 532 tile
 * requests across nine camera positions produced two 404s, both at one disk corner a
 * rectangle cannot help overhanging, against sixteen from the VIIRS basemap in the same run.
 *
 * A frame GIBS has not built yet answers 404, and the newest frame always is one. So nothing here
 * pins a slot it has not had a tile back for: see {@link newestCloudSlot}, which walks until one
 * answers instead of believing what the provider says its newest frame is.
 *
 * And a 404 can simply be wrong. The same tile URL answered 404, 404, then 200 with 80,131
 * bytes behind it. So a single 404 is not evidence that a tile does not exist, and a 404 on a
 * coarse tile in particular is almost certainly this: at level 1 a tile is a quarter of the
 * world and contains the whole disk, so it cannot be a footprint edge. `Himawari` at level 1,
 * row 0, column 1 answered 200 on six of six attempts when checked.
 *
 * **The layer name is ours, like `cities`.** The backend's `LayerName` union is the set of
 * layers the WebSocket carries deltas for, and imagery has none.
 */

import {
  Credit,
  ImageryLayer,
  Rectangle,
  WebMapTileServiceImageryProvider,
  WebMercatorTilingScheme,
} from 'cesium';
import type { ImageryLayerCollection, ImageryTypes } from 'cesium';

import type { LayerCapability } from '../../types/entities';
import { CLOUD_CREDIT_TEXT } from '../../ui/attribution';
import type { ViewRect } from '../project';

/**
 * The layer name the rail and the shareable URL use.
 *
 * A plain string rather than a `LayerName` for the same reason `CITY_LAYER` is: that union
 * is the set of layers the socket carries deltas for, and a NASA tile pyramid is not one.
 */
export const CLOUD_LAYER = 'clouds';

const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

/**
 * The only tile matrix set these three layers publish in EPSG:3857, and its deepest level.
 *
 * Read off GetCapabilities rather than assumed: the geostationary layers are `Level6` where
 * the basemap is `Level9`, and level indices are zero-based, so this set stops at 6. Asking
 * for level 7 is a 404 per tile rather than a coarser picture.
 */
const TILE_MATRIX_SET = 'GoogleMapsCompatible_Level6';
const MAXIMUM_LEVEL = 6;

/**
 * How far the disks reach in latitude, in degrees.
 *
 * A geostationary satellite sees about 81 degrees either side of its sub-satellite point.
 * Beyond that there is nothing to request, and Web Mercator has no tiles past 85 anyway.
 */
const DISK_LATITUDE = 81;

/** GIBS publishes a new frame for each of these every ten minutes. */
export const CLOUD_SLOT_MINUTES = 10;

/**
 * How far behind the clock the newest frame worth asking for is, in minutes.
 *
 * Measured on 2026-08-23 at 09:57 UTC against all three layers: the 09:40 and 09:50 slots
 * answered 404 on three attempts each, and the newest slot that returned image bytes was
 * 09:30 for GOES-West and 09:20 for GOES-East and Himawari, so between 26 and 36 minutes
 * old. The capabilities document's own `Default` time agreed, at 09:10 to 09:20.
 *
 * So this is where the walk starts, not where it stops. A request for a slot GIBS has not built
 * yet is a 404, and a naive "now" would 404 every tile on the globe and read as a layer that is
 * broken rather than one that is waiting. It is deliberately a little conservative: overshooting
 * costs one wasted `HEAD`, and undershooting draws nothing.
 */
export const CLOUD_LATENCY_MINUTES = 20;

/**
 * Why {@link newestCloudSlot} takes the second frame that answers rather than the first.
 *
 * **A frame that answers is not a frame that is finished.** GIBS publishes a slot tile by tile,
 * and the level-zero tile the probe asks for is an early one, so a slot can answer while most of
 * its pyramid is still missing. Measured 2026-08-24 at 10:01 UTC on GOES-East, against the ten
 * tile addresses a whole-globe frame actually requested:
 *
 * | slot | tiles present | probe tile answers |
 * | --- | --- | --- |
 * | 09:40 and newer | 0 of 10 | no |
 * | 09:30 | 2 of 10 | **no**, so the probe tile is not even the first built |
 * | **09:20** | **9 of 10** | **yes**, and this is what the walk used to return |
 * | 09:10 | 10 of 10 | yes |
 * | 09:00 | 10 of 10 | yes |
 *
 * So the newest answering slot was 90% built, and the missing tenth is exactly the scatter of
 * tile 404s that showed in the console. One slot older was complete. The cost of the margin is
 * ten minutes of staleness on a product whose frames are ten minutes apart and which is already
 * twenty to fifty minutes behind the clock, so it is the cheapest thing in this file.
 *
 * **Two slots rather than one, and the second slot was bought by a screenshot.** A margin of one
 * left five failed requests on a whole-globe frame, and the missing tiles are visible: a tile is
 * a quarter or a sixteenth of the sheet at the levels a whole-globe view draws, so a hole in the
 * frame is a rectangular step in the sheet. Compared against `#off=clouds` on the same sky, the
 * North Atlantic was clean without the layer and had a flat region with tile-shaped edges with
 * it, which is the same "reads as a broken render" complaint one cause further down.
 *
 * **A deeper probe tile would not have helped, and that is worth writing down.** The obvious fix
 * is to probe a tile built late in the pyramid instead of level zero. Measured 2026-08-24 at
 * 10:06 UTC, GIBS builds a frame in **no pyramid order at all**: GOES-West's 09:40 had level 3
 * present while levels 0, 1, 2 and 4 were absent, and GOES-East's 09:30 had levels 3 and 4
 * present while level 0 was **missing**. So no single tile, shallow or deep, is evidence about
 * any other tile, and the only cheap lever is time.
 *
 * Two slots was complete on both layers at both moments measured, at 10:01 and at 10:06. The
 * cost is twenty minutes of staleness in total, which for a cloud layer already twenty to fifty
 * minutes behind is not material, and a complete frame is worth more than ten minutes of
 * currency. It is still not a guarantee, and it is deliberately not papered over with a
 * swallowed tile error, because a layer that quietly draws nothing is the failure this file has
 * already made once today.
 */
export const CLOUD_COMPLETE_MARGIN = 2;

/**
 * How many ten-minute slots back to walk before giving up, which is 90 minutes.
 *
 * Long enough to cover the worst latency measured plus an ingest gap, short enough that a
 * layer NASA has genuinely stopped publishing says so instead of walking into last week.
 */
export const CLOUD_SLOT_CANDIDATES = 8;

/** Re-probe on the source's own cadence. A slot lasts ten minutes; so does this. */
export const CLOUD_REFRESH_MS = CLOUD_SLOT_MINUTES * 60 * 1000;

/** One geostationary satellite, and the slice of longitude this build asks it about. */
export interface CloudSatellite {
  /** How the rail names it when its imagery is missing. */
  readonly name: string;
  /** The GIBS WMTS layer identifier, verbatim from GetCapabilities. */
  readonly layer: string;
  /** Western edge of the slice, degrees, contract order. */
  readonly west: number;
  /** Eastern edge of the slice, degrees. */
  readonly east: number;
  /**
   * Longitude the satellite sits over, degrees. What every angle here is measured from.
   *
   * Present because the slice cannot express what the instrument can see. A slice is a
   * rectangle and a disk is a circle, so the poleward corners of a slice are further off
   * nadir than anything at the equator, and it is those corners that both 404 and paint.
   */
  readonly subLon: number;
}

/**
 * The three satellites, each asked only about the longitudes it is nearest overhead.
 *
 * The slices do not overlap, and that is deliberate. Each disk really reaches 81 degrees
 * either side of its sub-satellite point, so GOES-East (75.2°W) and GOES-West (137°W) both
 * cover the whole of North America. Handing Cesium two sheets of the same sky means the top
 * one wins, and at the edge of a disk the imagery is smeared across the limb, so the top one
 * winning would put the worse picture over the better one. Cutting each slice at the
 * midpoint between neighbouring sub-satellite points instead gives every longitude to
 * whichever satellite is looking most nearly straight down at it, and stops Cesium
 * requesting a tile two providers would both answer.
 *
 * Listed west to east. The order they are added in does not matter now that they do not
 * overlap, which is the point of cutting them this way.
 */
export const CLOUD_SATELLITES: readonly CloudSatellite[] = [
  // GOES-West sits at 137°W. Its slice runs from the antimeridian to the midpoint between
  // it and GOES-East, which is 106°W.
  {
    name: 'GOES-West',
    layer: 'GOES-West_ABI_Band13_Clean_Infrared',
    west: -180,
    east: -106,
    subLon: -137,
  },
  // GOES-East sits at 75.2°W and its disk ends at 5.8°E, which is why London is on this
  // layer at all and why Cairo is not. Verified: a tile over London returned bytes and a
  // tile over Cairo returned a fully transparent one.
  //
  // Stopped at the meridian rather than at that 5.8, and the missing six degrees buy a quiet
  // console. A rectangle cannot fit a disk, so its poleward corners ask for tiles GIBS never
  // built and answers 404 for, and a 404 in a browser is a red line in the console whether or
  // not the code expected it. Measured on 2026-08-23 over nine camera positions from the
  // Arctic to the Antarctic: an east edge of 6 cost seven 404s at this disk's north-east and
  // south-east corners, and an east edge of 0 cost none. What is given up is a six-degree
  // strip over the North Sea and Belgium, seen at better than 80 degrees off nadir where a
  // pixel is smeared six times its width. London sits at 0.12°W and stays.
  {
    name: 'GOES-East',
    layer: 'GOES-East_ABI_Band13_Clean_Infrared',
    west: -106,
    east: 0,
    subLon: -75.2,
  },
  // Himawari sits at 140.7°E, so its disk starts at 59.7°E and runs past the antimeridian.
  // The part east of the dateline is left to GOES-West, which is nearer overhead there.
  //
  // This is the one slice with a measured residual, and it is two tiles. Its western edge is
  // set by its own limb at the equator, and the disk narrows towards the poles, so the tile
  // covering 45°E to 67.5°E at 66°N to 74°N and its mirror in the south are outside what GIBS
  // built: they answer 404 when the camera is at a pole. Both alternatives cost more than
  // they save. Pulling the western edge in to 90°E to clear them would drop India and central
  // Asia off the layer, and capping the latitude at 66 would throw away real cloud over
  // eastern Siberia, where the same probe found imagery. Measured on 2026-08-23: over those
  // same nine camera positions this layer makes 529 tile requests and 2 of them 404, while
  // the VIIRS basemap that was already here makes 16 in the same run.
  {
    name: 'Himawari',
    layer: 'Himawari_AHI_Band13_Clean_Infrared',
    west: 60,
    east: 180,
    subLon: 140.7,
  },
];

/**
 * The longitudes no satellite in this list can see, degrees, contract order.
 *
 * Between GOES-East's eastern edge and Himawari's western limb: Europe east of the meridian,
 * most of Africa, the Middle East and the western Indian Ocean. Meteosat covers exactly this
 * and GIBS does not carry it, so the gap is a property of the source rather than of this code.
 */
export const CLOUD_GAP_WEST = 0;
export const CLOUD_GAP_EAST = 60;

/**
 * What the rail says when the camera is looking at the gap.
 *
 * Under 72 characters, which is `NOTICE_SUMMARY_MAX` in the rail, so it is shown outright
 * rather than shortened behind a click.
 */
export const CLOUD_GAP_NOTICE = 'No cloud cover from 0°E to 60°E: NASA GIBS carries no Meteosat';

/** The longest a reason may be, matching the cap the backend's own reasons are held to. */
export const CLOUD_REASON_MAX = 120;

/**
 * Whether the view overlaps the uncovered longitudes.
 *
 * A view that crosses the antimeridian has `west` greater than `east`, which is Cesium's
 * convention and the reason the longitude test is an or rather than an and. Getting it wrong
 * would answer confidently about the opposite half of the world.
 */
export function cloudGapInView(view: ViewRect): boolean {
  return view.west <= view.east
    ? view.west <= CLOUD_GAP_EAST && view.east >= CLOUD_GAP_WEST
    : view.west <= CLOUD_GAP_EAST || view.east >= CLOUD_GAP_WEST;
}

/**
 * One timestamp in the form GIBS' time dimension takes, floored to a published slot.
 *
 * `Z` rather than `+00:00`, and built here rather than taken from `toISOString` whole. The
 * offset form is what breaks CelesTrak's OMM reader elsewhere in this project, and a time
 * dimension is a URL path segment: a colon-and-plus form would be a different string to the
 * one GIBS published even where it means the same instant.
 */
export function cloudSlot(when: Date): string {
  const floored = new Date(when);
  floored.setUTCMinutes(
    Math.floor(floored.getUTCMinutes() / CLOUD_SLOT_MINUTES) * CLOUD_SLOT_MINUTES,
    0,
    0,
  );
  return `${floored.toISOString().slice(0, 19)}Z`;
}

/**
 * The slots worth asking for, newest first.
 *
 * Newest first because the first one that answers is the one we want, and every step back is
 * ten minutes of staleness bought to get a picture at all.
 */
export function cloudSlots(now: Date, count: number = CLOUD_SLOT_CANDIDATES): string[] {
  const newest = now.getTime() - CLOUD_LATENCY_MINUTES * 60 * 1000;
  return Array.from({ length: count }, (_unused, index) =>
    cloudSlot(new Date(newest - index * CLOUD_SLOT_MINUTES * 60 * 1000)),
  );
}

/**
 * The single tile used to find out whether a slot exists.
 *
 * Level zero of this matrix set is one 256-pixel tile holding the whole world, so it
 * contains part of every satellite's disk and is populated whenever the slot is. Cheaper
 * than reasoning about which tile a given sub-satellite point falls in, and it is a tile
 * Cesium is going to ask for anyway.
 */
export function cloudProbeUrl(satellite: CloudSatellite, slot: string): string {
  return `${GIBS_WMTS}/${satellite.layer}/default/${slot}/${TILE_MATRIX_SET}/0/0/0.png`;
}

/**
 * The tile template Cesium fills in per tile.
 *
 * Concatenated rather than written as a template literal, exactly as the basemap's URL is:
 * the braced names are Cesium's placeholders, and inside a template literal `{Time}` reads
 * as a mistyped `${Time}`.
 */
export function cloudTileTemplate(satellite: CloudSatellite): string {
  return (
    `${GIBS_WMTS}/${satellite.layer}/default/` +
    '{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png'
  );
}

/** What a probe learned: whether the tile is there, and which frame GIBS says it is. */
export interface TileAnswer {
  ok: boolean;
  /** The slot GIBS served, when it said. Null when the header was absent or malformed. */
  slot: string | null;
}

/** Asks GIBS about one tile. Injected so the tests need no network. */
export type TileProbe = (url: string) => Promise<TileAnswer>;

/** The header GIBS names the served frame in, and lists in its CORS expose header. */
const TIME_HEADER = 'layer-time-actual';

const SLOT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The frame GIBS says it served, or null.
 *
 * Checked against the shape rather than trusted, because this value goes back out as a path
 * segment in every tile URL afterwards. A header is upstream input like any other.
 */
export function slotFromHeader(value: string | null): string | null {
  return value !== null && SLOT_PATTERN.test(value) ? value : null;
}

/**
 * Ask GIBS about a tile without downloading it.
 *
 * `HEAD` rather than `GET`, verified on 2026-08-23 because a verb that works on one CDN is no
 * guarantee on another: this host answers 200 with a `Content-Length` and no body for a
 * populated slot and 404 for one it has not built, and sends `access-control-allow-origin: *`
 * plus an `access-control-expose-headers` naming `layer-time-actual` on both, so the browser
 * can read the status and the frame. The FAA's zip in AGENTS.md is the opposite case, 503 on
 * HEAD and the file on GET, which is why this was measured rather than assumed.
 */
export async function headTile(url: string): Promise<TileAnswer> {
  const response = await fetch(url, { method: 'HEAD' });
  return { ok: response.ok, slot: slotFromHeader(response.headers.get(TIME_HEADER)) };
}

/**
 * The newest slot this satellite actually has imagery for, or null if it has none.
 *
 * **Every candidate is asked for by name, and that is the fix for a layer that drew nothing.**
 * This used to ask GIBS for `default`, read the frame out of the `layer-time-actual` header and
 * take that as the answer, on the reasoning that a provider naming its own newest frame beats us
 * guessing. Measured 2026-08-24 at 09:42 UTC across all three layers, that header cannot be used
 * to address a tile:
 *
 * | layer | `default` names | asking for it by name | newest that serves |
 * | --- | --- | --- | --- |
 * | GOES-East | 09:20 | **404** | 09:10 |
 * | GOES-West | 08:50 | 200 | **09:20** |
 * | Himawari | 09:00 | **404** | 08:50 |
 *
 * Wrong in both directions. Two of the three name a frame that is not addressable, so the layer
 * pinned a slot on which **every tile 404s** and drew nothing; the third named a frame thirty
 * minutes staler than what was available, which would have drawn half-hour-old cloud as current
 * and said nothing about it. The second is the worse bug, because nobody would ever notice it.
 *
 * So the header is not consulted. The walk starts at {@link CLOUD_LATENCY_MINUTES} behind the
 * clock and takes the first slot that answers, which is the only method that establishes a slot
 * is addressable at all, and it finds the newest addressable frame rather than whichever one
 * `default` felt like naming. Measured cost at that same moment: two probes for GOES-East, one
 * for GOES-West, four for Himawari. Seven `HEAD` requests per ten-minute refresh for the whole
 * layer, against three full tile `GET`s before, so it is cheaper in bytes as well as correct.
 *
 * The walk is sequential on purpose. Firing all eight at once would be seven wasted requests
 * on the path where the first answers, against a provider whose cadence discipline is a rule
 * here rather than a preference.
 */
export async function newestCloudSlot(
  satellite: CloudSatellite,
  now: Date,
  probe: TileProbe,
): Promise<string | null> {
  const candidates = cloudSlots(now);
  for (const [index, slot] of candidates.entries()) {
    const answer = await probe(cloudProbeUrl(satellite, slot));
    if (!answer.ok) {
      continue;
    }
    // One slot older than the newest that answers, because a frame is built tile by tile and
    // the probe tile is an early one. See `CLOUD_COMPLETE_MARGIN`.
    const older = candidates[index + CLOUD_COMPLETE_MARGIN];
    if (older === undefined) {
      return slot;
    }
    // Bound before it is read: `(await x).ok` trips `unicorn/no-await-expression-member`, and
    // that rule has cost this repo a shared gate before.
    const behind = await probe(cloudProbeUrl(satellite, older));
    return behind.ok ? older : slot;
  }
  return null;
}

/**
 * What went wrong, in words, for a value that may not be an `Error` at all.
 *
 * The frontend twin of `sources.base.describe_exception`: several failures stringify to
 * nothing, and a reason that renders as an empty string is a broken layer saying nothing.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  return typeof error === 'string' && error.length > 0 ? error : 'unknown error';
}

/**
 * Why the layer has nothing to draw, capped so the rail can render it.
 *
 * Capped rather than trusted: a `TypeError` from a blocked request carries a sentence and a
 * half of Chrome's own wording, and the rail's row is not the place to discover that.
 */
export function cloudUnavailableReason(detail: string | null): string {
  const text =
    detail === null
      ? 'NASA GIBS published no cloud imagery in the last 90 minutes'
      : `NASA GIBS unreachable: ${detail}`;
  return text.length <= CLOUD_REASON_MAX ? text : `${text.slice(0, CLOUD_REASON_MAX - 1)}…`;
}

/**
 * One satellite's imagery, for one slot.
 *
 * The provider carries the rectangle rather than the layer, because the provider's rectangle
 * is what stops Cesium requesting a tile in the first place. On the layer it would only stop
 * the tile being drawn, so the request, the 404 and the console noise would all still happen.
 */
export function cloudImagery(
  satellite: CloudSatellite,
  slot: string,
): WebMapTileServiceImageryProvider {
  const provider = new WebMapTileServiceImageryProvider({
    url: cloudTileTemplate(satellite),
    layer: satellite.layer,
    style: 'default',
    format: 'image/png',
    tileMatrixSetID: TILE_MATRIX_SET,
    tilingScheme: new WebMercatorTilingScheme(),
    maximumLevel: MAXIMUM_LEVEL,
    rectangle: Rectangle.fromDegrees(satellite.west, -DISK_LATITUDE, satellite.east, DISK_LATITUDE),
    dimensions: { Time: slot },
    credit: new Credit(CLOUD_CREDIT_TEXT),
    enablePickFeatures: false,
  });
  // Every tile goes through the alpha keying on its way in. Patched on the instance rather
  // than behind a wrapper class because `ImageryProvider` has fourteen other members, and a
  // wrapper that forwarded thirteen of them correctly and one of them wrongly would be a bug
  // nobody could see. This is the only member whose behaviour changes.
  const request = provider.requestImage.bind(provider);
  provider.requestImage = (x, y, level, options) => {
    const bounds = tileBounds(x, y, level);
    // Not asked for at all when the whole tile is outside what this instrument can see. The
    // provider's rectangle cannot express a disk, so its poleward corners used to be requested
    // and 404ed: twelve of them on one whole-globe frame, and a 404 is a red console line
    // whether or not the code expected it. Answering with an empty tile is exactly what a 404
    // produced on screen, minus the request.
    if (tileNearestOffNadir(satellite.subLon, bounds) >= CLOUD_TRUST_LIMIT) {
      return Promise.resolve(blankTile(provider.tileWidth));
    }
    const pending = request(x, y, level, options);
    // A promise chain rather than an await, and it has to be. An `undefined` return is
    // Cesium's own signal that the request was throttled and the tile should be asked for
    // again later; an async function cannot return one, because it would wrap it in a
    // resolved promise and Cesium would take a deferred tile for a delivered blank one.
    // eslint-disable-next-line unicorn/prefer-await -- reason above
    return pending?.then((image) => paintCloudTile(image, satellite.subLon, bounds));
  };
  return provider;
}

/**
 * Where a pixel stops being sky and starts being cloud, in the product's own 0 to 255 grey.
 *
 * These two numbers are the whole answer to a sheet that veils the globe, and they are the
 * hardest thing in this file to get right, because **on this product grey level is
 * temperature, not cloudiness.** Band 13 is a thermal window: it reports how warm a thing is,
 * and cloud only looks like cloud because cloud tops are colder than the ground under them.
 * Nothing in the image says which is which.
 *
 * Measured 2026-08-23 across nine tiles, one per climate, as the percentage of grey pixels
 * falling in each 16-wide bin. The peak of each distribution is the surface:
 *
 * - Amazon rainforest, warm and wet: peak 48 to 95, nothing above 160.
 * - Tropical Atlantic: peak 96 to 111.
 * - Sahara by day: peak 96 to 127.
 * - Western Pacific: peak 96 to 127.
 * - North Atlantic at 50°N: peak 112 to 143.
 * - South Pacific at 30°S: peak 112 to 159.
 * - Australia: peak 112 to 159.
 * - **Southern Ocean at 65°S: nothing at all below 144, peak 160 to 175.**
 *
 * So there is no single grey that means "clear". A warm ocean sits at 104 and Antarctic sea
 * ice sits at 170, brighter than a good deal of real cloud, because it genuinely is that
 * cold. One threshold cannot be right everywhere and no arrangement of one threshold can be:
 * this is the physics of a single infrared channel, not a tuning problem.
 *
 * What one threshold can do is stop the sheet painting where the surface is warm, which is
 * most of the globe most of the time and all of the tropics. Six of the nine tiles peak below
 * 128. So everything below 128 is dropped outright, 128 to 176 ramps, and above 176 paints in
 * full. The two failure modes that leaves, both stated rather than hidden: thin cloud over a
 * warm sea is faint, and a cold surface reads as cloud, so the ice caps paint white. The
 * second is the product being honest about what it can see, and the ±81 latitude clip on each
 * disk is what keeps it off most of the screen.
 */
export const CLEAR_SKY_CEILING = 128;
export const CLOUD_FLOOR = 176;

/**
 * How far off nadir this product can still be read as cloud, in degrees.
 *
 * **Measured 2026-08-24 on GOES-East, and it overturns an earlier refusal of mine.** The lead
 * asked for a limb taper on 2026-08-23 and I declined it, having measured that the imagery is
 * fully resolved right out to the disk edge: run lengths of 1.1 to 2.1 pixels and 82 to 251
 * distinct values per tile at 81 degrees off nadir. That measurement was correct and it was
 * the wrong measurement. **Detail is not accuracy.** The limb has plenty of detail and a
 * systematic cold bias, because a sensor looking along the limb looks through several times
 * the air mass, and more atmosphere means a colder brightness temperature whatever is under it.
 *
 * The percentage of pixels this palette paints fully opaque, against angle from the
 * sub-satellite point, sampled down one radial from nadir to past the limb:
 *
 * | off nadir | mean grey | painted opaque |
 * | --- | --- | --- |
 * | 0 to 65 | 99 to 154 | 0 to 25% |
 * | **70** | **173** | **43%** |
 * | **75** | **172** | **43%** |
 * | **80** | 159 | **55%** |
 * | 85 | 0 | 0%, and the source is transparent |
 *
 * So beyond 65 degrees the mean grey sits within a few counts of :data:`CLOUD_FLOOR` and half
 * the pixels cross it. That is not cloud. It is path length being read as cloud by a threshold
 * calibrated at nadir, and on screen it is a band of near-solid white following the circular
 * limb: from Europe it reads as a razor-straight diagonal from the Bay of Biscay past Iceland,
 * which is what the lead saw and correctly called a broken render rather than weather.
 *
 * 70 is the first bin where the figure breaks out of the 0-to-25% range the rest of the disk
 * holds. The cost is stated rather than hidden: London sits at 80.8 degrees off GOES-East and
 * therefore loses its cloud entirely. That is a real loss of coverage and it is the honest
 * trade, because what London was being shown was a fabricated overcast.
 */
export const CLOUD_TRUST_LIMIT = 70;

/**
 * Degrees over which the sheet fades out before the limit.
 *
 * **Wide, and the width is the point: the weight tracks how much the reading can be trusted,
 * and trust falls continuously with angle rather than at a line.** A narrow band was tried
 * first, 8 degrees, and it swapped one razor edge for another a little further in. Over the
 * Greenland ice cap and the Southern Ocean, where this palette paints hardest because the
 * surface genuinely is cold, an 8-degree fade from fully opaque to nothing still read as a
 * geometric boundary in a screenshot.
 *
 * At 25 the sheet is at full weight only inside 45 degrees, where the nine-climate measurement
 * behind {@link CLEAR_SKY_CEILING} was taken, and it thins to nothing by 70 where the slant
 * path has taken the reading over. That is a continuous statement of confidence rather than a
 * cliff, it removes the edge without implying coverage we do not have, and the fade costs
 * nothing where it matters most: real cloud over a dark ocean still contrasts at 20% alpha,
 * while a cold surface at the same weight stops blowing the basemap out.
 */
export const CLOUD_TRUST_FADE = 25;

/**
 * Great-circle angle from a satellite's sub-satellite point to a place, in degrees.
 *
 * The sub-satellite point is on the equator, so the general spherical-distance formula
 * collapses to this. Both arguments in contract order, degrees.
 */
export function offNadirDegrees(subLon: number, lon: number, lat: number): number {
  const toRad = Math.PI / 180;
  const cosine = Math.cos(lat * toRad) * Math.cos((lon - subLon) * toRad);
  return (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
}

/**
 * How much of the sheet to draw at this angle off nadir: 1 inside, 0 beyond, linear between.
 *
 * A weight rather than a boolean so the boundary is a fade. Multiplied into whatever alpha
 * {@link renderAsCloud} produced, so clear sky stays clear and thick cloud thins out towards
 * the limb rather than the whole band switching off at once.
 */
export function limbWeight(offNadir: number): number {
  if (offNadir >= CLOUD_TRUST_LIMIT) {
    return 0;
  }
  const fadeFrom = CLOUD_TRUST_LIMIT - CLOUD_TRUST_FADE;
  if (offNadir <= fadeFrom) {
    return 1;
  }
  return (CLOUD_TRUST_LIMIT - offNadir) / CLOUD_TRUST_FADE;
}

/**
 * How far a pixel's channels must spread before it counts as coloured rather than grey.
 *
 * The one measurement that makes the threshold above safe. NASA colourises the cold end of
 * this ramp, so the tallest storms arrive cyan, blue, green, yellow and red, and their
 * *brightness* is often below clear sky: `(0, 67, 90)` is a cold top and its brightest
 * channel is 90, well under the 128 above. Keyed on brightness alone the ramp would punch a
 * hole through the middle of every deep convective cluster, which is the one part of a cloud
 * field anybody is looking at.
 *
 * So brightness only decides a pixel that has no colour in it. Measured on the same nine
 * tiles: 62 to 99 per cent of pixels are exactly grey, and a spread of 12 separates NASA's
 * colourised tops from the grey body of the cloud with nothing in between.
 */
export const COLOURED_CHROMA = 12;

/**
 * Repaint one tile in place: sky transparent, cloud white, and how much of it in the alpha.
 *
 * **Cloud is white here, not NASA's colours, and that is a deliberate reversal.** GIBS
 * colourises the cold end of this ramp, so passed through untouched the layer draws bright
 * green, red, orange and blue patches over one half of the Earth against ordinary imagery on
 * the other. Two people read the same screenshot independently as a broken render rather than
 * as weather, and they were right to: the audience for this globe does not read infrared, and a
 * false-colour sheet with a hard edge down the middle of it says "fault" before any caption
 * gets a chance to say otherwise. `globe/viewer.ts` already states the rule this breaks, that
 * saturated colour on this globe belongs to entities and alerts. So the ramp stops here.
 *
 * The measurement is what makes it safe. 62 to 99 per cent of pixels in a tile are exactly
 * grey and a channel spread of :data:`COLOURED_CHROMA` separates the colourised tops from the
 * grey body of the cloud with nothing in between, so a coloured pixel can be identified with
 * confidence rather than guessed at. It is then written to the **top** of the white ramp and
 * keeps the full opacity it arrived with, because a colourised pixel is a cold top and a cold
 * top is the tallest, densest cloud in the picture. Mapping it to white rather than dropping it
 * is the whole point: dropping it would punch a hole through the middle of every storm, and
 * flattening it by desaturation would turn it dark, because this ramp is not monotone in
 * brightness and a cold top's luminance sits *below* clear sky.
 *
 * **What that costs, stated rather than buried.** A deep convective tower and a merely thick
 * stratus deck both end up white at full opacity, so the picture no longer distinguishes the
 * coldest cloud from the thickest. That distinction is not representable in a one-colour
 * palette where both sit at the top of it. It reads as cloud, which is what it is, and if the
 * distinction is ever wanted back the honest way to do it is a slight cool tint on the
 * colourised pixels rather than restoring the rainbow.
 *
 * Sky and the off-disk corners fall out together, for free. A tile straddling a disk's limb
 * carries the space beyond it as opaque `(0, 0, 0)`, which is grey with a brightness of zero,
 * so it goes under the ceiling with the sky. That is why the layer needs no `colorToAlpha`:
 * one pass does both, as a ramp rather than a hard colour key.
 */
export function renderAsCloud(pixels: Uint8ClampedArray): void {
  const ramp = CLOUD_FLOOR - CLEAR_SKY_CEILING;
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    const brightest = Math.max(red, green, blue);
    const coloured = brightest - Math.min(red, green, blue) >= COLOURED_CHROMA;
    if (!coloured && brightest <= CLEAR_SKY_CEILING) {
      // Sky, or the black off-disk corner. Nothing to paint, so the colour is left alone
      // rather than written to white: an invisible pixel's channels cost nothing to skip.
      pixels[index + 3] = 0;
      continue;
    }
    // Everything that survives is cloud, and cloud is white. A colourised cold top keeps the
    // opacity it arrived with, which is full: it is the densest cloud in the picture.
    pixels[index] = 255;
    pixels[index + 1] = 255;
    pixels[index + 2] = 255;
    if (!coloured && brightest < CLOUD_FLOOR) {
      pixels[index + 3] = Math.round((255 * (brightest - CLEAR_SKY_CEILING)) / ramp);
    }
  }
}

/** A tile's geographic extent in degrees, contract order, from its Web Mercator address. */
export interface TileBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/**
 * Where a Web Mercator tile sits on the globe.
 *
 * Longitude is linear in this projection and latitude is not, which is the trap: interpolating
 * latitude straight across a tile is wrong by kilometres at high latitude, and high latitude is
 * exactly where the limb cut has to be right. So the northing is computed in projected space
 * and converted once per edge here, and once per pixel row in {@link fadeToLimb}.
 */
export function tileBounds(x: number, y: number, level: number): TileBounds {
  const count = 2 ** level;
  const latitudeAt = (row: number): number => {
    const northing = Math.PI - (2 * Math.PI * row) / count;
    return (180 / Math.PI) * Math.atan(Math.sinh(northing));
  };
  return {
    west: (x / count) * 360 - 180,
    east: ((x + 1) / count) * 360 - 180,
    north: latitudeAt(y),
    south: latitudeAt(y + 1),
  };
}

/**
 * The smallest off-nadir angle anywhere in this tile.
 *
 * Angle grows with both `|lat|` and `|lon - subLon|`, so the nearest point in the tile is
 * simply the sub-satellite longitude clamped into its longitude span and the equator clamped
 * into its latitude span. No search and no sampling: the extremum is at the clamp.
 */
export function tileNearestOffNadir(subLon: number, bounds: TileBounds): number {
  const lon = Math.min(bounds.east, Math.max(bounds.west, subLon));
  const lat = Math.min(bounds.north, Math.max(bounds.south, 0));
  return offNadirDegrees(subLon, lon, lat);
}

/**
 * Multiply {@link limbWeight} into the alpha of every pixel, in place.
 *
 * Runs after {@link renderAsCloud}, so it thins what that decided rather than deciding
 * anything itself. Clear sky is already at alpha zero and stays there.
 *
 * The cosine is compared before any `acos` is taken, which keeps the inverse trig to the eight
 * degrees of the fade band rather than all 65,536 pixels of a tile: outside the band the
 * answer is 0 or 1 and the angle itself is never needed.
 */
export function fadeToLimb(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  subLon: number,
  bounds: TileBounds,
): void {
  const toRad = Math.PI / 180;
  const cosLimit = Math.cos(CLOUD_TRUST_LIMIT * toRad);
  const cosFade = Math.cos((CLOUD_TRUST_LIMIT - CLOUD_TRUST_FADE) * toRad);
  const cosLongitude = new Float64Array(width);
  for (let column = 0; column < width; column += 1) {
    const lon = bounds.west + ((bounds.east - bounds.west) * (column + 0.5)) / width;
    cosLongitude[column] = Math.cos((lon - subLon) * toRad);
  }
  // Northing rather than latitude, for the reason in `tileBounds`.
  const northOf = Math.atanh(Math.sin(bounds.north * toRad));
  const southOf = Math.atanh(Math.sin(bounds.south * toRad));
  for (let row = 0; row < height; row += 1) {
    const northing = northOf + ((southOf - northOf) * (row + 0.5)) / height;
    const cosLatitude = Math.cos(Math.atan(Math.sinh(northing)));
    for (let column = 0; column < width; column += 1) {
      const alpha = (row * width + column) * 4 + 3;
      const weight = weightFromCosine(cosLatitude * (cosLongitude[column] ?? 0), cosLimit, cosFade);
      if (weight < 1) {
        pixels[alpha] = Math.round((pixels[alpha] ?? 0) * weight);
      }
    }
  }
}

/**
 * {@link limbWeight} without taking an `acos` unless the answer needs one.
 *
 * The cosine of the angle is what the loop already has, and cosine is monotonic over nought to
 * 180 degrees, so both flat parts of the ramp can be decided by comparison. Only the eight
 * degrees of the fade band need the angle itself, which is a few hundred pixels of a 65,536
 * pixel tile rather than all of them. A sweep test asserts this agrees with `limbWeight`.
 */
function weightFromCosine(cosine: number, cosLimit: number, cosFade: number): number {
  if (cosine <= cosLimit) {
    return 0;
  }
  if (cosine >= cosFade) {
    return 1;
  }
  return limbWeight((Math.acos(cosine) * 180) / Math.PI);
}

/**
 * One tile, repainted onto a canvas with {@link renderAsCloud} applied.
 *
 * Cesium accepts a canvas from `requestImage` wherever it accepts an image, so this is the
 * whole mechanism: there is no per-pixel alpha control on an `ImageryLayer`, only one
 * `colorToAlpha` colour and one threshold, and a single colour cannot separate warm sky from
 * cold sky from off-disk black without also eating the coloured tops. Reading the pixels back
 * needs the tile to have been fetched with CORS, which GIBS allows: it sends
 * `access-control-allow-origin: *` on every tile, verified on both a 200 and a 404.
 *
 * The canvas plumbing is not unit tested, because the runner has no document. {@link renderAsCloud}
 * carries the decisions and is tested directly; that the pixels reach the globe at all is
 * asserted by driving the built bundle in a browser.
 */
function paintCloudTile(image: ImageryTypes, subLon: number, bounds: TileBounds): ImageryTypes {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    return image;
  }
  context.drawImage(image, 0, 0);
  const painted = context.getImageData(0, 0, canvas.width, canvas.height);
  renderAsCloud(painted.data);
  fadeToLimb(painted.data, canvas.width, canvas.height, subLon, bounds);
  context.putImageData(painted, 0, 0);
  return canvas;
}

/** A tile-sized transparent canvas, for an address wholly outside what the satellite sees. */
function blankTile(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/**
 * How the sheet is blended over the basemap, and what is deliberately not done any more.
 *
 * There used to be three settings here: a `colorToAlpha` on black, a contrast and an alpha of
 * 0.62. Together they washed the globe out, and the reason is worth keeping written down,
 * because it is the trap anyone reaching for a translucent overlay walks into. **A fixed alpha
 * over a field that is opaque everywhere is a veil everywhere.** Clear sky on this product is
 * mid grey rather than black, so 0.62 of it went down over the whole disk, and the loudest
 * thing on screen became the background. Land stopped reading as land and every mover's
 * contrast argument, which was measured against a dark globe, quietly stopped holding.
 *
 * The alpha now comes from the pixel rather than from a constant, in {@link renderAsCloud}, so
 * sky does not paint at all and cloud paints in full. That leaves nothing for `contrast` to do
 * and nothing for `colorToAlpha` to remove, and both are gone: the ramp handles the off-disk
 * black as well, and it handles it as a ramp instead of a hard colour key.
 *
 * `alpha` sits just under 1 so that dense cloud is nearly solid while a coastline underneath
 * it stays findable. It is the only setting left.
 *
 * There was a `saturation` of 0.7 here too, to take the edge off NASA's rainbow. It is gone
 * because {@link renderAsCloud} now writes every visible pixel to white, so there is no chroma
 * left for it to act on and it could not change a single pixel. A setting that cannot affect
 * anything is a lie about the code, and the rule it was half-enforcing, that saturated colour
 * on this globe belongs to entities and alerts, is now absolute rather than tempered.
 */
const SHEET_ALPHA = 0.9;

/** One satellite's sheet, ready to add to the globe. */
export function cloudSheet(
  satellite: CloudSatellite,
  slot: string,
  visible: boolean,
): ImageryLayer {
  return new ImageryLayer(cloudImagery(satellite, slot), {
    show: visible,
    alpha: SHEET_ALPHA,
  });
}

export interface CloudLayerOptions {
  /** Overridden in tests, which have no network and no clock worth waiting for. */
  probe?: TileProbe;
  now?: () => Date;
}

/**
 * The cloud sheets on the globe, and what to say when there are none.
 *
 * Owns three things: which slot each satellite is showing, whether the sheets are on screen,
 * and why they are not there when they are not. It never asserts a slot it has not had a
 * tile back for, which is the difference between a cloud layer and a transparent one.
 */
export class CloudLayer {
  private readonly sheets: ImageryLayerCollection;
  private readonly probe: TileProbe;
  private readonly now: () => Date;
  /** The layers currently on the globe, keyed by satellite name. */
  private readonly added = new Map<string, ImageryLayer>();
  /** The slot each of those layers is showing, so a refresh knows when nothing changed. */
  private readonly slots = new Map<string, string>();
  private visible = true;
  /** What the last refresh failed with, when it failed for a reason worth repeating. */
  private failure: string | null = null;

  constructor(sheets: ImageryLayerCollection, options: CloudLayerOptions = {}) {
    this.sheets = sheets;
    this.probe = options.probe ?? headTile;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Find the newest slot each satellite has, and put those sheets on the globe.
   *
   * Returns whether the picture changed, so the caller can ask for a frame and only when
   * there is something new to draw: with `requestRenderMode` on, a scene that is not asked
   * does not draw, and asking on every tick would defeat it.
   */
  async refresh(): Promise<boolean> {
    const when = this.now();
    const failures: string[] = [];
    const found = await Promise.all(
      CLOUD_SATELLITES.map(async (satellite) => {
        try {
          return await newestCloudSlot(satellite, when, this.probe);
        } catch (error: unknown) {
          failures.push(describeError(error));
          return null;
        }
      }),
    );

    // One reason for the whole layer, and only when nothing at all came back: a single
    // satellite failing is a coverage notice on the row rather than a dead layer.
    this.failure = failures[0] ?? null;

    let changed = false;
    for (const [index, satellite] of CLOUD_SATELLITES.entries()) {
      const slot = found[index] ?? null;
      if (slot === null || slot === this.slots.get(satellite.name)) {
        continue;
      }
      // Added before the old one goes, so there is no frame with a hole where the clouds
      // were. Cesium keeps drawing the old sheet's tiles until it is removed.
      const sheet = cloudSheet(satellite, slot, this.visible);
      this.sheets.add(sheet);
      const previous = this.added.get(satellite.name);
      if (previous !== undefined) {
        this.sheets.remove(previous, true);
      }
      this.added.set(satellite.name, sheet);
      this.slots.set(satellite.name, slot);
      changed = true;
    }
    return changed;
  }

  /** The rail's switch. Cheap: the sheets stay built and stop being drawn. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const sheet of this.added.values()) {
      sheet.show = visible;
    }
  }

  /**
   * What the rail should say about this layer, in the shape `/api/capabilities` uses.
   *
   * The browser is the only thing that knows: these tiles come from NASA to the browser
   * without our backend seeing any of it, so a capability from the server would be a guess.
   */
  get capability(): LayerCapability {
    if (this.added.size > 0) {
      return { layer: CLOUD_LAYER, available: true, reason: null };
    }
    return { layer: CLOUD_LAYER, available: false, reason: cloudUnavailableReason(this.failure) };
  }

  /**
   * The one thing worth saying about a layer that is working, or null.
   *
   * A satellite whose imagery is missing outranks the coverage gap: the first is a fault and
   * the second is what this source is. The gap is only mentioned when the camera is actually
   * looking at it, because a permanent amber line under a healthy row is the wall of text
   * the rail's notice budget exists to prevent.
   */
  notice(view: ViewRect): string | null {
    const missing = CLOUD_SATELLITES.filter((satellite) => !this.slots.has(satellite.name)).map(
      (satellite) => satellite.name,
    );
    if (missing.length > 0) {
      return `${missing.join(' and ')} cloud imagery missing from NASA GIBS`;
    }
    return cloudGapInView(view) ? CLOUD_GAP_NOTICE : null;
  }

  /** The slot each satellite is showing, for the tests and for nothing else. */
  get showing(): ReadonlyMap<string, string> {
    return this.slots;
  }
}
