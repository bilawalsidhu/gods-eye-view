import { captureLocalViewport } from './localVision.js';
import {
  buildIncidentBundle,
  bundleBytes,
  collectIncidentTracks,
  incidentSlug,
  DEFAULT_RADIUS_KM,
} from './incidentBundle.js';

/**
 * Browser-side incident export: gathers the camera, a viewport screenshot,
 * the position history, the recent transcript and standing watches, builds
 * the self-contained replay bundle and hands it to the server (and, best
 * effort, to the browser's download tray). Pure pieces live in
 * incidentBundle.js; this module only wires the sources together.
 */
export const INCIDENTS_ENDPOINT = '/api/voice/incidents';
export const DEFAULT_INCIDENT_MINUTES = 5;
export const MAX_INCIDENT_MINUTES = 15;

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

async function defaultFetchJson(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data?.error || `HTTP ${response.status} from ${url}`);
  return data;
}

/** Context built from the window handles the shell publishes. */
export function defaultIncidentContext() {
  const w = globalThis.window;
  return {
    camera: () => {
      try {
        return w?.__godsEyeView?.styleManager?.getCameraState?.() || null;
      } catch {
        return null;
      }
    },
    captureImage: () => captureLocalViewport(),
    fetchJson: defaultFetchJson,
    history: () => w?.__gevPositionHistory || null,
    diagnostics: () => {
      try {
        return w?.__gevVoiceCommands?.getDiagnostics?.() || null;
      } catch {
        return null;
      }
    },
  };
}

/** Offer the bundle as a download; sandboxed pages may silently refuse. */
export function downloadBundle(
  html,
  fileName,
  documentRef = globalThis.document,
) {
  try {
    if (!documentRef?.createElement || typeof Blob === 'undefined')
      return false;
    const urlApi = globalThis.URL;
    if (typeof urlApi?.createObjectURL !== 'function') return false;
    const blob = new Blob([html], { type: 'text/html' });
    const href = urlApi.createObjectURL(blob);
    const link = documentRef.createElement('a');
    link.href = href;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    documentRef.body?.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => urlApi.revokeObjectURL(href), 10_000);
    return true;
  } catch {
    return false;
  }
}

function resolve(value) {
  return typeof value === 'function' ? value() : value;
}

/**
 * Export an incident bundle around the current view.
 * @param {object} [args]
 * @param {string} [args.title]
 * @param {number} [args.minutes] Half-window in minutes (0.5–15).
 * @param {number} [args.radiusKm] Track inclusion radius (1–500 km).
 * @param {Array|string} [args.alerts] Alert text to include instead of watches.
 * @param {string} [args.notes]
 * @param {object} [context] Overrides for camera, captureImage, fetchJson,
 *   history, diagnostics, now and download.
 */
export async function exportIncident(args = {}, context = {}) {
  const ctx = { ...defaultIncidentContext(), ...context };
  const now = typeof ctx.now === 'function' ? ctx.now : Date.now;
  const camera = ctx.camera?.() || null;
  if (!camera || !Number.isFinite(camera.lat) || !Number.isFinite(camera.lon))
    return { ok: false, error: 'Camera position unavailable' };

  const minutes = clamp(
    args.minutes,
    0.5,
    MAX_INCIDENT_MINUTES,
    DEFAULT_INCIDENT_MINUTES,
  );
  const radiusKm = clamp(args.radiusKm, 1, 500, DEFAULT_RADIUS_KM);
  const at = Number.isFinite(args.at) ? args.at : now();
  const windowMs = minutes * 60_000;
  const title =
    String(args.title || '').trim() ||
    `Incident ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z`;

  let screenshotDataUrl = null;
  try {
    screenshotDataUrl = (await ctx.captureImage?.()) || null;
  } catch {
    screenshotDataUrl = null;
  }
  const diagnostics = resolve(ctx.diagnostics) || {};
  const transcript = Array.isArray(diagnostics.recentTranscript)
    ? diagnostics.recentTranscript
    : [];
  const alerts =
    args.alerts != null
      ? args.alerts
      : Array.isArray(diagnostics.watches)
        ? diagnostics.watches
        : [];
  const history = resolve(ctx.history);
  const center = { lat: camera.lat, lon: camera.lon };
  const tracks = collectIncidentTracks(history, {
    at,
    windowMs,
    center,
    radiusKm,
  });
  const html = buildIncidentBundle({
    title,
    at,
    windowMs,
    center,
    radiusKm,
    history: tracks,
    screenshotDataUrl,
    transcript,
    alerts,
    notes: args.notes || '',
    camera,
  });
  const bytes = bundleBytes(html);
  const slug = incidentSlug(title);

  let saved = null;
  let saveError = null;
  try {
    saved = await ctx.fetchJson(INCIDENTS_ENDPOINT, { title, at, slug, html });
  } catch (error) {
    saveError = error?.message || String(error);
  }
  const fileName = saved?.file || `${slug}.html`;
  const downloaded =
    ctx.download === false ? false : downloadBundle(html, fileName);

  const result = {
    ok: Boolean(saved?.ok),
    file: saved?.file || null,
    tracks: tracks.length,
    bytes,
    downloaded,
    screenshot: Boolean(screenshotDataUrl),
    title,
  };
  if (saveError) result.error = saveError;
  return result;
}

/**
 * Capture an incident for an alert the watch engine raised. Not wired to the
 * alert engine yet; callers pass the alert (description, layer, label) and
 * an optional context override.
 */
export function captureIncident(alert = {}, context = {}) {
  const description =
    alert?.description || alert?.text || alert?.message || 'Alert';
  const label = alert?.label ? ` — ${alert.label}` : '';
  return exportIncident(
    {
      title: `${description}${label}`,
      minutes: alert?.minutes,
      radiusKm: alert?.radiusKm,
      alerts: [alert],
      notes: alert?.notes || '',
    },
    context,
  );
}
