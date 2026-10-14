/**
 * Wire format for live remote control.
 *
 * The browser and the Node hub both use this module, so a pushed view is
 * clamped once and applied through the same share-link camera defaults, layer
 * ids, visual styles and map imagery the app already restores. A `link` is
 * that share URL, or its query or hash, read with the share-link parser;
 * camera, layers, annotations and follow in the same view apply on top.
 * It imports no Node, Cesium or DOM APIs. The hub publishes the normalized
 * view, and the browser normalizes that payload again, so every field the
 * link expands into has to survive a second pass.
 */

import {
  REGISTERED_LAYER_IDS,
  decodeLayerStateParams,
} from '../data/layerState.js';
import {
  STYLE_URL_NAMES,
  VIEW_MAPS,
  VIEW_STYLES,
  annotationOf,
  viewFromParams,
} from '../view/index.js';

export const REMOTE_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const LAYER_IDS = new Set(REGISTERED_LAYER_IDS);
const STYLE_BY_URL = Object.freeze(
  Object.fromEntries(
    Object.entries(STYLE_URL_NAMES).map(([name, url]) => [url, name]),
  ),
);
const VIEW_FIELDS = new Set([
  'lat',
  'lon',
  'alt',
  'bbox',
  'heading',
  'pitch',
  'layers',
  'imagery',
  'style',
  'annotations',
  'clearAnnotations',
  'follow',
  'link',
  'linkAnnotations',
]);
const FOLLOW_LAYERS = Object.freeze({
  aircraft: 'flights',
  military_aircraft: 'military',
  satellite: 'satellites',
  vessel: 'ais-live-vessels',
});
const MAX_LINK_CHARS = 12_000;
const FOLLOW_ID = /^[0-9a-z~_-]{1,32}$/;

const MAX_ALTITUDE_M = 20_000_000;
const DEFAULT_ALTITUDE_M = 800;
const DEFAULT_HEADING = 0;
const DEFAULT_PITCH = -35;
const MAX_ANNOTATIONS = 24;
const MAX_LABEL = 120;

const fail = (error) => ({ ok: false, error });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const wrapHeading = (value) => ((value % 360) + 360) % 360;

/**
 * Session name from a push body or a stream query.
 * Missing values use `fallback` (pass `'default'`). `*` is only for a push
 * that should fan out to every connected session.
 */
export function remoteSessionId(
  value,
  { allowStar = false, fallback = null } = {},
) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return null;
  if (allowStar && value === '*') return '*';
  return REMOTE_SESSION_PATTERN.test(value) ? value : null;
}

/** `?remote=<session>` selects the stream. `?remote=off` stays disconnected. */
export function remoteSessionFromSearch(search = '') {
  const raw = String(search || '');
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  if (!params.has('remote')) return { enabled: true, session: 'default' };
  const value = params.get('remote');
  if (value === 'off') return { enabled: false, session: null };
  if (value === '' || value === null)
    return { enabled: true, session: 'default' };
  const session = remoteSessionId(value);
  return session
    ? { enabled: true, session }
    : { enabled: false, session: null };
}

function classifyLook(value, prefer) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw || raw.length > 40) return null;
  const style = STYLE_BY_URL[raw] || (VIEW_STYLES.includes(raw) ? raw : null);
  const imagery = VIEW_MAPS.includes(raw) ? raw : null;
  if (prefer === 'imagery') {
    if (imagery) return { imagery };
    if (style) return { style };
  } else {
    if (style) return { style };
    if (imagery) return { imagery };
  }
  return null;
}

/**
 * Hash or query parameters from a share URL, a `#hash`, a `?query`, or the
 * bare parameter string. A full URL prefers its hash, which is where
 * `show_in_gods_eye_view` writes the view.
 */
export function shareParamsFromLink(link) {
  if (typeof link !== 'string') return null;
  const text = link.trim();
  if (!text || text.length > MAX_LINK_CHARS) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    if (hash) return new URLSearchParams(hash);
    if (url.search) return new URLSearchParams(url.search.slice(1));
    return null;
  }
  const body =
    text.startsWith('#') || text.startsWith('?') ? text.slice(1) : text;
  return body ? new URLSearchParams(body) : null;
}

/**
 * The remote view a share link restores: the same camera, enabled layers,
 * style, map, marks and follow `viewFromParams` reads back. No `l` field
 * leaves layers alone, matching a camera-only link.
 */
function remoteViewFromShareParams(params) {
  const parsed = viewFromParams(params);
  if (!parsed) return fail('link has no camera');
  const view = {
    lat: parsed.camera.lat,
    lon: parsed.camera.lon,
    alt: parsed.camera.altitude_m,
    heading: parsed.camera.heading_deg,
    pitch: parsed.camera.pitch_deg,
  };
  if (decodeLayerStateParams(params)) {
    const enabled = new Set(parsed.layers);
    view.layers = Object.fromEntries(
      [...LAYER_IDS].map((id) => [id, enabled.has(id)]),
    );
  }
  if (parsed.style) view.style = parsed.style;
  if (parsed.map) view.imagery = parsed.map;
  if (parsed.annotations.length) view.linkAnnotations = parsed.annotations;
  if (parsed.follow) {
    const type = parsed.follow.kind;
    const id = String(parsed.follow.id || '');
    if (!FOLLOW_LAYERS[type] || !FOLLOW_ID.test(id))
      return fail('link follow id is invalid');
    view.follow = { type, id };
  }
  return { ok: true, view };
}

function overlayRemoteView(base, explicit) {
  const view = { ...base };
  if (Number.isFinite(explicit.lat)) {
    view.lat = explicit.lat;
    view.lon = explicit.lon;
    view.alt = explicit.alt;
    view.heading = explicit.heading;
    view.pitch = explicit.pitch;
  } else {
    if (Number.isFinite(explicit.alt)) view.alt = explicit.alt;
    if (Number.isFinite(explicit.heading)) view.heading = explicit.heading;
    if (Number.isFinite(explicit.pitch)) view.pitch = explicit.pitch;
  }
  if (Array.isArray(explicit.bbox)) {
    view.bbox = explicit.bbox;
    if (!Number.isFinite(explicit.lat)) {
      if (Number.isFinite(explicit.heading)) view.heading = explicit.heading;
      if (Number.isFinite(explicit.pitch)) view.pitch = explicit.pitch;
    }
  }
  if (explicit.layers)
    view.layers = { ...(view.layers || {}), ...explicit.layers };
  if (explicit.style) view.style = explicit.style;
  if (explicit.imagery) view.imagery = explicit.imagery;
  if (Array.isArray(explicit.linkAnnotations))
    view.linkAnnotations = explicit.linkAnnotations;
  if (explicit.clearAnnotations === true) {
    view.clearAnnotations = true;
    delete view.linkAnnotations;
  }
  if (Array.isArray(explicit.annotations))
    view.annotations = explicit.annotations;
  if (explicit.follow) view.follow = explicit.follow;
  return view;
}

function viewIsActionable(view) {
  return Boolean(
    Number.isFinite(view.lat) ||
    Array.isArray(view.bbox) ||
    (view.layers && Object.keys(view.layers).length > 0) ||
    view.style ||
    view.imagery ||
    (view.annotations && view.annotations.length > 0) ||
    (view.linkAnnotations && view.linkAnnotations.length > 0) ||
    view.clearAnnotations === true ||
    view.follow,
  );
}

/**
 * Clamp one remote view. Ranges fold into bounds; a structurally wrong view
 * is rejected so a typo is not applied as a partial camera move. A link is
 * the base; fields in the same object replace the part of it they name.
 */
export function normalizeRemoteView(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return fail('view must be an object');
  for (const key of Object.keys(input)) {
    if (!VIEW_FIELDS.has(key))
      return fail(`unknown view field: ${String(key).slice(0, 40)}`);
  }

  let base = null;
  if (Object.hasOwn(input, 'link')) {
    const params = shareParamsFromLink(input.link);
    if (!params) return fail('link must be a share URL or its query or hash');
    const shared = remoteViewFromShareParams(params);
    if (!shared.ok) return shared;
    base = shared.view;
  }

  const view = {};
  const hasLat = Object.hasOwn(input, 'lat');
  const hasLon = Object.hasOwn(input, 'lon');
  const hasAlt = Object.hasOwn(input, 'alt');
  const hasHeading = Object.hasOwn(input, 'heading');
  const hasPitch = Object.hasOwn(input, 'pitch');
  const hasBbox = Object.hasOwn(input, 'bbox');

  let heading;
  if (hasHeading) {
    heading = finite(input.heading);
    if (heading === null) return fail('heading must be a finite number');
    heading = wrapHeading(heading);
  }
  let pitch;
  if (hasPitch) {
    pitch = finite(input.pitch);
    if (pitch === null) return fail('pitch must be a finite number');
    pitch = clamp(pitch, -90, 90);
  }

  if (hasLat || hasLon) {
    if (!hasLat || !hasLon) return fail('lat and lon are set together');
    const lat = finite(input.lat);
    const lon = finite(input.lon);
    if (lat === null || lon === null)
      return fail('lat and lon must be finite numbers');
    view.lat = clamp(lat, -90, 90);
    view.lon = clamp(lon, -180, 180);
    if (hasAlt) {
      const alt = finite(input.alt);
      if (alt === null || alt <= 0) return fail('alt must be greater than 0');
      view.alt = Math.min(alt, MAX_ALTITUDE_M);
    } else {
      view.alt = DEFAULT_ALTITUDE_M;
    }
    view.heading = heading ?? DEFAULT_HEADING;
    view.pitch = pitch ?? DEFAULT_PITCH;
  } else if (hasAlt) {
    if (!base) return fail('alt requires lat and lon');
    const alt = finite(input.alt);
    if (alt === null || alt <= 0) return fail('alt must be greater than 0');
    view.alt = Math.min(alt, MAX_ALTITUDE_M);
  } else if ((hasHeading || hasPitch) && !hasBbox && !base) {
    return fail('heading and pitch require a camera');
  }

  if (!hasLat && !hasBbox && base) {
    if (heading !== undefined) view.heading = heading;
    if (pitch !== undefined) view.pitch = pitch;
  }

  if (hasBbox) {
    if (!Array.isArray(input.bbox) || input.bbox.length !== 4)
      return fail('bbox must be [west, south, east, north]');
    const [west, south, east, north] = input.bbox.map(finite);
    if ([west, south, east, north].some((value) => value === null))
      return fail('bbox values must be finite numbers');
    const clampedSouth = clamp(south, -90, 90);
    const clampedNorth = clamp(north, -90, 90);
    view.bbox = [
      clamp(west, -180, 180),
      Math.min(clampedSouth, clampedNorth),
      clamp(east, -180, 180),
      Math.max(clampedSouth, clampedNorth),
    ];
    if (!hasLat) {
      if (heading !== undefined) view.heading = heading;
      if (pitch !== undefined) view.pitch = pitch;
    }
  }

  if (Object.hasOwn(input, 'layers')) {
    const layers = input.layers;
    if (!layers || typeof layers !== 'object' || Array.isArray(layers))
      return fail('layers must be an object');
    const toggles = {};
    for (const [id, enabled] of Object.entries(layers)) {
      if (!LAYER_IDS.has(id)) return fail(`unknown layer: ${id.slice(0, 64)}`);
      if (typeof enabled !== 'boolean')
        return fail(`layer ${id} must be a boolean`);
      toggles[id] = enabled;
    }
    view.layers = toggles;
  }

  if (Object.hasOwn(input, 'style')) {
    const look = classifyLook(input.style, 'style');
    if (!look) return fail('unknown imagery/style');
    Object.assign(view, look);
  }
  if (Object.hasOwn(input, 'imagery')) {
    const look = classifyLook(input.imagery, 'imagery');
    if (!look) return fail('unknown imagery/style');
    Object.assign(view, look);
  }

  if (Object.hasOwn(input, 'annotations')) {
    if (!Array.isArray(input.annotations))
      return fail('annotations must be an array');
    if (input.annotations.length > MAX_ANNOTATIONS)
      return fail('too many annotations');
    const pins = [];
    for (const pin of input.annotations) {
      if (!pin || typeof pin !== 'object' || Array.isArray(pin))
        return fail('annotation must be an object');
      const lat = finite(pin.lat);
      const lon = finite(pin.lon);
      if (lat === null || lon === null)
        return fail('annotation lat and lon must be finite numbers');
      const item = { lat: clamp(lat, -90, 90), lon: clamp(lon, -180, 180) };
      if (Object.hasOwn(pin, 'label')) {
        if (typeof pin.label !== 'string')
          return fail('annotation label must be a string');
        const label = pin.label.trim().slice(0, MAX_LABEL);
        if (label) item.label = label;
      }
      pins.push(item);
    }
    view.annotations = pins;
  }

  if (Object.hasOwn(input, 'linkAnnotations')) {
    if (!Array.isArray(input.linkAnnotations))
      return fail('linkAnnotations must be an array');
    if (input.linkAnnotations.length > MAX_ANNOTATIONS)
      return fail('too many annotations');
    view.linkAnnotations = input.linkAnnotations
      .map(annotationOf)
      .filter(Boolean);
  }

  if (Object.hasOwn(input, 'clearAnnotations')) {
    if (typeof input.clearAnnotations !== 'boolean')
      return fail('clearAnnotations must be a boolean');
    view.clearAnnotations = input.clearAnnotations;
  }

  if (Object.hasOwn(input, 'follow')) {
    const follow = input.follow;
    if (!follow || typeof follow !== 'object' || Array.isArray(follow))
      return fail('follow must be an object');
    if (!FOLLOW_LAYERS[follow.type])
      return fail(
        'follow type must be aircraft, military_aircraft, satellite, or vessel',
      );
    const id =
      typeof follow.id === 'string' ? follow.id.trim().toLowerCase() : '';
    if (!FOLLOW_ID.test(id)) return fail('follow id is invalid');
    view.follow = { type: follow.type, id };
  }

  const merged = overlayRemoteView(base || {}, view);
  if (!viewIsActionable(merged)) return fail('view is empty');
  return { ok: true, view: merged };
}

/** Parse one SSE `data` payload into a normalized view. */
export function parseRemoteEvent(data) {
  let parsed;
  try {
    parsed = JSON.parse(String(data ?? ''));
  } catch {
    return fail('invalid json');
  }
  const view =
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    parsed.view &&
    typeof parsed.view === 'object'
      ? parsed.view
      : parsed;
  return normalizeRemoteView(view);
}

/**
 * Steps that apply a normalized view through the app's own camera, layer,
 * style, imagery, annotation and follow actions. A bbox frames the camera
 * ahead of a lat/lon in the same view. Follow runs last so the flight does
 * not cancel tracking.
 */
export function planRemoteApply(view) {
  const camera = Array.isArray(view?.bbox)
    ? {
        kind: 'bbox',
        bbox: view.bbox,
        ...(Number.isFinite(view.heading) ? { heading: view.heading } : {}),
        ...(Number.isFinite(view.pitch) ? { pitch: view.pitch } : {}),
      }
    : Number.isFinite(view?.lat) && Number.isFinite(view?.lon)
      ? {
          kind: 'point',
          lat: view.lat,
          lon: view.lon,
          alt: view.alt,
          heading: view.heading,
          pitch: view.pitch,
        }
      : null;
  return {
    camera,
    layers: Object.entries(view?.layers || {}).map(([id, enabled]) => ({
      id,
      enabled,
    })),
    style: view?.style ?? null,
    imagery: view?.imagery ?? null,
    clearAnnotations: view?.clearAnnotations === true,
    annotations: [
      ...(view?.linkAnnotations || []),
      ...(view?.annotations || []).map((pin) => ({
        type: 'pin',
        latitude: pin.lat,
        longitude: pin.lon,
        ...(pin.label ? { label: pin.label } : {}),
      })),
    ].slice(-MAX_ANNOTATIONS),
    follow: view?.follow
      ? {
          type: view.follow.type,
          id: view.follow.id,
          layerId: FOLLOW_LAYERS[view.follow.type],
        }
      : null,
  };
}

/** Run a plan. Each action is the app's existing one; a failed step continues. */
export async function applyRemotePlan(view, actions = {}) {
  const plan = planRemoteApply(view);
  const steps = [];
  const step = async (name, fn) => {
    if (typeof fn !== 'function') return;
    try {
      const result = await fn();
      steps.push({
        step: name,
        ok: result?.ok !== false,
        ...(result?.error ? { error: result.error } : {}),
      });
    } catch (error) {
      steps.push({
        step: name,
        ok: false,
        error: error?.message || String(error),
      });
    }
  };
  if (plan.style) await step('style', () => actions.setStyle(plan.style));
  if (plan.imagery)
    await step('imagery', () => actions.setImagery(plan.imagery));
  for (const layer of plan.layers)
    await step('layer', () => actions.setLayer(layer.id, layer.enabled));
  if (plan.clearAnnotations)
    await step('clear', () => actions.clearAnnotations());
  if (plan.annotations.length)
    await step('annotations', () => actions.addAnnotations(plan.annotations));
  if (plan.camera) await step('camera', () => actions.flyTo(plan.camera));
  if (plan.follow) {
    if (typeof actions.setLayer === 'function')
      await step('layer', () => actions.setLayer(plan.follow.layerId, true));
    await step('follow', () => actions.follow(plan.follow));
  }
  return {
    style: plan.style,
    imagery: plan.imagery,
    layers: plan.layers,
    cleared: plan.clearAnnotations,
    annotations: plan.annotations,
    camera: plan.camera?.kind ?? null,
    follow: plan.follow ? { type: plan.follow.type, id: plan.follow.id } : null,
    steps,
  };
}
