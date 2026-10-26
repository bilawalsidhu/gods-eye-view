/**
 * Compact share-view codec, format version 1.
 *
 * A shared view travels in the URL hash as `#s=<base64url>`: one version byte
 * followed by protobuf-style tag-length-value fields. Settings equal to their
 * default are omitted, and the decoder fills them back in from the same
 * defaults table the encoder reads. Older decoders skip fields they do not
 * know, so new fields never break old links or old apps.
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
  MAX_ZIGZAG_MAGNITUDE,
  ShareWireError,
  WIRE_LEN,
  WIRE_VARINT,
  WireReader,
  WireWriter,
  asciiText,
  decodeBase64Url,
  asciiBytes,
  encodeBase64Url,
  unzigzag,
  zigzag,
} from './wire.js';

/** First payload byte. Bump only for a change older decoders must refuse. */
export const SHARE_VIEW_FORMAT_VERSION = 1;
/** Hash parameter that carries the payload: `#s=<base64url>`. */
export const SHARE_VIEW_HASH_PARAM = 's';
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

/**
 * Things a view can follow. `code` is permanent; 0 is never assigned. `idForm`
 * picks the compact numeric spelling (a 24-bit ICAO address or a decimal
 * number); any other identifier travels as text. `tracking` names the
 * layer-state slot that holds the same selection in the long form.
 */
export const SHARE_VIEW_ENTITY_KINDS = freezeAll([
  {
    code: 1,
    kind: 'aircraft',
    layerId: 'flights',
    idForm: 'hex24',
    tracking: 'flights',
  },
  {
    code: 2,
    kind: 'military_aircraft',
    layerId: 'military',
    idForm: 'hex24',
    tracking: 'military',
  },
  {
    code: 3,
    kind: 'vessel',
    layerId: 'ais-live-vessels',
    idForm: 'decimal',
    tracking: null,
  },
  {
    code: 4,
    kind: 'satellite',
    layerId: 'satellites',
    idForm: 'decimal',
    tracking: 'satellites',
  },
]);
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
 * Booleans share one varint (field 9). Bit `bit` is set when the value
 * DIFFERS from `default`, so an absent field means "all defaults" and a bit
 * an older decoder does not know is harmless. Bits are permanent.
 */
export const SHARE_VIEW_FLAGS = freezeAll([
  { bit: 0, key: 'bloom', default: false },
  { bit: 1, key: 'sharpen', default: false },
  { bit: 2, key: 'hudVisible', default: false },
  { bit: 3, key: 'celestialRing', default: false },
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
    default: 'tactical',
  },
  { number: 17, key: 'bloomIntensity', type: 'uint', default: 0 },
  { number: 18, key: 'bloomVersion', type: 'uint', default: 2 },
  { number: 19, key: 'sharpenIntensity', type: 'uint', default: 49 },
  {
    number: 20,
    key: 'detectionMode',
    type: 'enum',
    enum: 'detectionMode',
    default: 'OFF',
  },
  { number: 21, key: 'detectionDensity', type: 'uint', default: 50 },
  {
    number: 22,
    key: 'detectionAllocation',
    type: 'enum',
    enum: 'detectionAllocation',
    default: 'ELASTIC',
  },
  { number: 23, key: 'detectionFadePct', type: 'uint', default: 7 },
  { number: 24, key: 'detectionOutsideOpacityPct', type: 'uint', default: 1 },
  { number: 25, key: 'scopeFeatherPct', type: 'uint', default: 100 },
  { number: 26, key: 'scopeTerminusPct', type: 'uint', default: null },
  { number: 27, key: 'styleParams', type: 'bytes', default: null },
]);
const FIELD_BY_KEY = new Map(SHARE_VIEW_FIELDS.map((f) => [f.key, f]));
const fieldNumber = (key) => FIELD_BY_KEY.get(key).number;

/** Fields inside the thing message (top-level field 13). Permanent. */
export const SHARE_VIEW_THING_FIELDS = Object.freeze({
  entityKind: 1, // uint, SHARE_VIEW_ENTITY_KINDS code
  entityId: 2, // uint in the kind's idForm, or LEN text
  offset: 3, // LEN message, SHARE_VIEW_OFFSET_FIELDS
  lastKnown: 4, // LEN message, SHARE_VIEW_LAST_KNOWN_FIELDS
});
/**
 * Camera offset from the followed entity. An absent range is 0; an absent
 * heading or pitch equals the camera's own (fields 5 and 6), which is what a
 * follow view usually has.
 */
export const SHARE_VIEW_OFFSET_FIELDS = Object.freeze({
  range: 1, // uint metres
  heading: 2, // angle
  pitch: 3, // sint whole degrees
});
/** Entity's last-known fix at share time. Absent fields are 0 / unknown. */
export const SHARE_VIEW_LAST_KNOWN_FIELDS = Object.freeze({
  lat: 1, // sint, degrees × 1e4 MINUS the camera's lat field
  lon: 2, // sint, same, against the camera's lon field
  alt: 3, // sint metres
  ageS: 4, // sint, seconds BEFORE the created-at time (field 8)
  observedAt: 5, // epoch, used when the view has no created-at time
});

/** The complete default state: what an empty payload decodes to. */
export function createDefaultShareViewState() {
  const state = { view: { kind: 'place' } };
  for (const field of SHARE_VIEW_FIELDS) {
    if (field.key === 'view' || field.key === 'flags') continue;
    if (field.key === 'thing' || field.key === 'layerOptions') continue;
    state[field.key] = field.default;
  }
  for (const flag of SHARE_VIEW_FLAGS) state[flag.key] = flag.default;
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

function normalizeView(view, camera) {
  if (view?.kind !== 'thing') return { kind: 'place' };
  const entry = ENTITY_BY_KIND.get(view.entity?.kind);
  const id = entry ? normalizeEntityId(entry, view.entity?.id) : null;
  if (!id) return { kind: 'place' };
  const offset =
    view.offset && typeof view.offset === 'object'
      ? {
          range: intOr(view.offset.range, 0, 0, MAX_FOLLOW_RANGE_M),
          heading: wrapAngle(view.offset.heading),
          pitch: intOr(view.offset.pitch, 0, -90, 90),
        }
      : null;
  const lastKnown =
    view.lastKnown && typeof view.lastKnown === 'object'
      ? {
          lat: latitudeOr(view.lastKnown.lat, camera.lat),
          lon: longitudeOr(view.lastKnown.lon, camera.lon),
          alt: intOr(view.lastKnown.alt, 0, -MAX_ALTITUDE_M, MAX_ALTITUDE_M),
          observedAtMs: epochMsOr(view.lastKnown.observedAtMs),
        }
      : null;
  return { kind: 'thing', entity: { kind: entry.kind, id }, offset, lastKnown };
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
    if (id && lifted.kind === 'place')
      lifted = {
        kind: 'thing',
        entity: { kind: entry.kind, id },
        offset: null,
        lastKnown: null,
      };
  }
  return lifted;
}

/**
 * The canonical form of a share-view state. Missing or invalid fields take
 * their defaults, numbers take the format's precision, and a long-form
 * tracking selection becomes a thing view. `decodeShareView` returns this
 * form, and `encodeShareView(state)` decodes back to `normalizeShareViewState(state)`.
 */
export function normalizeShareViewState(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const d = createDefaultShareViewState();
  const state = {};
  state.lat = latitudeOr(source.lat, d.lat);
  state.lon = longitudeOr(source.lon, d.lon);
  state.alt = intOr(source.alt, d.alt, -MAX_ALTITUDE_M, MAX_ALTITUDE_M);
  state.heading = wrapAngle(source.heading, d.heading);
  state.pitch = intOr(source.pitch, d.pitch, -90, 90);
  state.roll = wrapAngle(source.roll, d.roll);
  state.style = VIEW_STYLES.includes(source.style) ? source.style : d.style;
  state.styleParams = normalizeStyleParams(state.style, source.styleParams);
  for (const flag of SHARE_VIEW_FLAGS)
    state[flag.key] =
      typeof source[flag.key] === 'boolean' ? source[flag.key] : flag.default;
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
  let view = normalizeView(source.view, state);
  if (state.layerState) view = liftTrackedEntity(state.layerState, view);
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
  const field = SHARE_VIEW_THING_FIELDS.entityId;
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

function encodeLayers(writer, layerState) {
  const bitset = [];
  for (const id of layerState.enabledLayerIds) {
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
  const blob = new WireWriter();
  for (const spec of SHARE_VIEW_STYLE_PARAMS[style]) {
    if (!Object.hasOwn(values, spec.key)) continue;
    blob
      .varint(charNumber(spec.token))
      .varint(Math.round(values[spec.key] * 100));
  }
  writer.bytesField(fieldNumber('styleParams'), blob.finish());
}

const coordinateInt = (degrees) => Math.round(degrees * COORDINATE_SCALE);
const signedAngle = (degrees) => (degrees > 180 ? degrees - 360 : degrees);
const epochSeconds = (ms) => ms / 1000 - SHARE_VIEW_EPOCH_S;

function encodeThing(writer, view, state) {
  const entry = ENTITY_BY_KIND.get(view.entity.kind);
  const thing = new WireWriter();
  thing.uintField(SHARE_VIEW_THING_FIELDS.entityKind, entry.code);
  writeEntityId(thing, entry, view.entity.id);
  if (view.offset) {
    const offset = new WireWriter();
    const { range, heading, pitch } = view.offset;
    if (range) offset.uintField(SHARE_VIEW_OFFSET_FIELDS.range, range);
    if (heading !== state.heading)
      offset.sintField(SHARE_VIEW_OFFSET_FIELDS.heading, signedAngle(heading));
    if (pitch !== state.pitch)
      offset.sintField(SHARE_VIEW_OFFSET_FIELDS.pitch, pitch);
    thing.bytesField(SHARE_VIEW_THING_FIELDS.offset, offset.finish());
  }
  if (view.lastKnown) {
    const known = new WireWriter();
    const f = SHARE_VIEW_LAST_KNOWN_FIELDS;
    const dLat = coordinateInt(view.lastKnown.lat) - coordinateInt(state.lat);
    const dLon = coordinateInt(view.lastKnown.lon) - coordinateInt(state.lon);
    if (dLat) known.sintField(f.lat, dLat);
    if (dLon) known.sintField(f.lon, dLon);
    if (view.lastKnown.alt) known.sintField(f.alt, view.lastKnown.alt);
    const observed = view.lastKnown.observedAtMs;
    if (observed !== null && state.sharedAtMs !== null)
      known.sintField(f.ageS, (state.sharedAtMs - observed) / 1000);
    else if (observed !== null)
      known.sintField(f.observedAt, epochSeconds(observed));
    thing.bytesField(SHARE_VIEW_THING_FIELDS.lastKnown, known.finish());
  }
  writer.bytesField(fieldNumber('thing'), thing.finish());
}

/**
 * Encode a share-view state as the hash body `s=<base64url>` (no `#`).
 * The state is normalized first; omitted or default fields cost nothing.
 */
export function encodeShareView(input) {
  const state = normalizeShareViewState(input);
  const writer = new WireWriter();
  writer.bytes.push(SHARE_VIEW_FORMAT_VERSION);
  for (const field of SHARE_VIEW_FIELDS) {
    switch (field.key) {
      case 'view':
        if (state.view.kind !== field.default)
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
          if (state[flag.key] !== flag.default) bits += 2 ** flag.bit;
        if (bits) writer.uintField(field.number, bits);
        break;
      }
      case 'layerState':
        if (state.layerState) encodeLayers(writer, state.layerState);
        break;
      case 'layerOptions':
        break; // written together with layerState
      case 'panelState':
        if (state.panelState) encodePanels(writer, state.panelState);
        break;
      case 'thing':
        if (state.view.kind === 'thing') encodeThing(writer, state.view, state);
        break;
      case 'styleParams':
        if (state.styleParams)
          encodeStyleParams(writer, state.style, state.styleParams);
        break;
      default:
        if (state[field.key] === field.default) break;
        if (field.type === 'enum') writeEnum(writer, field, state[field.key]);
        else if (field.type === 'sint')
          writer.sintField(field.number, state[field.key]);
        else writer.uintField(field.number, state[field.key]);
    }
  }
  return `${SHARE_VIEW_HASH_PARAM}=${encodeBase64Url(writer.finish())}`;
}

/* ------------------------------------------------------------------ */
/* Decoder.                                                            */
/* ------------------------------------------------------------------ */

/**
 * The payload text when `hash` is a compact share link (`#s=…`, `s=…`), else
 * null. Use it to choose between this decoder and the long-form parser.
 */
export function shareViewPayload(hash) {
  if (typeof hash !== 'string') return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (
    !body.startsWith(`${SHARE_VIEW_HASH_PARAM}=`) &&
    !body.includes(`&${SHARE_VIEW_HASH_PARAM}=`)
  )
    return null;
  const values = new URLSearchParams(body).getAll(SHARE_VIEW_HASH_PARAM);
  return values.length === 1 ? values[0] : null;
}

/** Whether a URL hash carries a compact share view. */
export function isShareViewHash(hash) {
  return shareViewPayload(hash) !== null;
}

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
const uintOnly = [WIRE_VARINT];
const THING_WIRE_TYPES = new Map([
  [SHARE_VIEW_THING_FIELDS.entityKind, uintOnly],
  [SHARE_VIEW_THING_FIELDS.entityId, [WIRE_VARINT, WIRE_LEN]],
  [SHARE_VIEW_THING_FIELDS.offset, [WIRE_LEN]],
  [SHARE_VIEW_THING_FIELDS.lastKnown, [WIRE_LEN]],
]);
const OFFSET_WIRE_TYPES = new Map(
  Object.values(SHARE_VIEW_OFFSET_FIELDS).map((n) => [n, uintOnly]),
);
const LAST_KNOWN_WIRE_TYPES = new Map(
  Object.values(SHARE_VIEW_LAST_KNOWN_FIELDS).map((n) => [n, uintOnly]),
);

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

function decodeThing(reader, raw, createdAtS, unknown) {
  const fields = readMessage(reader, THING_WIRE_TYPES, 'thing', unknown);
  const F = SHARE_VIEW_THING_FIELDS;
  const kindCode = fields.get(F.entityKind)?.varint;
  const entry = ENTITY_BY_CODE.get(kindCode);
  let offset = null;
  let lastKnown = null;
  if (fields.has(F.offset)) {
    const o = readMessage(
      fields.get(F.offset).len,
      OFFSET_WIRE_TYPES,
      'thing.offset',
      unknown,
    );
    const O = SHARE_VIEW_OFFSET_FIELDS;
    offset = {
      range: o.get(O.range)?.varint ?? 0,
      heading: o.has(O.heading)
        ? unz(o.get(O.heading).varint)
        : (raw.heading ?? FIELD_BY_KEY.get('heading').default),
      pitch: o.has(O.pitch)
        ? unz(o.get(O.pitch).varint)
        : (raw.pitch ?? FIELD_BY_KEY.get('pitch').default),
    };
  }
  if (fields.has(F.lastKnown)) {
    const k = readMessage(
      fields.get(F.lastKnown).len,
      LAST_KNOWN_WIRE_TYPES,
      'thing.lastKnown',
      unknown,
    );
    const K = SHARE_VIEW_LAST_KNOWN_FIELDS;
    const signed = (n) => unz(k.get(n)?.varint ?? 0);
    let observedAtMs = null;
    if (k.has(K.observedAt))
      observedAtMs = (SHARE_VIEW_EPOCH_S + signed(K.observedAt)) * 1000;
    else if (k.has(K.ageS) && createdAtS !== null)
      observedAtMs = (createdAtS - signed(K.ageS)) * 1000;
    lastKnown = {
      lat: (coordinateInt(raw.lat) + signed(K.lat)) / COORDINATE_SCALE,
      lon: (coordinateInt(raw.lon) + signed(K.lon)) / COORDINATE_SCALE,
      alt: signed(K.alt),
      observedAtMs,
    };
  }
  if (!entry) {
    if (kindCode !== undefined) unknown.code('entity-kind', kindCode);
    return {
      fallback:
        kindCode === undefined ? 'missing-entity-kind' : 'unknown-entity-kind',
    };
  }
  const idValue = fields.get(F.entityId);
  const id = idValue ? decodeEntityId(entry, idValue) : null;
  if (!id) return { fallback: 'invalid-entity-id' };
  return {
    view: {
      kind: 'thing',
      entity: { kind: entry.kind, id },
      offset,
      lastKnown,
    },
  };
}

/**
 * Decode a compact share view. Accepts `#s=…`, `s=…` or the bare payload.
 *
 * Returns `{ ok: true, state, unknownFields?, fallback? }` with a normalized
 * state, or `{ ok: false, reason }`. It never throws. `unknownFields` lists
 * what a newer encoder wrote that this decoder skipped; `fallback` says why a
 * view that asked to follow something opens as a place at its stored camera
 * instead. A created-at time in the future (after `nowMs`) is dropped.
 */
export function decodeShareView(input, { nowMs = Date.now() } = {}) {
  try {
    if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' };
    if (input.length > MAX_SHARE_VIEW_CHARS + 3)
      return { ok: false, reason: 'too-long' };
    const payload =
      input.startsWith('#') || input.startsWith(`${SHARE_VIEW_HASH_PARAM}=`)
        ? shareViewPayload(input)
        : input;
    if (payload === null) return { ok: false, reason: 'not-a-share-view' };
    if (payload.length > MAX_SHARE_VIEW_CHARS)
      return { ok: false, reason: 'too-long' };
    const bytes = decodeBase64Url(payload);
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
        (Math.floor(flags / 2 ** flag.bit) % 2 === 1) !== flag.default;
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
    const viewEntry = get('view');
    const viewKind = viewEntry
      ? viewEntry.len
        ? asciiText(viewEntry.len.rest())
        : (SHARE_VIEW_ENUMS.viewKind[viewEntry.varint] ?? viewEntry.varint)
      : 'place';
    const thing = get('thing')
      ? decodeThing(get('thing').len, raw, createdAtS, unknown)
      : null;
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
