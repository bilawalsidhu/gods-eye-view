import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { parseTapAddress } from './tapAddress.js';

/**
 * @file Rayhunter (EFF cell-site-simulator/IMSI-catcher detector) tap (#56).
 *
 * Rayhunter (https://github.com/EFForg/rayhunter) runs ON a device the user
 * owns — typically a flashed Orbic mobile hotspot — and flags suspicious
 * cellular behavior it observes. It has no GPS of its own by default, so
 * this is inherently a PERSONAL, opt-in, local-network layer: it polls the
 * user's own Rayhunter over the same-origin `/api/rayhunter/*` proxy
 * (vite.config.js — the device's embedded web server sends no CORS headers,
 * so the browser can't reach it directly) and plots newly-seen warnings at
 * wherever the BROWSER currently is when the warning is first observed —
 * not the device's actual location at detection time, which this app has no
 * way to know. That approximation is surfaced honestly via getStats().error
 * rather than presented as precise.
 *
 * API shape verified against EFForg/rayhunter's real source (see
 * vite.config.js's rayhunterProxy() doc comment for exact routes/fields).
 * @module data/rayhunterTap
 */

export const RAYHUNTER_TAP_LAYER_ID = 'rayhunter-tap';
const POLL_INTERVAL_MS = 15_000;
const MAX_RENDERED = 200;
const SEVERITY_COLOR = Object.freeze({ Low: '#ffe066', Medium: '#ffa63f', High: '#ff4d4d' });
const SEVERITY_RANK = Object.freeze({ Low: 1, Medium: 2, High: 3 });

/**
 * Whether a typed device address is one the proxy will accept.
 *
 * Delegates to the shared tap-address contract rather than re-deriving the
 * rule, so the browser's "is this address usable?" answer cannot drift from
 * the server's. This used to be a hand-synced copy of the proxy's regex.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidRayhunterBase(raw) {
  return parseTapAddress(raw) !== null;
}

/**
 * Which manifest entry to read the analysis report for.
 * @param {{current_entry?: {name?: string}, entries?: Array<{name?: string, start_time?: string}>}} manifest
 * @returns {string|null} "live" while a recording is in progress, else the
 *   most recently STARTED closed recording's name, else null (no recordings yet).
 */
export function pickManifestTargetName(manifest) {
  if (manifest?.current_entry?.name) return 'live';
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  if (!entries.length) return null;
  return entries.slice()
    .sort((a, b) => String(b?.start_time || '').localeCompare(String(a?.start_time || '')))[0]
    ?.name || null;
}

/**
 * Parse a Rayhunter analysis-report NDJSON body into non-informational warnings.
 * The first line is report metadata (no `events` array) and is skipped along
 * with any malformed line, rather than aborting the whole parse.
 * @param {string} ndjsonText
 * @returns {Array<{key: string, timestamp: string|null, severity: 'Low'|'Medium'|'High', message: string}>}
 */
export function parseRayhunterWarnings(ndjsonText) {
  const warnings = [];
  for (const line of String(ndjsonText || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (!Array.isArray(row?.events)) continue; // metadata line or malformed
    for (const event of row.events) {
      if (!event || !SEVERITY_RANK[event.event_type]) continue; // skips Informational too
      warnings.push({
        key: `${row.packet_timestamp || 'unknown'}|${event.event_type}|${event.message}`,
        timestamp: row.packet_timestamp || null,
        severity: event.event_type,
        message: String(event.message || ''),
      });
    }
  }
  return warnings;
}

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  base: '192.168.1.1:8080',
  warnings: [], // newest first, capped at MAX_RENDERED
  seenKeys: new Set(),
  selectedId: null,
  lastUpdate: null,
  error: null,
  abort: null,
  clickHandler: null,
  position: null, // {lat, lon} — last known browser geolocation fix
  geoWatchId: null,
  geoError: null,
};

function severityColor(severity) {
  return Cesium.Color.fromCssColorString(SEVERITY_COLOR[severity] || SEVERITY_COLOR.Low);
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(RAYHUNTER_TAP_LAYER_ID);
}

function renderWarnings() {
  governorRequestRender('rayhunter-render');
  clearRendered();
  for (const warning of state.warnings.slice(0, MAX_RENDERED)) {
    if (!warning.position) continue; // no location fix yet when it was first observed
    const color = severityColor(warning.severity);
    const selected = warning.key === state.selectedId;
    const position = Cesium.Cartesian3.fromDegrees(warning.position.lon, warning.position.lat);
    const entity = state.dataSource.entities.add({
      id: warning.key,
      position,
      point: {
        pixelSize: selected ? 14 : 10,
        color: selected ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: `Rayhunter: ${warning.severity} warning`,
      details: [warning.message].filter(Boolean),
      accent: color.toCssColorString(),
    };
    registerEntityContext(entity, {
      id: warning.key,
      layerId: RAYHUNTER_TAP_LAYER_ID,
      layerName: 'Rayhunter Tap',
      source: 'EFF Rayhunter (personal device, local network)',
      label: `${warning.severity} warning`,
      latitude: warning.position.lat,
      longitude: warning.position.lon,
      properties: {
        severity: warning.severity,
        message: warning.message,
        deviceTimestamp: warning.timestamp,
        locationApproximate: true,
      },
    });
  }
  const selectedEntity = state.selectedId ? state.dataSource.entities.getById(state.selectedId) : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

function selectWarning(id) {
  if (!state.warnings.some((w) => w.key === id) || !state.dataSource) return false;
  state.selectedId = id;
  renderWarnings();
  return state.selectedId === id;
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    if (id && state.warnings.some((w) => w.key === id)) selectWarning(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function startGeolocation() {
  if (state.geoWatchId !== null) return;
  if (!('geolocation' in navigator)) {
    state.geoError = 'Geolocation unavailable in this browser/context — warnings can’t be placed';
    return;
  }
  state.geoWatchId = navigator.geolocation.watchPosition(
    (fix) => {
      state.position = { lat: fix.coords.latitude, lon: fix.coords.longitude };
      state.geoError = null;
    },
    (err) => {
      state.geoError = `Location unavailable (${err?.message || 'permission denied'}) — warnings can’t be placed`;
    },
    { enableHighAccuracy: false, maximumAge: 30_000, timeout: 15_000 },
  );
}

function stopGeolocation() {
  if (state.geoWatchId !== null) navigator.geolocation?.clearWatch?.(state.geoWatchId);
  state.geoWatchId = null;
}

async function pollDevice() {
  if (!state.enabled) return;
  if (!isValidRayhunterBase(state.base)) {
    state.error = 'Invalid Rayhunter device address — set it via the ⚙️ chip (host:port)';
    return;
  }
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  const stillCurrent = () => !requestAbort.signal.aborted && state.abort === requestAbort && state.enabled;
  try {
    const manifestRes = await fetch(
      `/api/rayhunter/manifest?base=${encodeURIComponent(state.base)}`,
      { signal: requestAbort.signal },
    );
    if (!stillCurrent()) return;
    if (!manifestRes.ok) {
      state.error = manifestRes.status === 400
        ? 'Invalid Rayhunter device address'
        : 'Rayhunter device unreachable — check it’s on and you’re on its network';
      return;
    }
    const manifest = await manifestRes.json();
    if (!stillCurrent()) return;
    const targetName = pickManifestTargetName(manifest);
    if (!targetName) {
      state.warnings = [];
      state.error = 'No recordings on this Rayhunter yet — start one in its web UI';
      renderWarnings();
      return;
    }
    const reportRes = await fetch(
      `/api/rayhunter/analysis/${encodeURIComponent(targetName)}?base=${encodeURIComponent(state.base)}`,
      { signal: requestAbort.signal },
    );
    if (!stillCurrent()) return;
    if (!reportRes.ok) {
      state.error = reportRes.status === 404
        ? 'No analysis report yet for the current recording'
        : 'Rayhunter device unreachable — check it’s on and you’re on its network';
      return;
    }
    const parsed = parseRayhunterWarnings(await reportRes.text());
    if (!stillCurrent()) return;
    const fresh = parsed.filter((w) => !state.seenKeys.has(w.key));
    for (const warning of fresh) {
      state.seenKeys.add(warning.key);
      state.warnings.unshift({ ...warning, position: state.position });
    }
    if (state.warnings.length > MAX_RENDERED) {
      state.warnings.length = MAX_RENDERED;
      // seenKeys must stay bounded together with the list it dedups against —
      // this is a long-lived, always-on personal layer (polls every 15s
      // indefinitely), so an unbounded seenKeys would grow for the life of the
      // tab. Every other layer's dedup set is either scoped to one fetch or
      // capped alongside its render list (alprCameras.js, nifcWildfires.js);
      // rebuilding from the survivors matches that.
      state.seenKeys = new Set(state.warnings.map((w) => w.key));
    }
    // A warning first seen before any location fix arrived would otherwise be
    // stuck at position:null forever (renderWarnings() skips unplaced
    // warnings) even after a fix DOES arrive on a later poll. Backfill it with
    // whatever fix we have now — still an approximation, same as a warning
    // placed at first-observation time, just late.
    let backfilled = false;
    if (state.position) {
      for (const warning of state.warnings) {
        if (!warning.position) { warning.position = state.position; backfilled = true; }
      }
    }
    state.lastUpdate = Date.now();
    state.error = state.geoError
      || (fresh.length > 0 && !state.position
        ? 'Some warnings can’t be placed yet — waiting for a location fix'
        : null);
    if (fresh.length || backfilled) renderWarnings();
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return;
    state.error = 'Rayhunter device unreachable — check it’s on and you’re on its network';
  } finally {
    if (state.abort === requestAbort) state.abort = null;
  }
}

const rayhunterTapLayer = {
  id: RAYHUNTER_TAP_LAYER_ID,
  name: 'Rayhunter Tap',
  icon: '📶',
  source: 'EFF Rayhunter (personal device)',
  updateInterval: POLL_INTERVAL_MS,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource(RAYHUNTER_TAP_LAYER_ID);
    state.dataSource.show = false;
    viewer.dataSources.add(state.dataSource);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(RAYHUNTER_TAP_LAYER_ID, (id) => state.warnings.some((w) => w.key === id));
    if (state.dataSource) state.dataSource.show = true;
    startGeolocation();
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(RAYHUNTER_TAP_LAYER_ID);
    state.abort?.abort();
    state.abort = null;
    stopGeolocation();
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(RAYHUNTER_TAP_LAYER_ID);
    state.selectedId = null;
  },
  update() { return pollDevice(); },
  setParams(params = {}) {
    if (Object.hasOwn(params, 'base') && typeof params.base === 'string' && params.base.trim()) {
      state.base = params.base.trim();
    }
    return true;
  },
  getParams() {
    return { base: state.base };
  },
  getRowControls() {
    if (!state.enabled) return { chips: [], legend: [] };
    const counts = { Low: 0, Medium: 0, High: 0 };
    // Only warnings with a pin actually on the globe — a warning still
    // waiting on its first location fix (renderWarnings() skips it) must not
    // inflate a count sitting right next to zero visible pins.
    for (const w of state.warnings) if (w.position) counts[w.severity] += 1;
    return {
      chips: [{
        id: 'set-base',
        label: `⚙️ ${state.base}`,
        active: false,
        title: 'Set your Rayhunter device address (host:port), e.g. 192.168.1.1:8080',
        prompt: {
          label: 'Rayhunter device address (host:port)',
          value: state.base,
          toParams: (value) => (isValidRayhunterBase(value) ? { base: value } : null),
        },
      }],
      legend: Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([severity, count]) => ({
          color: SEVERITY_COLOR[severity],
          label: severity,
          count,
        })),
    };
  },
  destroy(viewer) {
    this.disable();
    state.clickHandler?.destroy();
    state.clickHandler = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.warnings = [];
    state.seenKeys = new Set();
    state.lastUpdate = null;
    state.error = null;
    state.position = null;
    state.geoError = null;
  },
  getStats() {
    return {
      // Matches the legend above: a warning still waiting on its first
      // location fix has no pin on the globe yet, so it doesn't count as
      // "shown" either — state.error already explains the gap while it lasts.
      count: state.warnings.filter((w) => w.position).length,
      lastUpdate: state.lastUpdate,
      error: state.error,
    };
  },
};

export default rayhunterTapLayer;
