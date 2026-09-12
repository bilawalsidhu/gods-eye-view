/**
 * Shared layer snapshot envelope for voice and HUD answers.
 *
 * Data Layers chips, `analyst_query`, `get_current_view_state`, and the HUD
 * summary must all name the same feed-state. This module is the one envelope:
 * it classifies `getStats()` through `layerFeedState` and stamps the result
 * so a stale or degraded feed cannot be narrated as live. Cesium-free so the
 * HUD summary proxy can import it from Node.
 *
 * @module data/layerSnapshot
 */

/** Feed states the Data Layers chips and voice/HUD provenance share. */
export const LAYER_FEED_STATES = Object.freeze([
  'nominal',
  'loading',
  'degraded',
  'stale',
  'fallback',
  'unavailable',
]);

/** Chip labels for enabled layers. Disabled layers read OFF, not a feed-state. */
export const LAYER_FEED_STATE_LABELS = Object.freeze({
  nominal: 'ON',
  loading: 'LOADING',
  degraded: 'DEGRADED',
  stale: 'STALE',
  fallback: 'FALLBACK',
  unavailable: 'UNAVAILABLE',
});

/** Snapshot feed-state including a disabled layer. */
export const SNAPSHOT_FEED_STATES = Object.freeze([...LAYER_FEED_STATES, 'off']);

/**
 * Lower rank is more severe. Voice/HUD `overall` is the worst queried state
 * so a mixed roster cannot hide an unavailable or stale feed behind a nominal
 * neighbour.
 */
export const FEED_STATE_SEVERITY = Object.freeze({
  unavailable: 0,
  loading: 1,
  degraded: 2,
  stale: 3,
  fallback: 4,
  nominal: 5,
  off: 6,
});

/**
 * Normalize heterogeneous layer stats into one honest control-chip state.
 * @param {object|null} stats Layer getStats() result.
 * @returns {'nominal'|'loading'|'degraded'|'stale'|'fallback'|'unavailable'} Feed state.
 */
export function layerFeedState(stats = {}) {
  const state = stats || {};
  const status = typeof state.status === 'string' ? state.status.toLowerCase() : '';
  const source = `${state.source || ''} ${state.coverage || ''}`;
  const hasExplicitFallback = typeof state.fallback === 'boolean';
  const hasPriorData = Number(state.count) > 0 || Boolean(state.lastUpdate);
  const presentedError = state.error || state.lastError || state.managerRefreshError;
  if (['unavailable', 'offline', 'down', 'error'].includes(status)) return 'unavailable';
  if (
    (presentedError || state.unavailable === true || state.available === false)
    && !hasPriorData
    && !['zoom-in', 'empty', 'idle'].includes(status)
  ) {
    return 'unavailable';
  }
  if (state.loading) return 'loading';
  // Guidance states ask the user to act (zoom in, run a search) — normal
  // operation, not feed faults. One honesty carve-out: layers keep their
  // rendered records through the guidance state, so a genuinely stale cache
  // still reads STALE; a guidance prompt alone never reads DEGRADED.
  if (['zoom-in', 'empty', 'idle'].includes(status)) {
    return state.stale ? 'stale' : 'nominal';
  }
  if (
    state.fallback === true
    || status === 'fallback'
    || state.mode === 'sim'
    || /\bfallback\b/i.test(source)
    || (!hasExplicitFallback && /\badsb\.lol\b/i.test(source))
  ) {
    return 'fallback';
  }
  if (state.stale || status === 'stale') return 'stale';
  if (
    state.degraded
    || presentedError
    || state.unavailable === true
    || state.available === false
  ) return 'degraded';
  return 'nominal';
}

function snapshotError(stats) {
  const err = stats?.error || stats?.lastError || stats?.managerRefreshError;
  if (err == null || err === '') return null;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Age of a lastUpdate timestamp in whole seconds.
 * @param {number|null|undefined} lastUpdate Epoch ms.
 * @param {number} [now=Date.now()] Clock for tests.
 * @returns {number|null} Non-negative seconds, or null when unknown.
 */
export function snapshotAgeSec(lastUpdate, now = Date.now()) {
  const stamp = Number(lastUpdate);
  if (!Number.isFinite(stamp) || stamp <= 0) return null;
  return Math.max(0, Math.floor((now - stamp) / 1000));
}

/**
 * Compact age label matching the Data Layers meta line.
 * @param {number|null|undefined} lastUpdate Epoch ms.
 * @param {number} [now=Date.now()] Clock for tests.
 * @returns {string|null} `just now` / `12s ago` / `4m ago` / `2h ago`.
 */
export function snapshotAgeLabel(lastUpdate, now = Date.now()) {
  const sec = snapshotAgeSec(lastUpdate, now);
  if (sec === null) return null;
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

/**
 * Pick the most severe feed-state from a list.
 * @param {Iterable<string|null|undefined>} states Feed-state strings.
 * @returns {'nominal'|'loading'|'degraded'|'stale'|'fallback'|'unavailable'|'off'|null}
 */
export function worstFeedState(states) {
  let worst = null;
  let worstRank = Number.POSITIVE_INFINITY;
  for (const state of states || []) {
    if (!Object.hasOwn(FEED_STATE_SEVERITY, state)) continue;
    const rank = FEED_STATE_SEVERITY[state];
    if (rank < worstRank) {
      worst = state;
      worstRank = rank;
    }
  }
  return worst;
}

/**
 * One honest layer snapshot for voice/HUD narration.
 *
 * Disabled layers report `feedState: 'off'` — the same reading the chips use —
 * even if leftover stats would otherwise classify as stale. Counts and errors
 * still travel so a disabled layer with a last-known error is inspectable.
 *
 * @param {object} [layer] `DataLayerManager.getAll()` projection, or a layer-like
 *   object with `id`, `enabled`, `stats`, and optional `source`/`name`.
 * @param {{ now?: number }} [options]
 * @returns {{
 *   id: string|null,
 *   name: string|null,
 *   enabled: boolean,
 *   feedState: string,
 *   source: string|null,
 *   count: number,
 *   lastUpdate: number|null,
 *   ageSec: number|null,
 *   ageLabel: string|null,
 *   error: string|null,
 * }}
 */
export function layerSnapshot(layer = {}, { now = Date.now() } = {}) {
  const stats = (layer && typeof layer.stats === 'object' && layer.stats) || {};
  const source = String(stats.source || layer.source || '').trim() || null;
  const enabled = Boolean(layer.enabled);
  const countRaw = Number(stats.count);
  const count = Number.isFinite(countRaw) ? countRaw : 0;
  const lastUpdate = Number.isFinite(Number(stats.lastUpdate)) ? Number(stats.lastUpdate) : null;
  const feedState = enabled ? layerFeedState({ ...stats, source }) : 'off';
  return {
    id: layer.id || layer.layerKey || null,
    name: layer.name || layer.label || layer.id || layer.layerKey || null,
    enabled,
    feedState,
    source,
    count,
    lastUpdate,
    ageSec: snapshotAgeSec(lastUpdate, now),
    ageLabel: snapshotAgeLabel(lastUpdate, now),
    error: snapshotError(stats),
  };
}

/**
 * Snapshot every layer in a roster.
 * @param {Array<object>} [layers]
 * @param {{ now?: number }} [options]
 * @returns {Array<object>}
 */
export function layerSnapshots(layers = [], options) {
  if (!Array.isArray(layers)) return [];
  return layers.map((layer) => layerSnapshot(layer, options));
}

function asSnapshot(entry, now) {
  if (!entry || typeof entry !== 'object') return layerSnapshot({}, { now });
  if (typeof entry.feedState === 'string') return entry;
  return layerSnapshot(entry, { now });
}

/**
 * Mechanical narration note so the model does not have to infer honesty.
 * @param {Array<object>} layers Snapshots.
 * @param {string|null} overall Worst considered feed-state.
 * @returns {string}
 */
export function feedProvenanceNote(layers = [], overall = null) {
  if (!overall) {
    return 'No layer snapshot is attached. Do not invent a feed-state or a count.';
  }
  if (overall === 'nominal') {
    return 'Queried enabled layers are nominal. Still name the count scope; do not claim whole-world coverage.';
  }
  if (overall === 'off') {
    const names = layers.map((s) => s.name || s.id).filter(Boolean).join(', ') || 'the requested layer';
    return `${names} is off. Do not invent a count; say the layer is off and offer to enable it.`;
  }
  const flagged = layers.filter((s) => (
    s.feedState && s.feedState !== 'nominal' && s.feedState !== 'off'
  ));
  const bits = flagged.map((s) => {
    const extras = [s.source, s.ageLabel || snapshotAgeLabel(s.lastUpdate), s.error]
      .filter(Boolean)
      .join(', ');
    return `${s.name || s.id} is ${String(s.feedState).toUpperCase()}${extras ? ` (${extras})` : ''}`;
  });
  const body = bits.join('; ') || `${String(overall).toUpperCase()} feed`;
  return `${body}. Narrate that provenance with any count; do not describe this as live.`;
}

/**
 * Shared envelope stamped onto analyst, view-state, and HUD payloads.
 * @param {Array<object>} [snapshots] Snapshots or raw `getAll()` rows.
 * @param {{ now?: number }} [options]
 * @returns {{ overall: string|null, layers: Array<object>, note: string }}
 */
export function feedProvenanceEnvelope(snapshots = [], { now = Date.now() } = {}) {
  const layers = (Array.isArray(snapshots) ? snapshots : []).map((entry) => asSnapshot(entry, now));
  const active = layers.filter((s) => s.feedState && s.feedState !== 'off');
  const overall = worstFeedState(active.map((s) => s.feedState))
    || (layers.length ? 'off' : null);
  return {
    overall,
    layers,
    note: feedProvenanceNote(layers, overall),
  };
}

/**
 * Compact voice-tool layer row: identity + the fields a model must read.
 * @param {object} layer Raw `getAll()` row or snapshot.
 * @param {{ now?: number }} [options]
 * @returns {object}
 */
export function viewStateLayerRow(layer, options) {
  const snap = layerSnapshot(layer, options);
  return {
    id: snap.id,
    name: snap.name,
    enabled: snap.enabled,
    count: snap.count,
    error: snap.error,
    feedState: snap.feedState,
    source: snap.source,
    lastUpdate: snap.lastUpdate,
  };
}
