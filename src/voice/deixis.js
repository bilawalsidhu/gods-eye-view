/**
 * Resolve deictic tool arguments before an action runs.
 *
 * The model never copies coordinates or ids for "this", "here" or "the second
 * one". It passes a sentinel and the runner fills in the real target:
 *
 *   track_entity      {query:'pointer'} | {referent:n}
 *   fly_to_location   {query:'pointer'} | {referent:n}
 *   get_entity_context {scope:'pointer'} | {referent:n}
 *   analyst_query     {scope:{kind:'pointer', km?}}
 *   annotate_map      annotations[].target / toTarget / points[].target = 'pointer'
 *
 * The pointer is the current turn's snapshot (see pointerContext.js); the
 * referents are the latest result's numbered list (see referents.js).
 * Resolution is pure: it returns rewritten arguments, what they resolved
 * from, or a plain error the model can say.
 */

import { finiteOrNull } from './pointerContext.js';

export const POINTER_SENTINEL = 'pointer';

const TRACKABLE_LAYERS = new Set([
  'flights',
  'military',
  'ais-live-vessels',
  'satellites',
]);

const DEFAULT_POINTER_RADIUS_KM = 50;

const NO_POINTER =
  'Nothing is under the pointer. Ask the user to point at it or name it.';

function isPointer(value) {
  return (
    typeof value === 'string' && value.trim().toLowerCase() === POINTER_SENTINEL
  );
}

function hasPosition(target) {
  return (
    finiteOrNull(target?.lat) !== null && finiteOrNull(target?.lon) !== null
  );
}

function referentIndex(args) {
  if (args?.referent === undefined || args?.referent === null) return null;
  const n = Number(args.referent);
  return Number.isInteger(n) ? n : NaN;
}

function withoutKeys(args, keys) {
  const out = { ...args };
  for (const key of keys) delete out[key];
  return out;
}

/** The pointer as a target record, or null. */
function pointerTarget(pointer) {
  if (!pointer?.fresh) return null;
  if (pointer.entity) {
    return {
      ...pointer.entity,
      lat: pointer.lat,
      lon: pointer.lon,
    };
  }
  if (hasPosition(pointer))
    return { lat: pointer.lat, lon: pointer.lon, label: null };
  return null;
}

function lookupReferent(referents, n) {
  if (Number.isNaN(n)) return { error: 'referent must be a whole number.' };
  const ref = referents?.get?.(n) || null;
  if (!ref)
    return {
      error: `There is no item ${n} in the last list.`,
    };
  return { ref };
}

function resolveTrack(args, { pointer, referents }) {
  const n = referentIndex(args);
  let target = null;
  let source = null;
  if (n !== null) {
    const { ref, error } = lookupReferent(referents, n);
    if (error) return { error };
    target = ref;
    source = 'referent';
  } else if (isPointer(args.query)) {
    target = pointerTarget(pointer);
    if (!target) return { error: NO_POINTER };
    if (!target.layerId)
      return {
        error:
          'The pointer is on the ground, not on an aircraft, ship or satellite.',
      };
    source = 'pointer';
  } else {
    return null;
  }
  if (!TRACKABLE_LAYERS.has(target.layerId))
    return {
      error: `${target.label || 'That'} cannot be followed; only aircraft, ships and satellites can.`,
    };
  return {
    args: {
      ...withoutKeys(args, ['referent']),
      query: String(target.id || target.label),
      layerId: target.layerId,
    },
    used: { source, label: target.label || null, layerId: target.layerId },
  };
}

function resolveFly(args, { pointer, referents }) {
  const n = referentIndex(args);
  let target = null;
  let source = null;
  if (n !== null) {
    const { ref, error } = lookupReferent(referents, n);
    if (error) return { error };
    target = ref;
    source = 'referent';
  } else if (isPointer(args.query)) {
    target = pointerTarget(pointer);
    if (!target) return { error: NO_POINTER };
    source = 'pointer';
  } else {
    return null;
  }
  const rest = withoutKeys(args, ['referent', 'query', 'locationId']);
  const used = { source, label: target.label || null };
  if (target.layerId && target.id && source === 'referent') {
    // Contacts move: locate them when the flight starts, not from a list.
    return {
      args: { ...rest, entity: { layerId: target.layerId, id: target.id } },
      used,
    };
  }
  if (hasPosition(target))
    return {
      args: { ...rest, latitude: target.lat, longitude: target.lon },
      used,
    };
  if (target.label) return { args: { ...rest, query: target.label }, used };
  return { error: 'That item has no position to fly to.' };
}

function resolveContext(args, { pointer, referents }) {
  const n = referentIndex(args);
  if (n !== null) {
    const { ref, error } = lookupReferent(referents, n);
    if (error) return { error };
    return {
      args: {
        ...withoutKeys(args, ['referent']),
        scope: 'target',
        target: ref,
      },
      used: { source: 'referent', label: ref.label || null },
    };
  }
  if (String(args.scope || '').toLowerCase() !== POINTER_SENTINEL) return null;
  const target = pointerTarget(pointer);
  if (!target) {
    // A read-only lookup falls back to the usual scope instead of failing.
    return {
      args: { ...args, scope: 'auto' },
      used: { source: 'pointer', label: null, missing: true },
    };
  }
  return {
    args: { ...args, scope: 'target', target },
    used: {
      source: 'pointer',
      label: target.label || null,
    },
  };
}

function resolveAnalyst(args, { pointer }) {
  const scope = args.scope;
  if (!scope || String(scope.kind || '').toLowerCase() !== POINTER_SENTINEL)
    return null;
  const target = pointerTarget(pointer);
  if (!target || !hasPosition(target)) return { error: NO_POINTER };
  const asked = finiteOrNull(scope.km);
  const km =
    asked > 0
      ? asked
      : finiteOrNull(pointer.radiusKm) > 0
        ? pointer.radiusKm
        : DEFAULT_POINTER_RADIUS_KM;
  const nextScope = withoutKeys(scope, ['name']);
  return {
    args: {
      ...args,
      scope: {
        ...nextScope,
        kind: 'radius',
        center: { lat: target.lat, lon: target.lon },
        km,
      },
    },
    used: { source: 'pointer', label: target.label || null, km },
  };
}

function resolveAnnotate(args, { pointer }) {
  const list = Array.isArray(args.annotations) ? args.annotations : null;
  if (!list) return null;
  const mentions = list.some(
    (spec) =>
      isPointer(spec?.target) ||
      isPointer(spec?.toTarget) ||
      (Array.isArray(spec?.points) &&
        spec.points.some((point) => isPointer(point?.target))),
  );
  if (!mentions) return null;
  const target = pointerTarget(pointer);
  if (!target || !hasPosition(target)) return { error: NO_POINTER };
  const annotations = list.map((spec) => {
    if (!spec || typeof spec !== 'object') return spec;
    let next = spec;
    if (isPointer(spec.target)) {
      next = withoutKeys(next, ['target']);
      next.latitude = target.lat;
      next.longitude = target.lon;
      if (!next.label && target.label) next.label = target.label;
    }
    if (isPointer(spec.toTarget)) {
      next = withoutKeys(next, ['toTarget']);
      next.toLatitude = target.lat;
      next.toLongitude = target.lon;
    }
    if (Array.isArray(spec.points)) {
      next = {
        ...next,
        points: spec.points.map((point) =>
          isPointer(point?.target)
            ? {
                ...withoutKeys(point, ['target']),
                latitude: target.lat,
                longitude: target.lon,
              }
            : point,
        ),
      };
    }
    return next;
  });
  return {
    args: { ...args, annotations },
    used: { source: 'pointer', label: target.label || null },
  };
}

const SCREEN_PAIRS = [
  ['screenX', 'screenY'],
  ['toScreenX', 'toScreenY'],
];

function hasScreenPoint(spec) {
  return (
    SCREEN_PAIRS.some(
      ([x, y]) => spec?.[x] !== undefined || spec?.[y] !== undefined,
    ) ||
    (Array.isArray(spec?.points) &&
      spec.points.some(
        (point) => point?.screenX !== undefined || point?.screenY !== undefined,
      ))
  );
}

/**
 * screenX/screenY are normalized against the latest image the model saw, but
 * the annotation resolver reads them against the full canvas. When that image
 * is the pointer crop, map crop coordinates back to the canvas; when the
 * camera moved since, no pixel names anything any more.
 */
function resolveCropPixels(args, { imageFrame, cameraKey }) {
  const list = Array.isArray(args.annotations) ? args.annotations : null;
  if (!list || imageFrame?.kind !== 'crop' || !list.some(hasScreenPoint))
    return null;
  const rect = imageFrame.rect;
  if (
    !rect ||
    (imageFrame.cameraKey && cameraKey && imageFrame.cameraKey !== cameraKey)
  )
    return {
      error:
        'The view has moved since that image, so its pixels no longer match. Name the place or point at it.',
    };
  const map = (value, origin, span) => {
    const n = finiteOrNull(value);
    return n === null ? value : origin + Math.min(1, Math.max(0, n)) * span;
  };
  const remap = (spec) => {
    const next = { ...spec };
    for (const [xKey, yKey] of SCREEN_PAIRS) {
      if (xKey in next) next[xKey] = map(next[xKey], rect.x, rect.w);
      if (yKey in next) next[yKey] = map(next[yKey], rect.y, rect.h);
    }
    return next;
  };
  return {
    args: {
      ...args,
      annotations: list.map((spec) => {
        if (!spec || typeof spec !== 'object') return spec;
        const next = remap(spec);
        if (Array.isArray(spec.points)) next.points = spec.points.map(remap);
        return next;
      }),
    },
  };
}

const RESOLVERS = Object.freeze({
  track_entity: resolveTrack,
  fly_to_location: resolveFly,
  get_entity_context: resolveContext,
  analyst_query: resolveAnalyst,
  annotate_map: resolveAnnotate,
});

/**
 * @param {string} name Tool name.
 * @param {object} args Model arguments.
 * @param {object} context
 * @param {object|null} [context.pointer] Current turn's pointer snapshot.
 * @param {{get: Function}|null} [context.referents] Referent registry.
 * @param {object|null} [context.imageFrame] What the retained image shows.
 * @param {string|null} [context.cameraKey] Current camera pose identity.
 * @returns {{args: object, used: object|null, error: string|null}}
 */
export function resolveDeicticArgs(
  name,
  args,
  {
    pointer = null,
    referents = null,
    imageFrame = null,
    cameraKey = null,
  } = {},
) {
  let input = args && typeof args === 'object' ? args : {};
  if (name === 'annotate_map') {
    const pixels = resolveCropPixels(input, { imageFrame, cameraKey });
    if (pixels?.error) return { args: input, used: null, error: pixels.error };
    if (pixels) input = pixels.args;
  }
  const resolver = RESOLVERS[name];
  if (!resolver) return { args: input, used: null, error: null };
  const resolved = resolver(input, { pointer, referents });
  if (!resolved) return { args: input, used: null, error: null };
  if (resolved.error) return { args: input, used: null, error: resolved.error };
  return { args: resolved.args, used: resolved.used || null, error: null };
}
