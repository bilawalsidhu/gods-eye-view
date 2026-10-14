import { COLORS as SHARED_COLORS, PROVIDER_COLORS } from '../../policy.js';
import { metresBetween } from '../../view.js';

export { NEAREST_RADIUS_M } from '../../policy.js';

/**
 * Identity and tuning for Vegbilder, Statens vegvesen's road photos of
 * Norway's national and county roads (keyless, NLOD).
 */
export const VEGBILDER_PROVIDER_ID = 'vegbilder';
export const VEGBILDER_NAME = 'Vegbilder';
export const VEGBILDER_LABEL = 'VEGBILDER';

/** The public WFS: one point per photo, one feature type per year and kind. */
export const VEGBILDER_WFS =
  'https://ogckart-sn1.atlas.vegvesen.no/vegbilder_1_0/ows';
/**
 * Photos are served from these, by signed addresses the WFS hands out: the
 * older years' store, and the object store newer drives (and some 360°
 * photos) live in.
 */
export const VEGBILDER_IMAGE_HOSTS = Object.freeze([
  'https://s3vegbilder.atlas.vegvesen.no',
  'https://s3-oslo.osys.vegvesen.no',
]);
/** Statens vegvesen's own Vegbilder map, for the image link. */
export const VEGBILDER_SITE = 'https://vegbilder.atlas.vegvesen.no';

const NAMESPACE = 'vegbilder_1_0';
/** Flat photos from 2014 (none from 2015); 360° photos from 2021. */
export const FIRST_FLAT_YEAR = 2014;
export const MISSING_FLAT_YEARS = Object.freeze([2015]);
export const FIRST_PANO_YEAR = 2021;

/** Stable id prefixes for picked primitives; every one starts with `vb:`. */
export const PICK_PREFIX = Object.freeze({
  root: 'vb:',
  line: 'vb:line:',
  image: 'vb:img:',
});

export const COLORS = Object.freeze({
  coverage: PROVIDER_COLORS.vegbilder,
  selected: SHARED_COLORS.selected,
});

/**
 * Coverage lines are drawn from the photo points themselves (a photo every
 * 5–10 m), so only near the street: z15 tiles below 1,500 m, the latest
 * few years. A dense Oslo tile holds ~500 photos a year and kind.
 */
export const COVERAGE_MAX_HEIGHT_M = 1_500;
export const COVERAGE_ZOOM = 15;
export const COVERAGE_YEARS = 3;
export const COVERAGE_TUNING = Object.freeze({
  maxTiles: 9,
  overviewMaxTiles: 0,
  maxSequences: 9_000,
  lineWidthPx: 2.5,
  overviewPointPx: 2.5,
  moveDebounceMs: 320,
  viewRangeMinM: 1_000,
  viewRangePerHeight: 6,
  viewNearM: 600,
});
/** A gap longer than this, in metres or minutes, starts a new line. */
export const LINE_BREAK_M = 40;
export const LINE_BREAK_MS = 10 * 60_000;

export const TOO_HIGH_HINT = 'zoom in to see Vegbilder coverage';
export const NO_COVERAGE_HINT = 'no Vegbilder photos in view';
export const RATE_LIMITED_MESSAGE =
  'Statens vegvesen is limiting requests — they resume on their own';
export const COVERAGE_NOUN = 'road stretches';
export const LINE_CLICK_HINT = 'click a road for its nearest photo';
export const MISSING_FILE_MESSAGE =
  'Statens vegvesen has no file for this photo';

/** WFS requests at once (each is ~0.5 s); a tile's features are capped. */
export const WFS_CONCURRENCY = 4;
export const WFS_TIMEOUT_MS = 20_000;
export const WFS_MAX_FEATURES = 5_000;
/** Real answers are a few MB at most; refuse anything absurd. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** A photo download (~0.8 MB flat, ~3 MB 360°). */
export const IMAGE_TIMEOUT_MS = 20_000;
/** The signed photo address lasts ten hours; ask again well before. */
export const IMAGE_RECORD_TTL_MS = 60 * 60_000;
/** 8,192 px panoramas are drawn at most this wide (phones cap textures at 4,096). */
export const PANO_TEXTURE_WIDTH = 4_096;

/** The drive around an open photo: this far either way along the road. */
export const DRIVE_WINDOW_M = 300;

/** Photos tried, nearest first, before a lookup gives up on missing files. */
export const NEAREST_PROBES = 4;

/** On-globe credit: NLOD 2.0 asks for the source to be named. */
export const VEGBILDER_CREDIT_HTML =
  'Street Level: road photos © <a href="https://vegbilder.atlas.vegvesen.no" target="_blank" rel="noopener">Statens vegvesen</a>, NLOD 2.0';

const DAY_MS = 86_400_000;

/** The feature type for a year and kind. */
export function layerName(year, isPano) {
  return `${NAMESPACE}:Vegbilder_${isPano ? '360_' : ''}${year}`;
}

/** The feature type a photo id belongs to (the id is `<type>.<rest>`), or null. */
export function layerOfId(id) {
  const match = /^(Vegbilder_(?:360_)?\d{4})\.[\w.:+-]+$/.exec(
    String(id ?? ''),
  );
  return match ? `${NAMESPACE}:${match[1]}` : null;
}

/** Years Vegvesen publishes for a kind, newest first, up to `now`'s year. */
export function yearsFor(isPano, now = Date.now()) {
  const last = new Date(now).getUTCFullYear();
  const first = isPano ? FIRST_PANO_YEAR : FIRST_FLAT_YEAR;
  const years = [];
  for (let year = last; year >= first; year--)
    if (isPano || !MISSING_FLAT_YEARS.includes(year)) years.push(year);
  return years;
}

/** The kinds the filter lets through: false flat, true 360°. */
export function kindsFor(filter) {
  if (filter?.pano === 'pano') return [true];
  if (filter?.pano === 'flat') return [false];
  return [false, true];
}

/** The first year a SINCE filter can still match, or null with no SINCE. */
function sinceYear(filter) {
  return Number.isFinite(filter?.sinceMs) && filter.sinceMs > 0
    ? new Date(filter.sinceMs).getUTCFullYear()
    : null;
}

/**
 * The feature types coverage lines come from under the filter: the latest
 * COVERAGE_YEARS of each kind it lets through, none before SINCE.
 * @param {{pano: string, sinceMs: number|null}|null} filter  resolved
 */
export function coverageLayers(filter, now = Date.now()) {
  const floor = sinceYear(filter);
  const layers = [];
  for (const isPano of kindsFor(filter))
    for (const year of yearsFor(isPano, now).slice(0, COVERAGE_YEARS))
      if (floor === null || year >= floor) layers.push(layerName(year, isPano));
  return layers;
}

/**
 * The feature types a nearest-photo search walks, newest year first; within
 * a year flat before 360° (flat photos are the main series, and some cities'
 * 360° files are not published).
 */
export function searchLayers(filter, now = Date.now()) {
  const floor = sinceYear(filter);
  const kinds = kindsFor(filter);
  const layers = [];
  for (const year of yearsFor(false, now)) {
    if (floor !== null && year < floor) break;
    for (const isPano of kinds)
      if (!isPano || year >= FIRST_PANO_YEAR)
        layers.push(layerName(year, isPano));
  }
  return layers;
}

/** Epoch ms of an ISO time, or null. */
function timeMs(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

/** An https address on Vegvesen's photo host, or null. */
function imageUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' &&
      VEGBILDER_IMAGE_HOSTS.includes(url.origin)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A short road name: "E18", "Rv. 162", "Fv. 61", "Kv. 1234". */
export function roadName({ category, number }) {
  if (!category || !Number.isFinite(number)) return null;
  if (category === 'E') return `E${number}`;
  const prefix = { R: 'Rv.', F: 'Fv.', K: 'Kv.', P: 'Pv.', S: 'Sv.' }[category];
  return prefix ? `${prefix} ${number}` : `${category}v. ${number}`;
}

/**
 * A WFS feature as a photo, or null without an id or a position. The road
 * reference (category, number, section, sub-section, junction/side parts,
 * lane) and the drive's day say which drive it belongs to.
 */
export function normalizeImage(feature) {
  const id = feature?.id;
  const layer = layerOfId(id);
  if (!layer) return null;
  const [lon, lat] = feature?.geometry?.coordinates ?? [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const p = feature.properties ?? {};
  const isPano = p.BILDETYPE === '360' || layer.includes('_360_');
  const heading = Number(p.RETNING);
  const meter = Number(p.METER);
  const capturedAt = timeMs(p.TIDSPUNKT);
  const road = {
    category: p.VEGKATEGORI ? String(p.VEGKATEGORI) : null,
    status: p.VEGSTATUS ? String(p.VEGSTATUS) : null,
    number: Number.isFinite(Number(p.VEGNUMMER)) ? Number(p.VEGNUMMER) : null,
    section: p.STREKNING ?? null,
    subsection: p.DELSTREKNING ?? null,
    anchor: p.ANKERPUNKT ?? null,
    junction: p.KRYSSDEL ?? null,
    side: p.SIDEANLEGGSDEL ?? null,
    lane: p.FELTKODE != null ? String(p.FELTKODE) : null,
  };
  return {
    id: String(id),
    layer,
    lon,
    lat,
    isPano,
    heading: Number.isFinite(heading) ? heading : null,
    meter: Number.isFinite(meter) ? meter : null,
    capturedAt,
    road,
    driveId: driveIdOf(layer, road, capturedAt),
    urls: {
      full: imageUrl(p.URL),
      // A 360° photo's front view, already flat (2,520 × 1,400).
      preview: imageUrl(p.URLPREVIEW),
    },
  };
}

/**
 * A drive: one kind and year, one road stretch and lane, one day. Within it
 * passes are told apart by time (see splitPasses).
 */
export function driveIdOf(layer, road, capturedAt) {
  if (!layer || !Number.isFinite(capturedAt)) return null;
  const day = new Date(Math.floor(capturedAt / DAY_MS) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const r = road;
  return [
    layer.replace(`${NAMESPACE}:`, ''),
    `${r.category ?? ''}${r.status ?? ''}${r.number ?? ''}`,
    `S${r.section ?? ''}D${r.subsection ?? ''}`,
    `A${r.anchor ?? ''}K${r.junction ?? ''}SA${r.side ?? ''}`,
    `F${r.lane ?? ''}`,
    day,
  ].join('|');
}

/**
 * The drive's photos in the order they were taken: by metre along the
 * road, turned round when the later photos sit lower (lanes against the
 * road's direction).
 */
export function orderDrive(images) {
  const list = [...images].sort((a, b) => (a.meter ?? 0) - (b.meter ?? 0));
  if (list.length < 2) return list;
  const first = list[0];
  const last = list.at(-1);
  if ((first.capturedAt ?? 0) > (last.capturedAt ?? 0)) list.reverse();
  return list;
}

/**
 * Split time-ordered photos where the gap is longer than LINE_BREAK_M or
 * LINE_BREAK_MS: another pass, or a stretch with no photos.
 */
export function splitPasses(images) {
  const runs = [];
  let run = [];
  for (const image of images) {
    const previous = run.at(-1);
    if (
      previous &&
      (metresBetween(previous, image) > LINE_BREAK_M ||
        Math.abs((image.capturedAt ?? 0) - (previous.capturedAt ?? 0)) >
          LINE_BREAK_MS)
    ) {
      runs.push(run);
      run = [];
    }
    run.push(image);
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * A tile's photos as coverage lines: one per pass of a drive, newest first.
 * A line's id is its drive and first photo, so the same pass in two tiles
 * keeps one identity per tile edge.
 * @param {Array<object>} images  normalized photos
 */
export function linesFromImages(images) {
  const drives = new Map();
  for (const image of images) {
    if (!image?.driveId) continue;
    const list = drives.get(image.driveId);
    if (list) list.push(image);
    else drives.set(image.driveId, [image]);
  }
  const sequences = [];
  for (const [driveId, list] of drives)
    for (const run of splitPasses(orderDrive(list))) {
      if (run.length < 2) continue;
      sequences.push({
        id: `${driveId}|${run[0].id}`,
        parts: [run.map(({ lon, lat }) => [lon, lat])],
        capturedAt: run[0].capturedAt ?? 0,
        isPano: run[0].isPano,
      });
    }
  return { sequences, overview: [] };
}

/** Quote a CQL string literal. */
function cqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** `FIELD = value`, or `FIELD IS NULL` for a missing part of the road reference. */
function cqlEquals(field, value, { text = false } = {}) {
  if (value === null || value === undefined) return `${field} IS NULL`;
  if (text) return `${field} = ${cqlString(value)}`;
  const number = Number(value);
  if (!Number.isFinite(number)) return `${field} IS NULL`;
  return `${field} = ${number}`;
}

/**
 * The CQL filter for a photo's drive within DRIVE_WINDOW_M of it: the same
 * road reference and lane, the same day.
 */
export function driveFilter(image, windowM = DRIVE_WINDOW_M) {
  const r = image.road;
  const day = Math.floor((image.capturedAt ?? 0) / DAY_MS) * DAY_MS;
  const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
  const parts = [
    cqlEquals('VEGKATEGORI', r.category, { text: true }),
    cqlEquals('VEGSTATUS', r.status, { text: true }),
    cqlEquals('VEGNUMMER', r.number),
    cqlEquals('STREKNING', r.section),
    cqlEquals('DELSTREKNING', r.subsection),
    cqlEquals('ANKERPUNKT', r.anchor),
    cqlEquals('KRYSSDEL', r.junction),
    cqlEquals('SIDEANLEGGSDEL', r.side),
    cqlEquals('FELTKODE', r.lane, { text: true }),
    `TIDSPUNKT DURING ${iso(day)}/${iso(day + DAY_MS)}`,
  ];
  if (Number.isFinite(image.meter))
    parts.push(
      `METER BETWEEN ${Math.max(0, image.meter - windowM)} AND ${image.meter + windowM}`,
    );
  return parts.join(' AND ');
}

/**
 * The pass of the drive `image` belongs to, in the order it was taken:
 * drive photos are split into passes and the one holding the image kept.
 */
export function passOf(image, driveImages) {
  const known = driveImages.some((other) => other.id === image.id)
    ? driveImages
    : [...driveImages, image];
  for (const run of splitPasses(orderDrive(known)))
    if (run.some((other) => other.id === image.id)) return run;
  return [image];
}

/** The address a viewer shows first: a 360° photo's front view, else the photo. */
export function firstShownUrl(image) {
  return image?.isPano
    ? image.urls.preview || image.urls.full
    : (image?.urls.full ?? null);
}

/** Where the image link goes: the photo itself (Vegvesen's map takes no photo id). */
export function vegbilderPhotoUrl(image) {
  return image?.urls?.full || VEGBILDER_SITE;
}

/** Captured on this day or after: SINCE goes by capture time, the year layers by year. */
export function passesVegbilderFilter(image, filter) {
  if (!filter) return true;
  if (filter.pano === 'pano' && !image.isPano) return false;
  if (filter.pano === 'flat' && image.isPano) return false;
  if (Number.isFinite(filter.sinceMs) && filter.sinceMs > 0)
    return (image.capturedAt ?? 0) >= filter.sinceMs;
  return true;
}
