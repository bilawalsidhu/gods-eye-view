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
 * A frame GIBS has not built yet answers 404, and the newest frame always is one. That is what
 * {@link cloudDefaultUrl} is for: nothing here ever pins a slot it has not had a tile back for.
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
 * So this is where the fallback walk starts, not where it stops. A request for a slot GIBS
 * has not built yet is a 404, and a naive "now" would 404 every tile on the globe and read as
 * a layer that is broken rather than one that is waiting. The normal path does not guess at
 * all: see {@link cloudDefaultUrl}, which has GIBS name the frame itself.
 */
export const CLOUD_LATENCY_MINUTES = 20;

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
  { name: 'GOES-West', layer: 'GOES-West_ABI_Band13_Clean_Infrared', west: -180, east: -106 },
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
  { name: 'GOES-East', layer: 'GOES-East_ABI_Band13_Clean_Infrared', west: -106, east: 0 },
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
  { name: 'Himawari', layer: 'Himawari_AHI_Band13_Clean_Infrared', west: 60, east: 180 },
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

/**
 * The same tile, asked for without naming a slot.
 *
 * GIBS accepts `default` in the time dimension and serves whatever the newest built frame is,
 * naming it in a `layer-time-actual` response header. Verified on 2026-08-23 at 10:25 UTC: it
 * answered 200 for all three layers and reported 10:00 for the two GOES satellites and 09:30
 * for Himawari, which is 25 and 55 minutes old respectively. So this one request replaces the
 * whole walk below, and it is worth having because Himawari that far behind would otherwise
 * have cost four 404s to find, and a 404 in a browser is a console error whether or not the
 * code that made it was expecting one.
 *
 * **This is used to learn the slot and never to draw, and that is not a precaution, it is
 * measured.** `default` is resolved per request, not per layer: on 2026-08-23 at 15:40 UTC,
 * four GOES-East tiles asked for in the same second came back naming three different frames,
 * `1/0/0` at 15:40, `1/1/1` at 15:30 and `1/0/1` at 15:20. Drawing on `default` would put
 * tiles from three frames next to each other on the globe and call it one picture. So one
 * request learns the frame, and every tile after it names that frame explicitly.
 */
export function cloudDefaultUrl(satellite: CloudSatellite): string {
  return `${GIBS_WMTS}/${satellite.layer}/default/default/${TILE_MATRIX_SET}/0/0/0.png`;
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
 * One request on the normal path: GIBS is asked for `default` and names the frame it served.
 * The walk is the fallback for the case where the answer arrived without the header, which is
 * what a proxy stripping it looks like, and for a transient failure. Transient is the right
 * word: measured on 2026-08-23, the same tile URL answered 404, 404, then 200 with bytes.
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
  const reported = await probe(cloudDefaultUrl(satellite));
  if (reported.slot !== null) {
    return reported.slot;
  }
  for (const slot of cloudSlots(now)) {
    const answer = await probe(cloudProbeUrl(satellite, slot));
    if (answer.ok) {
      return slot;
    }
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
    const pending = request(x, y, level, options);
    // A promise chain rather than an await, and it has to be. An `undefined` return is
    // Cesium's own signal that the request was throttled and the tile should be asked for
    // again later; an async function cannot return one, because it would wrap it in a
    // resolved promise and Cesium would take a deferred tile for a delivered blank one.
    // eslint-disable-next-line unicorn/prefer-await -- reason above
    return pending?.then(paintCloudTile);
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
function paintCloudTile(image: ImageryTypes): ImageryTypes {
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
  context.putImageData(painted, 0, 0);
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
