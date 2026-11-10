export const RADIO_PREFIX = 'radio:';

export const DIRECTORY_ENDPOINT = '/api/radio/stations';

export const HORIZON_TICK_MS = 250;

export const HORIZON_CAMERA_MOVE_EPSILON_M = 1;

export const MARKER_LIFT_M = 2.5;

export const SELECTED_LIFT_M = 5;

const RADIO_PICK_TOLERANCE_PX = 8;

export const RADIO_TUNER_DIRECTORY_LIMIT = 750;

export const RADIO_TUNER_STATION_LIMIT = RADIO_TUNER_DIRECTORY_LIMIT;

export const RADIO_TUNER_STATIC_MAX_GAIN = 0.018;

export const RADIO_VOICE_PLAYBACK_TIMEOUT_MS = 12_000;

export const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export const RADIO_DIRECTORY_FUTURE_SKEW_MS = 5 * 60 * 1000;

// Bound for the server's `rejectedStationCount` envelope field and the
// combined client counter; matches server/providers/radio/constants.js.
export const RADIO_REJECTED_STATION_COUNT_MAX = 10_000;

export const RADIO_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RADIO_OVERLAY_SOURCE_ID = 'radio';

export const RADIO_OVERLAY_COHORT_LIMIT = 64;

export const RADIO_SINGLETON_GLOBAL_LIMIT = 16;

export const RADIO_SINGLETON_MID_LIMIT = 32;

export const RADIO_SINGLETON_NEAR_LIMIT = 48;

export const RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M = 50_000_000;

export const RADIO_GLOBE_RECENTER_MAX_HEIGHT_M = 13_000_000;

export const RADIO_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: RADIO_OVERLAY_COHORT_LIMIT,
  collisionCapacity: 96,
  moving: false,
});

export const RADIO_PICK_OFFSETS = Object.freeze([
  [0, -RADIO_PICK_TOLERANCE_PX],
  [RADIO_PICK_TOLERANCE_PX, 0],
  [0, RADIO_PICK_TOLERANCE_PX],
  [-RADIO_PICK_TOLERANCE_PX, 0],
  [6, -6],
  [6, 6],
  [-6, 6],
  [-6, -6],
]);

export const DEFAULT_RADIO_FILTER = 'all';

export const GLOBAL_RADIO_ALTITUDE_M = 2_000_000;

// Genre labels stay English data (the radio source, shared with the AI tools,
// imports this module); categories.js translates them.
const msg = (text) => text;

export const MUSIC_GENRES = Object.freeze([
  ['alternative', msg('Alternative')],
  ['ambient', msg('Ambient')],
  ['blues', msg('Blues')],
  ['classical', msg('Classical')],
  ['country', msg('Country')],
  ['dance', msg('Dance')],
  ['electronic', msg('Electronic')],
  ['folk', msg('Folk')],
  ['funk', msg('Funk')],
  ['hip hop', msg('Hip-Hop')],
  ['house', msg('House')],
  ['indie', msg('Indie')],
  ['jazz', msg('Jazz')],
  ['latin', msg('Latin')],
  ['metal', msg('Metal')],
  ['oldies', msg('Oldies')],
  ['pop', msg('Pop')],
  ['punk', msg('Punk')],
  ['r&b', msg('R&B')],
  ['reggae', msg('Reggae')],
  ['rock', msg('Rock')],
  ['soul', msg('Soul')],
  ['techno', msg('Techno')],
  ['trance', msg('Trance')],
  ['world', msg('World')],
]);

export const CATEGORY_MATCHERS = Object.freeze({
  news: ['news', 'current affairs', 'journalism'],
  talk: ['talk', 'spoken word', 'interview', 'podcast'],
  weather: ['weather', 'emergency', 'noaa'],
  'public-safety': [
    'public safety',
    'scanner',
    'police',
    'fire',
    'ems',
    'dispatch',
    'emergency',
  ],
  'aviation-marine': [
    'aviation',
    'air traffic',
    'atc',
    'airport',
    'marine',
    'maritime',
    'coast guard',
  ],
  'traffic-transit': ['traffic', 'transit', 'transport', 'rail', 'metro'],
});

export const RADIO_CATEGORY_COLORS = Object.freeze({
  all: '#b9fbff',
  news: '#44adff',
  talk: '#f2b84b',
  weather: '#ff5c78',
  'public-safety': '#ff8b4a',
  'aviation-marine': '#a87cff',
  'traffic-transit': '#ffd166',
  music: '#54d17a',
  other: '#9aa7b3',
});

export const RADIO_MARKER_CATEGORY_ORDER = Object.freeze([
  'news',
  'public-safety',
  'weather',
  'aviation-marine',
  'traffic-transit',
  'talk',
  'music',
]);

export const DEFAULT_RADIO_VOLUME = 0.8;

export const EMPTY_ACCEPTED_CATALOG_SNAPSHOT = Object.freeze({
  instance: null,
  generation: null,
  updatedAt: null,
  stations: Object.freeze([]),
  stationIds: Object.freeze([]),
});

export const VOICE_RESTORE_DELAY_MS = 650;

export const VOICE_RESTORE_DURATION_MS = 1800;

export const RADIO_GLOBE_LABEL_MAX_CHARS = 30;

export const RADIO_LABEL_SEGMENTER =
  typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
