/**
 * Portable alert-rule engine. No Node, browser, Cesium or clock globals:
 * time always comes from the observation or from the `now` passed to tick().
 *
 * Inputs
 *   watchlists: [{ id, name, entries: [{ domain: 'air'|'sea'|'space',
 *                  id?: string, label?: string /* prefix, case-insensitive *\/ }] }]
 *   fences:     [{ id, name, shape: { type: 'polygon', coords: [[lon,lat],...] }
 *                                 | { type: 'circle', center: [lon,lat], radiusM } }]
 *   rules:      [{ id, name, enabled, kind, severity, scope, params }]
 *     scope:  { watchlistId?: string, domain?: 'air'|'sea' }
 *     kinds and params:
 *       fence-enter  { fenceId }
 *       fence-exit   { fenceId }
 *       fence-dwell  { fenceId, minutes }
 *       squawk       { codes?: string[] }            default 7500/7600/7700
 *       dark         { minutes }                     watchlist scope required
 *       appear       { gapMinutes }                  watchlist scope required
 *       speed        { min?, max? }                  feed units (air m/s, sea kn)
 *       altitude     { min?, max? }                  metres, air only
 *       loiter       { radiusM, minutes }            air only
 *       overhead     { fenceId, minElevDeg, leadMinutes } watched satellites
 *                    passing over a fence centre; evaluated by the server
 *                    pass planner, ignored by this engine
 *   rules may also list `channels: [channelId]` for webhook delivery
 *
 * Output events: { ruleId, kind, severity, domain, id, label, t, lat, lon,
 *                  title, detail }
 */

export const RULE_KINDS = Object.freeze([
  'fence-enter',
  'fence-exit',
  'fence-dwell',
  'squawk',
  'dark',
  'appear',
  'speed',
  'altitude',
  'loiter',
  'overhead',
]);
export const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);
export const EMERGENCY_SQUAWKS = Object.freeze({
  7500: 'unlawful interference',
  7600: 'radio failure',
  7700: 'general emergency',
});

const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const MAX_POLYGON_POINTS = 2000;
const MAX_WATCH_ENTRIES = 5000;

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Ray-casting point-in-polygon on lon/lat (fine for fences under ~1000 km). */
export function pointInPolygon(lon, lat, coords) {
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [xi, yi] = coords[i];
    const [xj, yj] = coords[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export function inFence(fence, lat, lon) {
  const s = fence?.shape;
  if (s?.type === 'circle')
    return distanceM(lat, lon, s.center[1], s.center[0]) <= s.radiusM;
  if (s?.type === 'polygon') return pointInPolygon(lon, lat, s.coords);
  return false;
}

/** Bounding box of a fence for cheap pre-filtering. */
export function fenceBounds(fence) {
  const s = fence.shape;
  if (s.type === 'circle') {
    const dLat = s.radiusM / 111_320;
    const dLon = s.radiusM / (111_320 * Math.max(0.01, Math.cos(rad(s.center[1]))));
    return {
      minLat: s.center[1] - dLat,
      maxLat: s.center[1] + dLat,
      minLon: s.center[0] - dLon,
      maxLon: s.center[0] + dLon,
    };
  }
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lon, lat] of s.coords) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

/** Center point of a fence ([lon, lat]). */
export function fenceCenter(fence) {
  const s = fence.shape;
  if (s.type === 'circle') return s.center;
  const b = fenceBounds(fence);
  return [(b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2];
}

// ---------------------------------------------------------------- validation

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function fail(msg) {
  const e = new Error(msg);
  e.code = 'BAD_REQUEST';
  throw e;
}

export function validateWatchlist(input) {
  const name = str(input?.name) || fail('watchlist needs a name');
  const raw = Array.isArray(input?.entries) ? input.entries : fail('entries must be an array');
  if (raw.length > MAX_WATCH_ENTRIES) fail(`at most ${MAX_WATCH_ENTRIES} entries`);
  const entries = raw.map((e) => {
    const domain = ['air', 'sea', 'space'].includes(e?.domain) ? e.domain : fail('entry domain must be air, sea or space');
    const id = str(e?.id, 16).toLowerCase();
    const label = str(e?.label, 16).toUpperCase();
    if (!id && !label) fail('entry needs an id or a label prefix');
    if (id && domain === 'air' && !/^[0-9a-f]{6}$/.test(id)) fail('air id must be a 6-digit ICAO hex');
    if (id && domain === 'sea' && !/^\d{9}$/.test(id)) fail('sea id must be a 9-digit MMSI');
    if (id && domain === 'space' && !/^\d{1,9}$/.test(id)) fail('space id must be a NORAD catalog number');
    if (label && !/^[A-Z0-9 \-]{2,16}$/.test(label)) fail('label prefix must be 2-16 letters or digits');
    if (domain === 'space' && !id) fail('space entries need a NORAD id');
    return { domain, ...(id ? { id } : {}), ...(label ? { label } : {}), note: str(e?.note, 80) || undefined };
  });
  return { name, entries };
}

export function validateFence(input) {
  const name = str(input?.name) || fail('fence needs a name');
  const s = input?.shape;
  if (s?.type === 'circle') {
    const [lon, lat] = Array.isArray(s.center) ? s.center : [];
    if (!fin(lon) || !fin(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) fail('circle center must be [lon, lat]');
    if (!fin(s.radiusM) || s.radiusM < 50 || s.radiusM > 500_000) fail('radius must be 50 m to 500 km');
    return { name, shape: { type: 'circle', center: [lon, lat], radiusM: s.radiusM } };
  }
  if (s?.type === 'polygon') {
    const coords = Array.isArray(s.coords) ? s.coords : fail('polygon coords required');
    if (coords.length < 3 || coords.length > MAX_POLYGON_POINTS) fail('polygon needs 3 to 2000 points');
    for (const p of coords)
      if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1]) || Math.abs(p[1]) > 90 || Math.abs(p[0]) > 180)
        fail('polygon points must be [lon, lat]');
    const clean = coords.map(([lon, lat]) => [lon, lat]);
    const b = fenceBounds({ shape: { type: 'polygon', coords: clean } });
    if (b.maxLon - b.minLon > 180) fail('polygons may not cross the antimeridian');
    return { name, shape: { type: 'polygon', coords: clean } };
  }
  return fail('shape type must be circle or polygon');
}

export function validateRule(input, { fences = [], watchlists = [], channels = [] } = {}) {
  const name = str(input?.name) || fail('rule needs a name');
  const kind = RULE_KINDS.includes(input?.kind) ? input.kind : fail(`kind must be one of ${RULE_KINDS.join(', ')}`);
  const severity = SEVERITIES.includes(input?.severity) ? input.severity : 'info';
  const scopeIn = input?.scope || {};
  const scope = {};
  if (scopeIn.watchlistId) {
    if (!watchlists.some((w) => w.id === scopeIn.watchlistId)) fail('unknown watchlist');
    scope.watchlistId = String(scopeIn.watchlistId);
  }
  if (scopeIn.domain) {
    if (!['air', 'sea'].includes(scopeIn.domain)) fail('scope domain must be air or sea');
    scope.domain = scopeIn.domain;
  }
  const p = input?.params || {};
  const params = {};
  const needFence = () => {
    if (!fences.some((f) => f.id === p.fenceId)) fail('unknown fence');
    params.fenceId = String(p.fenceId);
  };
  const minutes = (key, lo, hi) => {
    if (!fin(p[key]) || p[key] < lo || p[key] > hi) fail(`${key} must be ${lo} to ${hi}`);
    params[key] = p[key];
  };
  switch (kind) {
    case 'fence-enter':
    case 'fence-exit':
      needFence();
      break;
    case 'fence-dwell':
      needFence();
      minutes('minutes', 1, 1440);
      break;
    case 'squawk': {
      const codes = Array.isArray(p.codes) && p.codes.length ? p.codes.map(String) : Object.keys(EMERGENCY_SQUAWKS);
      if (!codes.every((c) => /^[0-7]{4}$/.test(c))) fail('squawk codes must be 4 octal digits');
      params.codes = codes.slice(0, 32);
      if (!scope.domain) scope.domain = 'air';
      break;
    }
    case 'dark':
      if (!scope.watchlistId) fail('dark rules need a watchlist scope');
      minutes('minutes', 5, 10080);
      break;
    case 'appear':
      if (!scope.watchlistId) fail('appear rules need a watchlist scope');
      minutes('gapMinutes', 5, 10080);
      break;
    case 'speed':
    case 'altitude':
      if (p.min !== undefined && !fin(p.min)) fail('min must be a number');
      if (p.max !== undefined && !fin(p.max)) fail('max must be a number');
      if (p.min === undefined && p.max === undefined) fail('set min, max or both');
      if (p.min !== undefined) params.min = p.min;
      if (p.max !== undefined) params.max = p.max;
      if (kind === 'altitude') scope.domain = 'air';
      break;
    case 'loiter':
      if (!fin(p.radiusM) || p.radiusM < 500 || p.radiusM > 50_000) fail('radiusM must be 500 to 50000');
      params.radiusM = p.radiusM;
      minutes('minutes', 5, 240);
      scope.domain = 'air';
      break;
    case 'overhead':
      needFence();
      if (!scope.watchlistId) fail('overhead rules need a watchlist with satellites');
      if (scope.domain) fail('overhead rules apply to satellites only');
      params.minElevDeg = fin(p.minElevDeg) && p.minElevDeg >= 0 && p.minElevDeg <= 80 ? p.minElevDeg : 20;
      params.leadMinutes = fin(p.leadMinutes) && p.leadMinutes >= 1 && p.leadMinutes <= 180 ? p.leadMinutes : 10;
      break;
  }
  const channelIn = Array.isArray(input?.channels) ? input.channels : [];
  if (channelIn.length > 5) fail('at most 5 channels per rule');
  for (const c of channelIn) if (!channels.some((x) => x.id === c)) fail('unknown channel');
  return {
    name,
    kind,
    severity,
    enabled: input?.enabled !== false,
    scope,
    params,
    channels: channelIn.map(String),
  };
}

// ---------------------------------------------------------------- engine

function compileWatchlist(w) {
  const ids = new Set();
  const labels = [];
  for (const e of w.entries || []) {
    if (e.id) ids.add(`${e.domain}:${e.id}`);
    if (e.label) labels.push({ domain: e.domain, prefix: e.label });
  }
  return {
    has(obs) {
      if (ids.has(`${obs.domain}:${obs.id}`)) return true;
      if (!labels.length || !obs.label) return false;
      const l = String(obs.label).toUpperCase();
      return labels.some((x) => x.domain === obs.domain && l.startsWith(x.prefix));
    },
    idKeys: [...ids],
  };
}

const describe = (obs) => obs.label || obs.id;

/**
 * Build an engine for one owner's configuration.
 * @param {{watchlists?: object[], fences?: object[], rules?: object[]}} config
 * @param {{cooldownMs?: number}} [options]
 */
export function createRuleEngine(config, { cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const watchlists = new Map((config.watchlists || []).map((w) => [w.id, compileWatchlist(w)]));
  const fences = new Map((config.fences || []).map((f) => [f.id, { ...f, bounds: fenceBounds(f) }]));
  const rules = (config.rules || []).filter((r) => r.enabled !== false);
  /** per rule+asset state */
  const state = new Map();
  /** per asset last observation (for dark/appear) */
  const lastSeen = new Map();

  const get = (rule, obs) => {
    const key = `${rule.id}|${obs.domain}:${obs.id}`;
    let s = state.get(key);
    if (!s) {
      s = { inside: null, enteredAt: null, dwellFired: false, lastFiredAt: -Infinity, recent: [] };
      state.set(key, s);
    }
    return s;
  };

  function inScope(rule, obs) {
    if (rule.scope?.domain && rule.scope.domain !== obs.domain) return false;
    if (rule.scope?.watchlistId) {
      const w = watchlists.get(rule.scope.watchlistId);
      if (!w || !w.has(obs)) return false;
    }
    return true;
  }

  function event(rule, obs, title, detail = {}) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      kind: rule.kind,
      severity: rule.severity || 'info',
      domain: obs.domain,
      id: obs.id,
      label: obs.label ?? null,
      t: obs.t,
      lat: obs.lat,
      lon: obs.lon,
      title,
      detail,
    };
  }

  function cooled(s, t) {
    if (t - s.lastFiredAt < cooldownMs) return false;
    s.lastFiredAt = t;
    return true;
  }

  function fenceRule(rule, obs, out) {
    const fence = fences.get(rule.params.fenceId);
    if (!fence) return;
    const b = fence.bounds;
    const s = get(rule, obs);
    const inside =
      obs.lat >= b.minLat && obs.lat <= b.maxLat && obs.lon >= b.minLon && obs.lon <= b.maxLon
        ? inFence(fence, obs.lat, obs.lon)
        : false;
    const was = s.inside;
    s.inside = inside;
    if (inside && was !== true) {
      s.enteredAt = obs.t;
      s.dwellFired = false;
    }
    if (!inside) s.enteredAt = null;
    // First sighting establishes state without firing: an asset already in
    // a fence when a rule is created should not alert as an "entry".
    if (was === null) return;
    if (rule.kind === 'fence-enter' && inside && !was)
      out.push(event(rule, obs, `${describe(obs)} entered ${fence.name}`, { fence: fence.name }));
    if (rule.kind === 'fence-exit' && !inside && was)
      out.push(event(rule, obs, `${describe(obs)} left ${fence.name}`, { fence: fence.name }));
    if (
      rule.kind === 'fence-dwell' &&
      inside &&
      !s.dwellFired &&
      s.enteredAt !== null &&
      obs.t - s.enteredAt >= rule.params.minutes * 60_000
    ) {
      s.dwellFired = true;
      out.push(
        event(rule, obs, `${describe(obs)} has been in ${fence.name} for ${rule.params.minutes} min`, {
          fence: fence.name,
          since: s.enteredAt,
        }),
      );
    }
  }

  /**
   * Evaluate one observation.
   * @returns {object[]} Events.
   */
  function evaluate(obs) {
    const out = [];
    const key = `${obs.domain}:${obs.id}`;
    const prev = lastSeen.get(key);
    for (const rule of rules) {
      if (!inScope(rule, obs)) continue;
      switch (rule.kind) {
        case 'fence-enter':
        case 'fence-exit':
        case 'fence-dwell':
          fenceRule(rule, obs, out);
          break;
        case 'squawk': {
          if (obs.domain !== 'air' || !obs.squawk || !rule.params.codes.includes(obs.squawk)) {
            get(rule, obs).activeCode = null;
            break;
          }
          const s = get(rule, obs);
          if (s.activeCode === obs.squawk) break;
          s.activeCode = obs.squawk;
          const meaning = EMERGENCY_SQUAWKS[obs.squawk];
          out.push(
            event(rule, obs, `${describe(obs)} squawking ${obs.squawk}${meaning ? ` (${meaning})` : ''}`, {
              squawk: obs.squawk,
            }),
          );
          break;
        }
        case 'appear': {
          const s = get(rule, obs);
          const gap = rule.params.gapMinutes * 60_000;
          const prior = prev?.t ?? s.lastObsT;
          s.lastObsT = obs.t;
          if (prior !== undefined && obs.t - prior >= gap && cooled(s, obs.t))
            out.push(event(rule, obs, `${describe(obs)} reappeared after ${Math.round((obs.t - prior) / 60_000)} min`, { gapMs: obs.t - prior }));
          break;
        }
        case 'dark':
          get(rule, obs).darkFired = false;
          break;
        case 'speed':
        case 'altitude': {
          const v = rule.kind === 'speed' ? obs.speed : obs.alt;
          if (typeof v !== 'number' || !Number.isFinite(v)) break;
          const s = get(rule, obs);
          const outOfBand =
            (rule.params.min !== undefined && v < rule.params.min) ||
            (rule.params.max !== undefined && v > rule.params.max);
          if (outOfBand && !s.outOfBand && cooled(s, obs.t)) {
            const unit = rule.kind === 'altitude' ? 'm' : obs.domain === 'air' ? 'm/s' : 'kn';
            out.push(event(rule, obs, `${describe(obs)} ${rule.kind} ${Math.round(v)} ${unit} outside band`, { value: v }));
          }
          s.outOfBand = outOfBand;
          break;
        }
        case 'loiter': {
          if (obs.onGround) break;
          const s = get(rule, obs);
          const windowMs = rule.params.minutes * 60_000;
          s.recent.push([obs.t, obs.lat, obs.lon]);
          while (s.recent.length && obs.t - s.recent[0][0] > windowMs) s.recent.shift();
          if (s.recent.length > 240) s.recent.splice(0, s.recent.length - 240);
          const span = s.recent.length ? obs.t - s.recent[0][0] : 0;
          if (span < windowMs * 0.9 || s.recent.length < 5) break;
          let cLat = 0, cLon = 0;
          for (const [, la, lo] of s.recent) {
            cLat += la;
            cLon += lo;
          }
          cLat /= s.recent.length;
          cLon /= s.recent.length;
          let maxD = 0;
          let path = 0;
          for (let i = 0; i < s.recent.length; i++) {
            const [, la, lo] = s.recent[i];
            maxD = Math.max(maxD, distanceM(cLat, cLon, la, lo));
            if (i) path += distanceM(s.recent[i - 1][1], s.recent[i - 1][2], la, lo);
          }
          // Circling, not parked: stayed inside the radius but kept moving.
          if (maxD <= rule.params.radiusM && path >= 4 * rule.params.radiusM && cooled(s, obs.t))
            out.push(
              event(rule, obs, `${describe(obs)} circling within ${(rule.params.radiusM / 1000).toFixed(1)} km for ${rule.params.minutes} min`, {
                center: [cLon, cLat],
              }),
            );
          break;
        }
      }
    }
    lastSeen.set(key, { t: obs.t, lat: obs.lat, lon: obs.lon, label: obs.label, domain: obs.domain, id: obs.id });
    return out;
  }

  /**
   * Time-driven checks (assets that went dark). Call periodically.
   * @param {number} now Epoch ms.
   * @returns {object[]} Events.
   */
  function tick(now) {
    const out = [];
    for (const rule of rules) {
      if (rule.kind !== 'dark') continue;
      for (const [, seen] of lastSeen) {
        if (!inScope(rule, seen)) continue;
        const s = get(rule, seen);
        if (s.darkFired) continue;
        const gap = now - seen.t;
        if (gap >= rule.params.minutes * 60_000) {
          s.darkFired = true;
          out.push({
            ...event(rule, seen, `${describe(seen)} has not reported for ${Math.round(gap / 60_000)} min`, { lastSeen: seen.t }),
            t: now,
          });
        }
      }
    }
    return out;
  }

  /** Drop per-asset state not touched since `before` (memory bound). */
  function evict(before) {
    for (const [key, seen] of lastSeen) if (seen.t < before) lastSeen.delete(key);
    for (const [key, s] of state) {
      const assetKey = key.slice(key.indexOf('|') + 1);
      if (!lastSeen.has(assetKey) && !s.inside) state.delete(key);
    }
  }

  return {
    evaluate,
    tick,
    evict,
    /** Seed last-seen times (e.g. from the history store on startup). */
    seen(obs) {
      lastSeen.set(`${obs.domain}:${obs.id}`, { ...obs });
    },
    watchedIdKeys: () => [...watchlists.values()].flatMap((w) => w.idKeys),
    size: () => ({ assets: lastSeen.size, states: state.size, rules: rules.length }),
  };
}
