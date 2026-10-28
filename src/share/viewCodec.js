/**
 * Compact share-view codec, format version 1.
 *
 * A shared view travels as a short code in a link's path, `/share/<code>`. The
 * code is base64url text for one version byte, protobuf-style tag-length-value
 * fields and a one-byte CRC-8 check. Settings equal to their default are
 * omitted, and the decoder fills them back in from the same defaults table the
 * encoder reads. Older decoders skip fields they do not know, so new fields
 * never break old links or old apps.
 *
 * The rules that keep links valid forever (field numbers, codes and defaults
 * are permanent) are in docs/SHARE-LINK-FORMAT.md. Read them before changing
 * anything in this file.
 *
 * Pure: no DOM, no Cesium. The long `#v=2&lat=…` form is still parsed by
 * sharelink.js; legacyShareState.js converts between the two.
 */

import {
  LAYER_STATE_REGISTRY,
  LAYER_STATE_TOKEN_ALPHABET,
  REGISTRY_BY_ID,
  SHARE_TRACKING_RESTORE_POLICIES,
  TRACKING_ID_GRAMMAR,
  normalizeLayerState,
  optionSpecs,
} from '../data/layerState.js';
import {
  migrateDetectionState,
  normalizeAllocationStrategy,
} from '../data/detectionPolicy.js';
import { clampScopeFeatherPct } from '../scopeMaskPolicy.js';
import { VIEW_STYLES } from '../view/index.js';
import {
  GLOBAL_POST_DEFAULTS,
  STYLE_PRESET_DEFAULTS,
  STYLES,
} from '../ui/visualPresets.js';
import {
  SHARE_VIEW_ENTITY_KINDS,
  SHARE_VIEW_FOLLOW_OFFSET_DEFAULT,
  followCameraFor,
} from './follow.js';
import {
  MAX_ZIGZAG_MAGNITUDE,
  ShareWireError,
  WIRE_LEN,
  WIRE_VARINT,
  WireReader,
  WireWriter,
  asciiText,
  decodeBase64Url,
  asciiBytes,
  crc8,
  encodeBase64Url,
  unzigzag,
  zigzag,
} from './wire.js';

export {
  SHARE_VIEW_ENTITY_KINDS,
  SHARE_VIEW_FOLLOW_OFFSET_DEFAULT,
  followCameraFor,
  followOffsetFromEnu,
  followOffsetToEnu,
} from './follow.js';

/** First payload byte. Bump only for a change older decoders must refuse. */
export const SHARE_VIEW_FORMAT_VERSION = 1;
/** Input bound, checked before any decoding work (1536 payload bytes). */
export const MAX_SHARE_VIEW_CHARS = 2048;

/** Created-at and observed-at seconds are stored relative to this instant. */
export const SHARE_VIEW_EPOCH_S = Date.UTC(2026, 0, 1) / 1000;

/** Coordinates are stored as integer multiples of this many degrees (≈11 m). */
const COORDINATE_SCALE = 1e4;
const MAX_ALTITUDE_M = 1e9;
const MAX_FOLLOW_RANGE_M = 1e8;
const MAX_UNSIGNED_SETTING = 1e6;
/** Terminus pin range; mirrors SCOPE_TERMINUS_MIN/MAX_PCT in scopeMask.js. */
const SCOPE_TERMINUS_MIN_PCT = 94;
const SCOPE_TERMINUS_MAX_PCT = 100;
const NAME_GRAMMAR = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_OPTION_VALUE_CHARS = 256;

const freezeAll = (rows) =>
  Object.freeze(rows.map((row) => Object.freeze(row)));

/**
 * Enum code tables. A code is permanent: append new names, never renumber or
 * reuse. A name missing from its table still travels, as text in the same
 * field (wire type LEN), so the app can grow faster than this table.
 */
export const SHARE_VIEW_ENUMS = Object.freeze({
  viewKind: Object.freeze(['place', 'thing']),
  style: Object.freeze([
    'normal',
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
    'snow',
  ]),
  mapStack: Object.freeze([
    'photoreal',
    'bing-aerial',
    'bing-labels',
    'esri-imagery',
    'osm',
  ]),
  hudVariant: Object.freeze(['tactical', 'operator', 'minimal', 'cyber']),
  detectionMode: Object.freeze(['OFF', 'SPARSE', 'BALANCED', 'DENSE']),
  detectionAllocation: Object.freeze(['ELASTIC', 'WEIGHTED']),
});

const ENTITY_BY_KIND = new Map(SHARE_VIEW_ENTITY_KINDS.map((e) => [e.kind, e]));
const ENTITY_BY_CODE = new Map(SHARE_VIEW_ENTITY_KINDS.map((e) => [e.code, e]));

/**
 * Shareable panels, numbered permanently. `collapsed` and `pinned` are the
 * frozen meaning of an omitted entry (the layout a fresh session shows today),
 * not a live default: if the app's default moves, this table does not.
 * `token` is the panel's letter in the long form's `ui` parameter.
 */
export const SHARE_VIEW_PANELS = freezeAll([
  {
    number: 0,
    id: 'control-panel',
    token: 'c',
    pinnable: true,
    collapsed: true,
  },
  {
    number: 1,
    id: 'location-bar',
    token: 'l',
    pinnable: true,
    collapsed: true,
  },
  { number: 2, id: 'data-panel', token: 'd', pinnable: false, collapsed: true },
  { number: 3, id: 'cctv-panel', token: 'v', pinnable: false, collapsed: true },
  {
    number: 4,
    id: 'recent-imagery-panel',
    token: 'i',
    pinnable: false,
    collapsed: false,
  },
  {
    number: 5,
    id: 'street-level-panel',
    token: 't',
    pinnable: false,
    collapsed: true,
  },
  {
    number: 6,
    id: 'radio-panel',
    token: 'r',
    pinnable: false,
    collapsed: true,
  },
  {
    number: 7,
    id: 'scene-panel',
    token: 's',
    pinnable: false,
    collapsed: true,
  },
  {
    number: 8,
    id: 'global-context-panel',
    token: 'g',
    pinnable: false,
    collapsed: true,
  },
  { number: 9, id: 'pp-toggles', token: 'p', pinnable: false, collapsed: true },
  {
    number: 10,
    id: 'param-slider-panel',
    token: 'm',
    pinnable: false,
    collapsed: false,
  },
]);
const PANEL_BY_NUMBER = new Map(SHARE_VIEW_PANELS.map((p) => [p.number, p]));
const PANEL_BY_ID = new Map(SHARE_VIEW_PANELS.map((p) => [p.id, p]));

/**
 * Shareable visual-preset parameters per style, as in the long form's `sp`
 * parameter: values are stored ×100 after clamping to [min, max]. A
 * parameter's token is permanent within its style.
 */
export const SHARE_VIEW_STYLE_PARAMS = Object.freeze({
  retro: freezeAll([
    { key: 'pixelation', token: 'p', min: 1, max: 10 },
    { key: 'distortion', token: 'd', min: 0, max: 1 },
    { key: 'instability', token: 'i', min: 0, max: 1 },
  ]),
  surveillance: freezeAll([
    { key: 'gain', token: 'g', min: 0, max: 1 },
    { key: 'bloom', token: 'b', min: 0, max: 1 },
    { key: 'scanlineStr', token: 's', min: 0, max: 1 },
    { key: 'pixelation', token: 'p', min: 1, max: 6 },
  ]),
  thermal: freezeAll([
    { key: 'sensitivity', token: 's', min: 0, max: 1 },
    { key: 'bloom', token: 'b', min: 0, max: 1 },
    { key: 'mode', token: 'm', min: 0, max: 1 },
    { key: 'pixelation', token: 'p', min: 1, max: 6 },
    { key: 'palette', token: 'a', min: 0, max: 1 },
  ]),
  anime: freezeAll([
    { key: 'saturation', token: 's', min: 0, max: 2 },
    { key: 'edgeThick', token: 'e', min: 0, max: 1 },
  ]),
  noir: freezeAll([
    { key: 'contrastAmt', token: 'c', min: 0, max: 2 },
    { key: 'grainAmt', token: 'g', min: 0, max: 1 },
    { key: 'vignetteAmt', token: 'v', min: 0, max: 1 },
  ]),
  snow: freezeAll([
    { key: 'density', token: 'd', min: 0, max: 1 },
    { key: 'wind', token: 'w', min: 0, max: 1 },
  ]),
});

/**
 * The default of a setting a style applies when it is selected: the value
 * comes from SHARE_VIEW_STYLE_DEFAULTS for the view's style, so a view that
 * keeps its style's look costs nothing for it.
 */
export const BY_STYLE = 'by-style';

/**
 * Booleans share one varint (field 9). Bit `bit` is set when the value
 * DIFFERS from `default`, so an absent field means "all defaults" and a bit
 * an older decoder does not know is harmless. Bits are permanent.
 */
export const SHARE_VIEW_FLAGS = freezeAll([
  { bit: 0, key: 'bloom', default: BY_STYLE },
  { bit: 1, key: 'sharpen', default: BY_STYLE },
  { bit: 2, key: 'hudVisible', default: BY_STYLE },
  { bit: 3, key: 'celestialRing', default: BY_STYLE },
  { bit: 4, key: 'scopeEnabled', default: true },
]);

/**
 * What an omitted layer option means, per option owner and key. Frozen like
 * every other default here: it is today's app default, and it stays even if
 * that default moves (the long form learned this with `models3d`). A new
 * option needs an entry before it ships; until it has one it is always
 * written explicitly.
 */
export const SHARE_VIEW_LAYER_OPTION_ABSENT = Object.freeze({
  traffic: Object.freeze({ roadMode: null }),
  'weather-lightning': Object.freeze({ opacity: 'strong' }),
  'weather-radar': Object.freeze({ opacity: 'strong' }),
  'weather-satellite': Object.freeze({
    infrared: 100,
    opacity: 'strong',
    product: 'clouds-regional',
  }),
  wind: Object.freeze({
    model: 'gfs',
    overlay: 'none',
    units: 'km/h',
    paused: false,
  }),
  flights: Object.freeze({
    models3d: true,
    models3dMode: 'proximity',
    selectedFlightsTrackingId: null,
    selectedMilitaryTrackingId: null,
  }),
  satellites: Object.freeze({ catalog: 'core', selectedSatTrackingId: null }),
  cctv: Object.freeze({
    coverageMode: 'on',
    showProjection: true,
    autoHop: false,
  }),
  'recent-imagery': Object.freeze({
    west: null,
    south: null,
    east: null,
    north: null,
    a: null,
    b: null,
    mode: 0,
    split: 50,
    viirs: false,
  }),
  'street-level': Object.freeze({
    mapillary: true,
    providerSwitches: '',
    pano: 'all',
    sinceDays: 0,
  }),
  radio: Object.freeze({ filter: 'all', volume: 0.8 }),
});

/** The frozen meaning of an omitted option; unlisted options are always written. */
function layerOptionAbsentValue(ownerId, spec) {
  const owner = SHARE_VIEW_LAYER_OPTION_ABSENT[ownerId];
  return owner && Object.hasOwn(owner, spec.key) ? owner[spec.key] : undefined;
}

/**
 * The top-level field registry. Numbers are permanent and never reused; a
 * retired field stays listed with `retired: true`. Defaults are the frozen
 * meaning of an omitted field. Types:
 *   uint    unsigned varint            sint   zigzag varint
 *   angle   whole degrees in [0, 360), stored as zigzag of (-180, 180]
 *   coord   zigzag varint of degrees × 1e4
 *   enum    varint code from SHARE_VIEW_ENUMS, or LEN text for other names
 *   epoch   zigzag varint of seconds since SHARE_VIEW_EPOCH_S
 *   flags   varint bitset, see SHARE_VIEW_FLAGS
 *   bytes   LEN, structure documented per field
 */
export const SHARE_VIEW_FIELDS = freezeAll([
  { number: 1, key: 'view', type: 'enum', enum: 'viewKind', default: 'place' },
  { number: 2, key: 'lat', type: 'coord', default: 0 },
  { number: 3, key: 'lon', type: 'coord', default: 0 },
  { number: 4, key: 'alt', type: 'sint', default: 800 },
  { number: 5, key: 'heading', type: 'angle', default: 0 },
  { number: 6, key: 'pitch', type: 'sint', default: -35 },
  { number: 7, key: 'roll', type: 'angle', default: 0 },
  { number: 8, key: 'sharedAtMs', type: 'epoch', default: null },
  { number: 9, key: 'flags', type: 'flags', default: 0 },
  { number: 10, key: 'layerState', type: 'bytes', default: null },
  { number: 11, key: 'layerOptions', type: 'bytes', default: null },
  { number: 12, key: 'panelState', type: 'bytes', default: null },
  { number: 13, key: 'thing', type: 'bytes', default: null },
  { number: 14, key: 'style', type: 'enum', enum: 'style', default: 'normal' },
  {
    number: 15,
    key: 'mapStack',
    type: 'enum',
    enum: 'mapStack',
    default: 'photoreal',
  },
  {
    number: 16,
    key: 'hudVariant',
    type: 'enum',
    enum: 'hudVariant',
    default: BY_STYLE,
  },
  { number: 17, key: 'bloomIntensity', type: 'uint', default: BY_STYLE },
  { number: 18, key: 'bloomVersion', type: 'uint', default: 2 },
  { number: 19, key: 'sharpenIntensity', type: 'uint', default: BY_STYLE },
  {
    number: 20,
    key: 'detectionMode',
    type: 'enum',
    enum: 'detectionMode',
    default: BY_STYLE,
  },
  { number: 21, key: 'detectionDensity', type: 'uint', default: BY_STYLE },
  {
    number: 22,
    key: 'detectionAllocation',
    type: 'enum',
    enum: 'detectionAllocation',
    default: BY_STYLE,
  },
  { number: 23, key: 'detectionFadePct', type: 'uint', default: BY_STYLE },
  {
    number: 24,
    key: 'detectionOutsideOpacityPct',
    type: 'uint',
    default: BY_STYLE,
  },
  { number: 25, key: 'scopeFeatherPct', type: 'uint', default: 100 },
  { number: 26, key: 'scopeTerminusPct', type: 'uint', default: null },
  { number: 27, key: 'styleParams', type: 'bytes', default: BY_STYLE },
]);
const FIELD_BY_KEY = new Map(SHARE_VIEW_FIELDS.map((f) => [f.key, f]));
const fieldNumber = (key) => FIELD_BY_KEY.get(key).number;

/**
 * Fields inside the thing message (top-level field 13). Permanent. Fields 1–4
 * are the entity ids, one per SHARE_VIEW_ENTITY_KINDS code; exactly one is
 * present. The follow offset and the last-known fix are flat fields here, not
 * sub-messages, to save their tag and length bytes.
 */
export const SHARE_VIEW_THING_FIELDS = Object.freeze({
  range: 5, // uint metres from the entity to the camera
  heading: 6, // angle, the camera's heading while following
  pitch: 7, // sint whole degrees, the camera's pitch while following
  lat: 8, // coord, the entity's last-known latitude
  lon: 9, // coord, its last-known longitude
  alt: 10, // sint metres, its last-known altitude
  ageS: 11, // sint, seconds the fix predates the created-at time (field 8)
  observedAt: 12, // epoch, when the fix was taken; only without a created-at
});

/** The default of a field or flag for a view in `style`. */
function defaultOf(entry, style) {
  if (entry.default !== BY_STYLE) return entry.default;
  const defaults =
    SHARE_VIEW_STYLE_DEFAULTS[style] ?? SHARE_VIEW_STYLE_DEFAULTS.normal;
  return defaults[entry.key];
}

/**
 * The complete default state for a view in `style` (Normal when omitted):
 * what a payload with only that style decodes to.
 */
export function createDefaultShareViewState(requested = 'normal') {
  const style = VIEW_STYLES.includes(requested) ? requested : 'normal';
  const state = { view: { kind: 'place' } };
  for (const field of SHARE_VIEW_FIELDS) {
    if (field.key === 'view' || field.key === 'flags') continue;
    if (field.key === 'thing' || field.key === 'layerOptions') continue;
    state[field.key] =
      field.key === 'style' ? style : structuredClone(defaultOf(field, style));
  }
  for (const flag of SHARE_VIEW_FLAGS) state[flag.key] = defaultOf(flag, style);
  return state;
}

/* ------------------------------------------------------------------ */
/* Normalization: the one canonical state both directions agree on.    */
/* ------------------------------------------------------------------ */

const finite = (value) =>
  typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' &&
      value.trim() !== '' &&
      Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// `+ 0` turns -0 into 0, which is what the decoder produces.
function intOr(value, fallback, min, max) {
  return finite(value)
    ? clamp(Math.round(Number(value)), min, max) + 0
    : fallback;
}

function wrapAngle(value, fallback = 0) {
  if (!finite(value)) return fallback;
  return ((Math.round(Number(value)) % 360) + 360) % 360;
}

function latitudeOr(value, fallback) {
  if (!finite(value)) return fallback;
  return (
    Math.round(clamp(Number(value), -90, 90) * COORDINATE_SCALE) /
      COORDINATE_SCALE +
    0
  );
}

function longitudeOr(value, fallback) {
  if (!finite(value)) return fallback;
  let lon = Number(value);
  // Wrap before scaling, so a huge finite input cannot overflow to NaN.
  if (lon < -180 || lon > 180) lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Math.round(lon * COORDINATE_SCALE) / COORDINATE_SCALE + 0;
}

function epochMsOr(value) {
  if (!finite(value)) return null;
  const seconds = Math.floor(Number(value) / 1000);
  return seconds >= 1 && Number.isSafeInteger(seconds * 1000)
    ? seconds * 1000
    : null;
}

function nameOr(value, fallback) {
  return typeof value === 'string' && NAME_GRAMMAR.test(value)
    ? value
    : fallback;
}

function normalizeEntityId(entry, value) {
  if (value === null || value === undefined) return null;
  const raw =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim().toLowerCase()
        : null;
  if (raw === null || !TRACKING_ID_GRAMMAR.test(raw)) return null;
  if (entry.kind === 'satellite' && !/^[1-9]\d{0,14}$/.test(raw)) return null;
  return raw;
}

function normalizeStyleParams(style, values) {
  const registry = SHARE_VIEW_STYLE_PARAMS[style];
  if (!registry || !values || typeof values !== 'object') return null;
  const out = {};
  for (const spec of registry) {
    if (!Object.hasOwn(values, spec.key) || !finite(values[spec.key])) continue;
    out[spec.key] =
      Math.round(clamp(Number(values[spec.key]), spec.min, spec.max) * 100) /
      100;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * What each style leaves the shareable settings at when it is selected in a
 * fresh session: the app's first-load baseline (GLOBAL_POST_DEFAULTS), with
 * the style's own preset (STYLE_PRESET_DEFAULTS) on top, and its shader
 * parameters at their defaults (the preset's, else the shader's). Read from
 * the tables the app applies, so a fresh view in any style encodes as its
 * camera and style alone.
 *
 * These are format v1's frozen meanings. If the app's tables move, the test
 * that pins this table fails: freeze the old values here then, rather than
 * letting old links change meaning.
 */
export const SHARE_VIEW_STYLE_DEFAULTS = Object.freeze(
  Object.fromEntries(
    VIEW_STYLES.map((style) => {
      const g = GLOBAL_POST_DEFAULTS;
      const preset = STYLE_PRESET_DEFAULTS[style] ?? {};
      const detection = migrateDetectionState(
        preset.detection?.mode?.toUpperCase?.() ?? g.detectionMode,
        preset.detection?.densityPct ?? g.detectionDensity,
        g.detectionDensity,
      );
      const params = {};
      for (const spec of SHARE_VIEW_STYLE_PARAMS[style] ?? []) {
        const value =
          preset.styleParams?.[style]?.[spec.key] ??
          STYLES[style]?.uniforms?.[spec.key]?.default;
        if (finite(value)) params[spec.key] = value;
      }
      return [
        style,
        Object.freeze({
          bloom: preset.bloom?.enabled ?? g.bloom.enabled,
          bloomIntensity: preset.bloom?.intensity ?? g.bloom.intensity,
          sharpen: preset.sharpen?.enabled ?? g.sharpen.enabled,
          sharpenIntensity: preset.sharpen?.intensity ?? g.sharpen.intensity,
          hudVariant: preset.hudVariant ?? g.hudVariant,
          hudVisible: preset.hudVisible ?? g.hudVisible,
          detectionMode: detection.enabled ? detection.profile : 'OFF',
          detectionDensity: detection.densityPct,
          detectionAllocation: normalizeAllocationStrategy(
            g.detectionAllocation,
          ),
          detectionFadePct: g.detectionFadePct,
          detectionOutsideOpacityPct: g.detectionOutsideOpacityPct,
          // Leaving Normal switches the ring off (VisualSettings.setStyle).
          celestialRing: style === 'normal' ? g.celestialRing : false,
          styleParams: Object.freeze(normalizeStyleParams(style, params)),
        }),
      ];
    }),
  ),
);

function normalizePanelState(panelState) {
  if (!panelState || !Array.isArray(panelState.specs)) return null;
  const byId = new Map();
  for (const spec of panelState.specs) {
    if (spec && PANEL_BY_ID.has(spec.id) && typeof spec.collapsed === 'boolean')
      byId.set(spec.id, spec);
  }
  const specs = [];
  for (const panel of SHARE_VIEW_PANELS) {
    const spec = byId.get(panel.id);
    if (!spec) continue;
    specs.push({
      id: panel.id,
      collapsed: spec.collapsed,
      pinned:
        panel.pinnable && typeof spec.pinned === 'boolean' ? spec.pinned : null,
    });
  }
  return specs.length ? { specs } : null;
}

function normalizeFollowOffset(offset) {
  const d = SHARE_VIEW_FOLLOW_OFFSET_DEFAULT;
  const source = offset && typeof offset === 'object' ? offset : {};
  return {
    range: intOr(source.range, d.range, 1, MAX_FOLLOW_RANGE_M),
    heading: wrapAngle(source.heading, d.heading),
    pitch: intOr(source.pitch, d.pitch, -90, 90),
  };
}

function normalizeLastKnown(fix) {
  if (!fix || typeof fix !== 'object') return null;
  if (!finite(fix.lat) || !finite(fix.lon)) return null;
  return {
    lat: latitudeOr(fix.lat, 0),
    lon: longitudeOr(fix.lon, 0),
    alt: intOr(fix.alt, 0, -MAX_ALTITUDE_M, MAX_ALTITUDE_M),
    observedAtMs: epochMsOr(fix.observedAtMs),
  };
}

function thingView(kind, id, offset = null, lastKnown = null) {
  return {
    kind: 'thing',
    entity: { kind, id },
    offset: normalizeFollowOffset(offset),
    lastKnown: normalizeLastKnown(lastKnown),
  };
}

function normalizeView(view) {
  if (view?.kind !== 'thing') return { kind: 'place' };
  const entry = ENTITY_BY_KIND.get(view.entity?.kind);
  const id = entry ? normalizeEntityId(entry, view.entity?.id) : null;
  if (!id) return { kind: 'place' };
  return thingView(entry.kind, id, view.offset, view.lastKnown);
}

/** The camera fields of `state`, at the format's precision. */
function setCamera(state, camera) {
  state.lat = latitudeOr(camera.lat, 0);
  state.lon = longitudeOr(camera.lon, 0);
  state.alt = intOr(camera.alt, 0, -MAX_ALTITUDE_M, MAX_ALTITUDE_M);
  state.heading = wrapAngle(camera.heading, 0);
  state.pitch = intOr(camera.pitch, 0, -90, 90);
  state.roll = wrapAngle(camera.roll, 0);
}

/**
 * Lift a long-form tracking selection out of the layer options into a thing
 * view. In this format the view, not a layer option, says what is followed.
 */
function liftTrackedEntity(layerState, view) {
  let lifted = view;
  for (const entry of SHARE_VIEW_ENTITY_KINDS) {
    const policy = entry.tracking
      ? SHARE_TRACKING_RESTORE_POLICIES[entry.tracking]
      : null;
    if (!policy) continue;
    const options = layerState.options[policy.optionOwner];
    const id = normalizeEntityId(entry, options[policy.optionKey]);
    options[policy.optionKey] = null;
    if (id && lifted.kind === 'place') lifted = thingView(entry.kind, id);
  }
  return lifted;
}

/**
 * The canonical form of a share-view state. Missing or invalid fields take
 * their defaults, numbers take the format's precision, and a long-form
 * tracking selection becomes a thing view. A thing view with a last-known fix
 * takes its camera from the fix and the follow offset, and a thing view's
 * layer is always on. `decodeShareView` returns this
 * form, and `encodeShareView(state)` decodes back to `normalizeShareViewState(state)`.
 */
export function normalizeShareViewState(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const style = VIEW_STYLES.includes(source.style) ? source.style : 'normal';
  // Style-applied settings default to what this style applies.
  const d = createDefaultShareViewState(style);
  const state = {};
  state.lat = latitudeOr(source.lat, d.lat);
  state.lon = longitudeOr(source.lon, d.lon);
  state.alt = intOr(source.alt, d.alt, -MAX_ALTITUDE_M, MAX_ALTITUDE_M);
  state.heading = wrapAngle(source.heading, d.heading);
  state.pitch = intOr(source.pitch, d.pitch, -90, 90);
  state.roll = wrapAngle(source.roll, d.roll);
  state.style = style;
  // The style's own parameters, with any valid ones the source sets on top.
  state.styleParams = normalizeStyleParams(style, {
    ...d.styleParams,
    ...normalizeStyleParams(style, source.styleParams),
  });
  for (const flag of SHARE_VIEW_FLAGS)
    state[flag.key] =
      typeof source[flag.key] === 'boolean' ? source[flag.key] : d[flag.key];
  state.bloomIntensity = intOr(
    source.bloomIntensity,
    d.bloomIntensity,
    0,
    MAX_UNSIGNED_SETTING,
  );
  state.bloomVersion = intOr(
    source.bloomVersion,
    d.bloomVersion,
    0,
    MAX_UNSIGNED_SETTING,
  );
  state.sharpenIntensity = intOr(
    source.sharpenIntensity,
    d.sharpenIntensity,
    0,
    MAX_UNSIGNED_SETTING,
  );
  state.hudVariant = nameOr(source.hudVariant, d.hudVariant);
  const detection = migrateDetectionState(
    typeof source.detectionMode === 'string' && source.detectionMode
      ? source.detectionMode
      : d.detectionMode,
    finite(source.detectionDensity)
      ? Number(source.detectionDensity)
      : d.detectionDensity,
    d.detectionDensity,
  );
  state.detectionMode = detection.enabled ? detection.profile : 'OFF';
  state.detectionDensity = detection.densityPct;
  state.detectionAllocation = normalizeAllocationStrategy(
    source.detectionAllocation,
    d.detectionAllocation,
  );
  state.detectionFadePct = intOr(
    source.detectionFadePct,
    d.detectionFadePct,
    0,
    40,
  );
  state.detectionOutsideOpacityPct = intOr(
    source.detectionOutsideOpacityPct,
    d.detectionOutsideOpacityPct,
    0,
    100,
  );
  state.scopeFeatherPct = finite(source.scopeFeatherPct)
    ? clampScopeFeatherPct(Number(source.scopeFeatherPct))
    : d.scopeFeatherPct;
  state.scopeTerminusPct = intOr(
    source.scopeTerminusPct,
    null,
    SCOPE_TERMINUS_MIN_PCT,
    SCOPE_TERMINUS_MAX_PCT,
  );
  state.mapStack = nameOr(source.mapStack, d.mapStack);
  state.layerState = source.layerState
    ? normalizeLayerState(source.layerState)
    : null;
  state.panelState = normalizePanelState(source.panelState);
  state.sharedAtMs = epochMsOr(source.sharedAtMs);
  let view = normalizeView(source.view);
  if (state.layerState) view = liftTrackedEntity(state.layerState, view);
  if (view.kind === 'thing') {
    // A fix without its own time is as of the link's creation.
    if (view.lastKnown?.observedAtMs === null && state.sharedAtMs !== null)
      view.lastKnown.observedAtMs = state.sharedAtMs;
    // A thing view's camera is where following it puts the camera, and its
    // layer is on: neither is stored separately.
    if (view.lastKnown)
      setCamera(state, followCameraFor(view.lastKnown, view.offset));
    const { layerId } = ENTITY_BY_KIND.get(view.entity.kind);
    if (state.layerState && !state.layerState.enabledLayerIds.includes(layerId))
      state.layerState = normalizeLayerState({
        ...state.layerState,
        enabledLayerIds: [...state.layerState.enabledLayerIds, layerId],
      });
  }
  return { view, ...state };
}

/* ------------------------------------------------------------------ */
/* Token and id helpers.                                               */
/* ------------------------------------------------------------------ */

/**
 * The permanent number of a layer-state token: one character is its index in
 * the base-36 alphabet, two characters are 36 + first × 36 + second. The
 * token ledger never reassigns a token, so neither does this.
 */
export function layerTokenNumber(token) {
  const a = LAYER_STATE_TOKEN_ALPHABET.indexOf(token[0]);
  if (token.length === 1) return a;
  return 36 + a * 36 + LAYER_STATE_TOKEN_ALPHABET.indexOf(token[1]);
}

export function layerTokenFromNumber(number) {
  const base = LAYER_STATE_TOKEN_ALPHABET.length;
  if (number < base) return LAYER_STATE_TOKEN_ALPHABET[number];
  const rest = number - base;
  if (rest >= base * base) return null;
  return (
    LAYER_STATE_TOKEN_ALPHABET[Math.floor(rest / base)] +
    LAYER_STATE_TOKEN_ALPHABET[rest % base]
  );
}

const REGISTRY_BY_TOKEN = new Map(
  LAYER_STATE_REGISTRY.map((entry) => [entry.token, entry]),
);
const charNumber = (char) => LAYER_STATE_TOKEN_ALPHABET.indexOf(char);
const CANONICAL_INTEGER = /^(0|-?[1-9]\d{0,14})$/;

function writeEntityId(writer, entry, id) {
  const field = entry.code;
  if (entry.idForm === 'hex24' && /^[0-9a-f]{6}$/.test(id))
    return writer.uintField(field, Number.parseInt(id, 16));
  if (entry.idForm === 'decimal' && /^[1-9]\d{0,14}$/.test(id))
    return writer.uintField(field, Number(id));
  return writer.textField(field, id);
}

/* ------------------------------------------------------------------ */
/* Encoder.                                                            */
/* ------------------------------------------------------------------ */

function writeEnum(writer, field, value) {
  const code = SHARE_VIEW_ENUMS[field.enum].indexOf(value);
  if (code >= 0) writer.uintField(field.number, code);
  else writer.textField(field.number, value);
}

function encodeLayers(writer, layerState, impliedLayerId) {
  const bitset = [];
  for (const id of layerState.enabledLayerIds) {
    if (id === impliedLayerId) continue;
    const number = layerTokenNumber(REGISTRY_BY_ID.get(id).token);
    const byte = Math.floor(number / 8);
    while (bitset.length <= byte) bitset.push(0);
    bitset[byte] |= 1 << (number % 8);
  }
  writer.bytesField(fieldNumber('layerState'), bitset);
  const blob = new WireWriter();
  for (const [ownerId, options] of Object.entries(layerState.options)) {
    const ownerToken = REGISTRY_BY_ID.get(ownerId).token;
    for (const spec of optionSpecs(ownerId)) {
      const current = options[spec.key];
      if (current === null || current === layerOptionAbsentValue(ownerId, spec))
        continue;
      const value = spec.encode(options[spec.key]);
      blob.varint(layerTokenNumber(ownerToken));
      const isInteger =
        CANONICAL_INTEGER.test(value) &&
        Math.abs(Number(value)) <= MAX_ZIGZAG_MAGNITUDE;
      blob.varint(charNumber(spec.token) * 2 + (isInteger ? 0 : 1));
      if (isInteger) blob.varint(zigzag(Number(value)));
      else {
        const bytes = asciiBytes(value);
        blob.varint(bytes.length);
        blob.bytes.push(...bytes);
      }
    }
  }
  if (blob.bytes.length)
    writer.bytesField(fieldNumber('layerOptions'), blob.finish());
}

const triState = (value) => (value === null ? 0 : value ? 2 : 1);

function encodePanels(writer, panelState) {
  const byId = new Map(panelState.specs.map((spec) => [spec.id, spec]));
  const blob = new WireWriter();
  for (const panel of SHARE_VIEW_PANELS) {
    const spec = byId.get(panel.id);
    const defaultPinned = panel.pinnable ? false : null;
    if (
      spec &&
      spec.collapsed === panel.collapsed &&
      spec.pinned === defaultPinned
    )
      continue;
    const collapsed = spec ? triState(spec.collapsed) : 0;
    const pinned = spec ? triState(spec.pinned) : 0;
    blob.varint(panel.number * 16 + collapsed * 4 + pinned);
  }
  writer.bytesField(fieldNumber('panelState'), blob.finish());
}

function encodeStyleParams(writer, style, values) {
  const defaults = SHARE_VIEW_STYLE_DEFAULTS[style].styleParams ?? {};
  const blob = new WireWriter();
  for (const spec of SHARE_VIEW_STYLE_PARAMS[style]) {
    // Only the parameters that differ from the style's own.
    if (!Object.hasOwn(values, spec.key)) continue;
    if (values[spec.key] === defaults[spec.key]) continue;
    blob
      .varint(charNumber(spec.token))
      .varint(Math.round(values[spec.key] * 100));
  }
  if (blob.bytes.length)
    writer.bytesField(fieldNumber('styleParams'), blob.finish());
}

const CAMERA_KEYS = new Set(['lat', 'lon', 'alt', 'heading', 'pitch', 'roll']);
const coordinateInt = (degrees) => Math.round(degrees * COORDINATE_SCALE);
const signedAngle = (degrees) => (degrees > 180 ? degrees - 360 : degrees);
const epochSeconds = (ms) => ms / 1000 - SHARE_VIEW_EPOCH_S;

function encodeThing(writer, view, state) {
  const entry = ENTITY_BY_KIND.get(view.entity.kind);
  const f = SHARE_VIEW_THING_FIELDS;
  const d = SHARE_VIEW_FOLLOW_OFFSET_DEFAULT;
  const thing = new WireWriter();
  writeEntityId(thing, entry, view.entity.id);
  const { range, heading, pitch } = view.offset;
  if (range !== d.range) thing.uintField(f.range, range);
  if (heading !== d.heading) thing.sintField(f.heading, signedAngle(heading));
  if (pitch !== d.pitch) thing.sintField(f.pitch, pitch);
  const fix = view.lastKnown;
  if (fix) {
    // Both coordinates are always written: their presence marks the fix.
    thing.sintField(f.lat, coordinateInt(fix.lat));
    thing.sintField(f.lon, coordinateInt(fix.lon));
    if (fix.alt) thing.sintField(f.alt, fix.alt);
    const observed = fix.observedAtMs;
    // An absent age is 0: a fix taken as the link is made costs nothing.
    if (observed !== null && state.sharedAtMs !== null) {
      if (observed !== state.sharedAtMs)
        thing.sintField(f.ageS, (state.sharedAtMs - observed) / 1000);
    } else if (observed !== null)
      thing.sintField(f.observedAt, epochSeconds(observed));
  }
  writer.bytesField(fieldNumber('thing'), thing.finish());
}

/** The base64url text for `bytes` followed by their CRC-8. */
function sealPayload(bytes) {
  const sealed = new Uint8Array(bytes.length + 1);
  sealed.set(bytes);
  sealed[bytes.length] = crc8(bytes);
  return encodeBase64Url(sealed);
}

/**
 * Encode a share-view state as its share code: base64url text, the `<code>`
 * in `/share/<code>`. The state is normalized first; omitted or default
 * fields cost nothing.
 */
export function encodeShareView(input) {
  const state = normalizeShareViewState(input);
  const thing = state.view.kind === 'thing' ? state.view : null;
  // A thing view with a fix derives its camera from it (followCameraFor).
  const cameraDerived = Boolean(thing?.lastKnown);
  const impliedLayerId = thing
    ? ENTITY_BY_KIND.get(thing.entity.kind).layerId
    : null;
  const writer = new WireWriter();
  writer.bytes.push(SHARE_VIEW_FORMAT_VERSION);
  for (const field of SHARE_VIEW_FIELDS) {
    if (cameraDerived && CAMERA_KEYS.has(field.key)) continue;
    switch (field.key) {
      case 'view':
        // Absent means `thing` when field 13 is present, else `place`.
        if (state.view.kind !== (thing ? 'thing' : 'place'))
          writeEnum(writer, field, state.view.kind);
        break;
      case 'lat':
      case 'lon':
        if (state[field.key] !== field.default)
          writer.sintField(field.number, coordinateInt(state[field.key]));
        break;
      case 'heading':
      case 'roll':
        if (state[field.key] !== field.default)
          writer.sintField(field.number, signedAngle(state[field.key]));
        break;
      case 'sharedAtMs':
        if (state.sharedAtMs !== null)
          writer.sintField(field.number, epochSeconds(state.sharedAtMs));
        break;
      case 'flags': {
        let bits = 0;
        for (const flag of SHARE_VIEW_FLAGS)
          if (state[flag.key] !== defaultOf(flag, state.style))
            bits += 2 ** flag.bit;
        if (bits) writer.uintField(field.number, bits);
        break;
      }
      case 'layerState':
        if (state.layerState)
          encodeLayers(writer, state.layerState, impliedLayerId);
        break;
      case 'layerOptions':
        break; // written together with layerState
      case 'panelState':
        if (state.panelState) encodePanels(writer, state.panelState);
        break;
      case 'thing':
        if (thing) encodeThing(writer, thing, state);
        break;
      case 'styleParams':
        if (state.styleParams)
          encodeStyleParams(writer, state.style, state.styleParams);
        break;
      default:
        if (state[field.key] === defaultOf(field, state.style)) break;
        if (field.type === 'enum') writeEnum(writer, field, state[field.key]);
        else if (field.type === 'sint')
          writer.sintField(field.number, state[field.key]);
        else writer.uintField(field.number, state[field.key]);
    }
  }
  return sealPayload(writer.finish());
}

/* ------------------------------------------------------------------ */
/* Decoder.                                                            */
/* ------------------------------------------------------------------ */

/** Collects every field, code or entry a v1 decoder did not understand. */
class UnknownLog {
  constructor() {
    this.entries = [];
  }
  field(scope, field, wireType) {
    this.entries.push({ scope, field, wireType });
  }
  code(scope, code) {
    this.entries.push({ scope, code });
  }
}

/**
 * Read one message's fields, enforcing each known field's wire types and
 * rejecting repeats, skipping (and logging) unknown fields.
 * `known` maps field number → allowed wire types.
 */
function readMessage(reader, known, scope, unknown) {
  const values = new Map();
  while (!reader.done) {
    const { field, wireType } = reader.tag();
    const allowed = known.get(field);
    if (!allowed) {
      unknown.field(scope, field, wireType);
      reader.skip(wireType);
      continue;
    }
    if (!allowed.includes(wireType))
      throw new ShareWireError('wire-type-mismatch', `${scope}.${field}`);
    if (values.has(field))
      throw new ShareWireError('duplicate-field', `${scope}.${field}`);
    values.set(
      field,
      wireType === WIRE_LEN
        ? { len: reader.lengthDelimited() }
        : { varint: reader.varint() },
    );
  }
  return values;
}

const WIRE_TYPES_BY_TYPE = Object.freeze({
  uint: [WIRE_VARINT],
  sint: [WIRE_VARINT],
  angle: [WIRE_VARINT],
  coord: [WIRE_VARINT],
  epoch: [WIRE_VARINT],
  flags: [WIRE_VARINT],
  enum: [WIRE_VARINT, WIRE_LEN],
  bytes: [WIRE_LEN],
});
const TOP_LEVEL_WIRE_TYPES = new Map(
  SHARE_VIEW_FIELDS.filter((f) => !f.retired).map((f) => [
    f.number,
    WIRE_TYPES_BY_TYPE[f.type],
  ]),
);
const THING_WIRE_TYPES = new Map([
  ...SHARE_VIEW_ENTITY_KINDS.map((e) => [e.code, [WIRE_VARINT, WIRE_LEN]]),
  ...Object.values(SHARE_VIEW_THING_FIELDS).map((n) => [n, [WIRE_VARINT]]),
]);

const unz = unzigzag;
const CLOSED_ENUMS = new Set(['detectionMode', 'detectionAllocation']);

function readEnum(entry, field, unknown) {
  if (!entry) return undefined;
  if (entry.len) {
    const text = asciiText(entry.len.rest());
    // Detection settings are closed sets the app interprets; an unknown name
    // must not reach the long form's lenient migration (which turns it ON).
    if (
      CLOSED_ENUMS.has(field.key) &&
      !SHARE_VIEW_ENUMS[field.enum].includes(text)
    ) {
      unknown.code(`enum:${field.key}`, text);
      return undefined;
    }
    return text;
  }
  const name = SHARE_VIEW_ENUMS[field.enum][entry.varint];
  if (name === undefined) unknown.code(`enum:${field.key}`, entry.varint);
  return name;
}

function decodeLayers(bitsReader, optionsReader, unknown) {
  const enabledLayerIds = [];
  const bits = bitsReader.rest();
  for (let byte = 0; byte < bits.length; byte += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      if (!(bits[byte] & (1 << bit))) continue;
      const number = byte * 8 + bit;
      const entry = REGISTRY_BY_TOKEN.get(layerTokenFromNumber(number));
      if (entry) enabledLayerIds.push(entry.id);
      else unknown.code('layer', number);
    }
  }
  const options = {};
  const seen = new Set();
  const reader = optionsReader;
  while (reader && !reader.done) {
    const layerNumber = reader.varint();
    const key = reader.varint();
    let value;
    if (key % 2 === 0) value = String(unz(reader.varint()));
    else {
      const length = reader.varint();
      if (length > MAX_OPTION_VALUE_CHARS || length > reader.end - reader.pos)
        throw new ShareWireError('truncated', 'layer option');
      value = asciiText(reader.bytes.slice(reader.pos, reader.pos + length));
      reader.pos += length;
    }
    const slot = `${layerNumber}.${Math.floor(key / 2)}`;
    if (seen.has(slot)) throw new ShareWireError('duplicate-entry', slot);
    seen.add(slot);
    // Options are filed under their owner layer only (never a mirror such as
    // `military`), so each option has exactly one spelling.
    const layerEntry = REGISTRY_BY_TOKEN.get(layerTokenFromNumber(layerNumber));
    const ownerId =
      layerEntry?.optionOwner === layerEntry?.id
        ? layerEntry?.optionOwner
        : null;
    const optionToken = LAYER_STATE_TOKEN_ALPHABET[Math.floor(key / 2)];
    const spec = ownerId
      ? optionSpecs(ownerId).find(
          (candidate) => candidate.token === optionToken,
        )
      : null;
    const decoded = spec ? spec.decode(value) : null;
    if (decoded === null || decoded === undefined) {
      unknown.code('layer-option', slot);
      continue;
    }
    options[ownerId] ??= {};
    options[ownerId][spec.key] = decoded;
  }
  // Fill every option the payload did not carry with ITS frozen meaning, not
  // the app's current default (normalization would substitute that).
  for (const ownerId of Object.keys(SHARE_VIEW_LAYER_OPTION_ABSENT)) {
    options[ownerId] ??= {};
    for (const spec of optionSpecs(ownerId)) {
      if (!Object.hasOwn(options[ownerId], spec.key))
        options[ownerId][spec.key] = layerOptionAbsentValue(ownerId, spec);
    }
  }
  return normalizeLayerState({ enabledLayerIds, options });
}

function decodePanels(reader, unknown) {
  const entries = new Map();
  while (!reader.done) {
    const value = reader.varint();
    const number = Math.floor(value / 16);
    if (entries.has(number))
      throw new ShareWireError('duplicate-entry', `panel ${number}`);
    entries.set(number, {
      collapsed: Math.floor(value / 4) % 4,
      pinned: value % 4,
    });
  }
  for (const [number, entry] of entries) {
    if (
      !PANEL_BY_NUMBER.has(number) ||
      entry.collapsed === 3 ||
      entry.pinned === 3
    )
      unknown.code('panel', number);
  }
  const specs = [];
  for (const panel of SHARE_VIEW_PANELS) {
    const entry = entries.get(panel.number);
    if (entry) {
      // 0 is "no opinion"; 3 is a value from a newer format, also ignored.
      if (entry.collapsed === 0 || entry.collapsed === 3 || entry.pinned === 3)
        continue;
      specs.push({
        id: panel.id,
        collapsed: entry.collapsed === 2,
        pinned:
          panel.pinnable && entry.pinned !== 0 ? entry.pinned === 2 : null,
      });
    } else {
      specs.push({
        id: panel.id,
        collapsed: panel.collapsed,
        pinned: panel.pinnable ? false : null,
      });
    }
  }
  return { specs };
}

function decodeStyleParams(reader, style, unknown) {
  const registry = SHARE_VIEW_STYLE_PARAMS[style] || [];
  const values = {};
  const seen = new Set();
  while (!reader.done) {
    const index = reader.varint();
    const token = LAYER_STATE_TOKEN_ALPHABET[index];
    const scaled = reader.varint();
    if (seen.has(index))
      throw new ShareWireError('duplicate-entry', 'style parameter');
    seen.add(index);
    const spec = registry.find((candidate) => candidate.token === token);
    if (!spec) {
      unknown.code('style-param', `${style}.${token ?? '?'}`);
      continue;
    }
    values[spec.key] = clamp(scaled / 100, spec.min, spec.max);
  }
  return values;
}

function decodeEntityId(entry, value) {
  if (!entry) return null;
  if (value.len) return normalizeEntityId(entry, asciiText(value.len.rest()));
  if (entry.idForm === 'hex24')
    return value.varint <= 0xffffff
      ? value.varint.toString(16).padStart(6, '0')
      : null;
  return normalizeEntityId(entry, String(value.varint));
}

function decodeThing(reader, createdAtS, unknown) {
  const unknownBefore = unknown.entries.length;
  const fields = readMessage(reader, THING_WIRE_TYPES, 'thing', unknown);
  const F = SHARE_VIEW_THING_FIELDS;
  const d = SHARE_VIEW_FOLLOW_OFFSET_DEFAULT;
  const signed = (n) => unz(fields.get(n)?.varint ?? 0);
  const offset = {
    range: fields.get(F.range)?.varint ?? d.range,
    heading: fields.has(F.heading) ? signed(F.heading) : d.heading,
    pitch: fields.has(F.pitch) ? signed(F.pitch) : d.pitch,
  };
  let lastKnown = null;
  if (fields.has(F.lat) || fields.has(F.lon)) {
    let observedAtMs = null;
    if (fields.has(F.observedAt))
      observedAtMs = (SHARE_VIEW_EPOCH_S + signed(F.observedAt)) * 1000;
    else if (createdAtS !== null)
      observedAtMs = (createdAtS - signed(F.ageS)) * 1000;
    lastKnown = {
      lat: signed(F.lat) / COORDINATE_SCALE,
      lon: signed(F.lon) / COORDINATE_SCALE,
      alt: signed(F.alt),
      observedAtMs,
    };
    if (Math.abs(lastKnown.lat) > 90 || Math.abs(lastKnown.lon) > 180)
      throw new ShareWireError('out-of-range', 'thing fix');
  }
  // The camera this view falls back to, whatever happens to the entity.
  const camera = lastKnown
    ? followCameraFor(lastKnown, normalizeFollowOffset(offset))
    : null;
  const present = SHARE_VIEW_ENTITY_KINDS.filter((e) => fields.has(e.code));
  if (present.length > 1)
    throw new ShareWireError('duplicate-field', 'thing entity id');
  const entry = present[0];
  if (!entry) {
    // A newer app's entity kind uses a thing field this decoder skipped.
    const newerKind = unknown.entries.length > unknownBefore;
    return {
      camera,
      fallback: newerKind ? 'unknown-entity-kind' : 'missing-entity-kind',
    };
  }
  const id = decodeEntityId(entry, fields.get(entry.code));
  if (!id) return { camera, fallback: 'invalid-entity-id' };
  return { camera, view: thingView(entry.kind, id, offset, lastKnown) };
}

/**
 * Decode a share code (the `<code>` in `/share/<code>`).
 *
 * Returns `{ ok: true, state, unknownFields?, fallback? }` with a normalized
 * state, or `{ ok: false, reason }`. It never throws. A code whose check byte
 * does not match is rejected (`checksum`), so a mistyped code never opens a
 * different view. `unknownFields` lists what a newer encoder wrote that this
 * decoder skipped; `fallback` says why a view that asked to follow something
 * opens as a place at its camera instead. A created-at time in the future
 * (after `nowMs`) is dropped.
 */
export function decodeShareView(code, { nowMs = Date.now() } = {}) {
  try {
    if (typeof code !== 'string') return { ok: false, reason: 'not-a-string' };
    if (code.length > MAX_SHARE_VIEW_CHARS)
      return { ok: false, reason: 'too-long' };
    const sealed = decodeBase64Url(code);
    if (sealed.length < 2) return { ok: false, reason: 'truncated' };
    const bytes = sealed.subarray(0, sealed.length - 1);
    if (crc8(bytes) !== sealed[sealed.length - 1])
      return { ok: false, reason: 'checksum' };
    if (bytes[0] !== SHARE_VIEW_FORMAT_VERSION)
      return { ok: false, reason: 'unsupported-version' };
    const unknown = new UnknownLog();
    const fields = readMessage(
      new WireReader(bytes, 1),
      TOP_LEVEL_WIRE_TYPES,
      'view',
      unknown,
    );
    const get = (key) => fields.get(fieldNumber(key));

    const raw = {};
    for (const field of SHARE_VIEW_FIELDS) {
      const entry = fields.get(field.number);
      if (
        !entry ||
        field.type === 'bytes' ||
        field.type === 'flags' ||
        field.key === 'view'
      )
        continue;
      if (field.type === 'enum')
        raw[field.key] = readEnum(entry, field, unknown);
      else if (field.type === 'coord')
        raw[field.key] = unz(entry.varint) / COORDINATE_SCALE;
      else if (field.type === 'sint' || field.type === 'angle')
        raw[field.key] = unz(entry.varint);
      else if (field.type === 'uint') raw[field.key] = entry.varint;
    }
    for (const key of ['lat', 'lon']) {
      raw[key] ??= 0;
      if (Math.abs(raw[key]) > (key === 'lat' ? 90 : 180))
        return { ok: false, reason: 'out-of-range' };
    }

    if (raw.style !== undefined && !VIEW_STYLES.includes(raw.style)) {
      if (get('style').len) unknown.code('enum:style', raw.style);
      raw.style = undefined;
    }
    for (const key of ['hudVariant', 'mapStack']) {
      if (raw[key] !== undefined && !NAME_GRAMMAR.test(raw[key]))
        unknown.code(`enum:${key}`, raw[key]);
    }

    const flags = get('flags')?.varint ?? 0;
    for (const flag of SHARE_VIEW_FLAGS)
      raw[flag.key] =
        (Math.floor(flags / 2 ** flag.bit) % 2 === 1) !==
        defaultOf(flag, raw.style ?? 'normal');
    const knownBits = 2 ** SHARE_VIEW_FLAGS.length - 1;
    if (flags > knownBits)
      unknown.code('flags', flags - (flags % (knownBits + 1)));

    let createdAtS = null;
    if (get('sharedAtMs')) {
      createdAtS = SHARE_VIEW_EPOCH_S + unz(get('sharedAtMs').varint);
      const ms = createdAtS * 1000;
      raw.sharedAtMs =
        createdAtS >= 1 && Number.isSafeInteger(ms) && ms <= nowMs ? ms : null;
    }

    if (get('layerState'))
      raw.layerState = decodeLayers(
        get('layerState').len,
        get('layerOptions')?.len ?? null,
        unknown,
      );
    else if (get('layerOptions'))
      unknown.code('layer-option', 'without-layers');
    if (get('panelState'))
      raw.panelState = decodePanels(get('panelState').len, unknown);
    if (get('styleParams'))
      raw.styleParams = decodeStyleParams(
        get('styleParams').len,
        raw.style ?? 'normal',
        unknown,
      );

    let fallback;
    const thing = get('thing')
      ? decodeThing(get('thing').len, createdAtS, unknown)
      : null;
    // A thing with a last-known fix carries the view's camera.
    if (thing?.camera) Object.assign(raw, thing.camera);
    const viewEntry = get('view');
    const viewKind = viewEntry
      ? viewEntry.len
        ? asciiText(viewEntry.len.rest())
        : (SHARE_VIEW_ENUMS.viewKind[viewEntry.varint] ?? viewEntry.varint)
      : thing
        ? 'thing'
        : 'place';
    if (viewKind === 'thing') {
      if (thing?.view) raw.view = thing.view;
      else fallback = thing?.fallback ?? 'missing-thing';
    } else if (viewKind !== 'place') {
      unknown.code('enum:view', viewKind);
      fallback = 'unknown-view-kind';
    }

    const state = normalizeShareViewState(raw);
    const result = { ok: true, state };
    if (unknown.entries.length) result.unknownFields = unknown.entries;
    if (fallback) result.fallback = fallback;
    return result;
  } catch (error) {
    if (error instanceof ShareWireError)
      return { ok: false, reason: error.reason };
    return { ok: false, reason: 'internal-error' };
  }
}
