import { haversineKm, inScope, resolveScope } from '../watchEngine.js';

/**
 * Multi-camera vision sweep. "Scan the cameras around downtown and tell me
 * which streets are jammed": pick the nearest loaded public cameras, pull one
 * frame each through the CCTV proxy, shrink them in a canvas, post them to
 * /api/voice/vision-batch, and drop a red / amber / green mark at each camera
 * with the vision model's short verdict.
 *
 * Cameras come from the CCTV layer module's public UI state
 * (`getUIState().cameras`, the same list the camera panel renders); frames
 * come from the same-origin `/api/cctv/frame/:id` proxy the projection plane
 * uses, so no upstream URL ever reaches the browser.
 */
export const VISION_BATCH_URL = '/api/voice/vision-batch';
export const FRAME_ENDPOINT = '/api/cctv/frame';
export const SWEEP_DEFAULT_MAX = 8;
export const SWEEP_HARD_MAX = 12;
export const SWEEP_SPARE_CAMERAS = 4;
export const SWEEP_FRAME_TIMEOUT_MS = 12_000;
export const SWEEP_FRAME_MAX_WIDTH = 640;
export const SWEEP_FRAME_QUALITY = 0.7;
export const SWEEP_FRAME_MAX_BYTES = 300 * 1024;
export const SWEEP_LABEL_MAX = 80;
export const RED_SCORE = 0.6;
export const GREEN_SCORE = 0.4;

const SCOPE = {
  type: 'object',
  additionalProperties: false,
  description:
    'Which cameras. view = what the camera sees now (default); radius = km around a point (omit latitude/longitude for "here"); anywhere = nearest loaded cameras regardless of view.',
  properties: {
    kind: { type: 'string', enum: ['view', 'radius', 'anywhere'] },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    km: { type: 'number', minimum: 1, maximum: 5000 },
  },
  required: ['kind'],
};

/** Result timeouts (ms) the server should allow for these tools. */
export const timeouts = Object.freeze({ camera_sweep: 180_000 });

export const schemas = [
  {
    name: 'camera_sweep',
    description:
      'Look through several public cameras at once and answer one visual question about each: "scan the cameras downtown and tell me which streets are jammed", "is it raining at any camera near here", "which cameras show flooding or snow". Fetches a live frame per camera, asks the vision model, and marks the map red (condition holds), amber (unsure) or green (does not hold). Needs the CCTV layer on. Takes 20-60 seconds. Speak the counts and name the red cameras; never read coordinates.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: {
          type: 'string',
          description:
            'A yes/no style visual question asked of every camera, e.g. "Is traffic jammed or stopped?"',
        },
        scope: SCOPE,
        max: {
          type: 'integer',
          minimum: 1,
          maximum: SWEEP_HARD_MAX,
          description: `Cameras to check, nearest first. Default ${SWEEP_DEFAULT_MAX}.`,
        },
        mark: {
          type: 'boolean',
          description: 'Drop coloured marks at each camera. Default true.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'clear_camera_marks',
    description:
      'Remove the coloured marks left by the last camera sweep (clears the annotation board).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

/** Verdict band for one score. */
export function verdictFor(score) {
  if (!Number.isFinite(score)) return 'amber';
  if (score >= RED_SCORE) return 'red';
  if (score <= GREEN_SCORE) return 'green';
  return 'amber';
}

/**
 * Enumerate loaded cameras with coordinates. Prefers the layer's public UI
 * state; falls back to the detection-overlay sample (ECEF positions) when the
 * presentation surface is unavailable.
 */
export function listCameras(globe) {
  const dataManager = globe?.dataManager;
  const module = dataManager?.layers?.get?.('cctv')?.module;
  if (!module) return { error: 'CCTV layer unavailable', cameras: [] };
  if (
    typeof dataManager.isEnabled === 'function' &&
    !dataManager.isEnabled('cctv')
  )
    return {
      error: 'CCTV layer is off — enable it first (control_cctv enable)',
      cameras: [],
    };
  const fromState = module.getUIState?.()?.cameras;
  const cameras = [];
  if (Array.isArray(fromState) && fromState.length) {
    for (const cam of fromState) {
      if (!Number.isFinite(cam?.lat) || !Number.isFinite(cam?.lon)) continue;
      cameras.push({
        id: String(cam.id),
        name: String(cam.name || cam.id),
        city: cam.city ? String(cam.city) : '',
        lat: cam.lat,
        lon: cam.lon,
        headingDeg: cam.headingDeg,
        fovDeg: cam.fovDeg,
        pitchDeg: cam.pitchDeg,
        sourceKind: cam.sourceKind || null,
        sourceStatus: cam.sourceStatus || 'unknown',
      });
    }
  } else if (typeof module.getDetectableObjects === 'function') {
    const ellipsoid = globe?.viewer?.scene?.globe?.ellipsoid;
    for (const object of module.getDetectableObjects({ maxCount: 20000 })) {
      const carto = ellipsoid?.cartesianToCartographic?.(object.position);
      if (!carto) continue;
      const id = String(object.sourceId || object.id);
      cameras.push({
        id,
        name: id,
        city: '',
        lat: (carto.latitude * 180) / Math.PI,
        lon: (carto.longitude * 180) / Math.PI,
        sourceStatus: 'unknown',
      });
    }
  }
  if (!cameras.length)
    return { error: 'No cameras are loaded yet', cameras: [] };
  return { cameras };
}

/**
 * Nearest cameras inside the scope, with distance from the scope centre (or
 * the camera when the scope is "anywhere"). Known placeholder feeds sort last
 * so the sweep spends its slots on cameras that actually return imagery.
 */
export function selectCameras(cameras, scope, cameraState, limit) {
  const resolved = resolveScope(scope || { kind: 'view' }, cameraState);
  const centre =
    resolved ||
    (cameraState ? { lat: cameraState.lat, lon: cameraState.lon } : null);
  const rank = (cam) =>
    cam.sourceKind === 'synthetic' || cam.sourceStatus === 'offline' ? 1 : 0;
  const rows = [];
  for (const cam of cameras) {
    if (!inScope(cam, resolved)) continue;
    const distanceKm = centre
      ? Math.round(haversineKm(cam.lat, cam.lon, centre.lat, centre.lon) * 10) /
        10
      : null;
    rows.push({ ...cam, distanceKm });
  }
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
      a.id.localeCompare(b.id),
  );
  return { selected: rows.slice(0, limit), inScopeCount: rows.length, centre };
}

/** Same-origin proxy URL for one camera frame; the server fills any missing pose fields from its registry. */
export function frameUrlFor(camera, now = Date.now) {
  const params = new URLSearchParams();
  if (camera.name) params.set('label', camera.name);
  if (camera.city) params.set('city', camera.city);
  if (Number.isFinite(camera.lat)) params.set('lat', camera.lat.toFixed(6));
  if (Number.isFinite(camera.lon)) params.set('lon', camera.lon.toFixed(6));
  if (Number.isFinite(camera.headingDeg))
    params.set('heading', String(Math.round(camera.headingDeg)));
  if (Number.isFinite(camera.fovDeg))
    params.set('fov', String(Math.round(camera.fovDeg)));
  if (Number.isFinite(camera.pitchDeg))
    params.set('pitch', String(Math.round(camera.pitchDeg)));
  params.set('ts', String(Math.floor(now() / 10_000)));
  params.set('sweep', '1');
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params}`;
}

/**
 * Decode a frame blob and re-encode it as a small base64 JPEG (no data-URL
 * prefix). Browser only; returns null where canvas/ImageBitmap are missing so
 * Node tests inject their own encoder.
 */
export async function encodeFrameInBrowser(
  blob,
  {
    maxWidth = SWEEP_FRAME_MAX_WIDTH,
    quality = SWEEP_FRAME_QUALITY,
    maxBytes = SWEEP_FRAME_MAX_BYTES,
    documentRef = globalThis.document,
    createBitmap = globalThis.createImageBitmap,
  } = {},
) {
  if (typeof createBitmap !== 'function' || !documentRef?.createElement)
    return null;
  const bitmap = await createBitmap(blob);
  try {
    let width = Math.min(maxWidth, bitmap.width || maxWidth);
    let q = quality;
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = width / (bitmap.width || width);
      const height = Math.max(1, Math.round((bitmap.height || width) * scale));
      const canvas = documentRef.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const base64 = canvas
        .toDataURL('image/jpeg', q)
        .replace(/^data:image\/[a-z]+;base64,/, '');
      if ((base64.length * 3) / 4 <= maxBytes) return base64;
      q = Math.max(0.4, q - 0.15);
      width = Math.round(width * 0.8);
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

function clampLabel(text, max = SWEEP_LABEL_MAX) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function createHandlers({
  getGlobe,
  camera,
  fetchJson,
  runner = null,
  speak = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  encodeFrame = encodeFrameInBrowser,
  now = Date.now,
  frameTimeoutMs = SWEEP_FRAME_TIMEOUT_MS,
} = {}) {
  const cameraState = () => {
    try {
      return (
        camera?.() || getGlobe?.()?.styleManager?.getCameraState?.() || null
      );
    } catch {
      return null;
    }
  };

  async function fetchFrame(cam) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), frameTimeoutMs);
    try {
      const response = await fetchImpl(frameUrlFor(cam, now), {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response?.ok) throw new Error(`frame HTTP ${response?.status}`);
      const source = response.headers?.get?.('X-CCTV-Source') || null;
      const type = response.headers?.get?.('Content-Type') || '';
      if (source === 'synthetic' || /svg/i.test(type))
        throw new Error('no live frame (placeholder)');
      const blob = await response.blob();
      const image = await encodeFrame(blob);
      if (!image) throw new Error('could not encode frame');
      return { image, frameSource: source || 'upstream' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch frames for up to `limit` cameras, filling failures from spares. */
  async function collectFrames(candidates, limit) {
    const frames = [];
    const skipped = [];
    let cursor = 0;
    while (frames.length < limit && cursor < candidates.length) {
      const batch = candidates.slice(cursor, cursor + (limit - frames.length));
      cursor += batch.length;
      const settled = await Promise.allSettled(batch.map(fetchFrame));
      settled.forEach((outcome, i) => {
        const cam = batch[i];
        if (outcome.status === 'fulfilled')
          frames.push({ camera: cam, ...outcome.value });
        else
          skipped.push({
            id: cam.id,
            label: cam.name,
            reason: outcome.reason?.message || String(outcome.reason),
          });
      });
    }
    return { frames, skipped };
  }

  async function annotate(marks) {
    const annotations = marks.map((m) => ({
      type: 'pin',
      latitude: m.lat,
      longitude: m.lon,
      label: m.label,
      color: m.color,
    }));
    if (typeof runner === 'function') {
      const result = await runner('annotate_map', { annotations }, {});
      return { drawn: result?.drawn ?? (result?.ok ? marks.length : 0) };
    }
    const engine = getGlobe?.()?.annotations;
    if (typeof engine?.annotate !== 'function')
      return { drawn: 0, error: 'Annotation engine unavailable' };
    const result = await engine.annotate(annotations, {
      clearPrevious: false,
      persist: true,
      flyTo: false,
    });
    return { drawn: result?.drawn ?? 0 };
  }

  return {
    async camera_sweep({ question, scope, max, mark } = {}) {
      const ask = String(question || '').trim();
      if (!ask) return { ok: false, error: 'A question is required' };
      const limit = Math.max(
        1,
        Math.min(SWEEP_HARD_MAX, Math.round(Number(max) || SWEEP_DEFAULT_MAX)),
      );
      let listed = listCameras(getGlobe?.());
      if (/is off/.test(listed.error || '') && typeof runner === 'function') {
        // Enable the layer ourselves and wait (up to 8 s) for cameras to load.
        try {
          await runner('control_cctv', { action: 'enable' }, {});
        } catch {
          /* fall through to the error below */
        }
        const until = Date.now() + 8000;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, 500));
          listed = listCameras(getGlobe?.());
          if (!listed.error && listed.cameras.length) break;
        }
        if (!listed.error && !listed.cameras.length)
          listed = {
            error:
              'CCTV layer enabled but no cameras have loaded yet; ask again in a few seconds',
            cameras: [],
          };
      }
      if (listed.error) return { ok: false, error: listed.error };
      const state = cameraState();
      const kind = scope?.kind || 'view';
      if (kind !== 'anywhere' && !state && !Number.isFinite(scope?.latitude))
        return { ok: false, error: 'Camera position unavailable' };
      const { selected, inScopeCount } = selectCameras(
        listed.cameras,
        { kind, ...scope },
        state,
        limit + SWEEP_SPARE_CAMERAS,
      );
      if (!selected.length)
        return {
          ok: false,
          error:
            kind === 'view'
              ? 'No cameras in view — zoom out or pick a city with cameras'
              : 'No cameras in that area',
          loadedCameras: listed.cameras.length,
        };
      speak?.(
        `Checking ${Math.min(limit, selected.length)} camera${selected.length === 1 ? '' : 's'}.`,
      );
      const { frames, skipped } = await collectFrames(selected, limit);
      if (!frames.length)
        return {
          ok: false,
          error: 'No camera returned a usable frame',
          skipped,
        };
      const batch = await fetchJson(VISION_BATCH_URL, {
        question: ask,
        images: frames.map((f) => ({
          id: f.camera.id,
          label: f.camera.name,
          lat: f.camera.lat,
          lon: f.camera.lon,
          image: f.image,
        })),
      });
      if (!batch?.ok)
        return {
          ok: false,
          error: batch?.error || 'Vision batch failed',
          skipped,
        };
      const byId = new Map(frames.map((f) => [f.camera.id, f]));
      const cameras = (batch.results || []).map((r) => {
        const frame = byId.get(String(r.id));
        const cam = frame?.camera || {};
        return {
          id: String(r.id),
          label: r.label || cam.name || String(r.id),
          answer: r.answer,
          score: r.score,
          verdict: r.error ? 'amber' : verdictFor(r.score),
          distanceKm: cam.distanceKm ?? null,
          frameSource: frame?.frameSource || null,
          ms: r.ms,
          error: r.error || undefined,
        };
      });
      for (const d of batch.dropped || [])
        skipped.push({ id: d.id, label: d.label, reason: d.reason });
      const red = cameras.filter((c) => c.verdict === 'red');
      const amber = cameras.filter((c) => c.verdict === 'amber');
      const green = cameras.filter((c) => c.verdict === 'green');
      let marked = 0;
      if (mark !== false) {
        const marks = cameras
          .map((c) => {
            const cam = byId.get(c.id)?.camera;
            if (!cam) return null;
            return {
              lat: cam.lat,
              lon: cam.lon,
              color: c.verdict,
              label: clampLabel(`${cam.name}: ${c.answer}`),
            };
          })
          .filter(Boolean);
        try {
          marked = (await annotate(marks)).drawn || 0;
        } catch {
          marked = 0;
        }
      }
      const summary =
        `${red.length} of ${cameras.length} cameras: yes` +
        (red.length ? ` (${red.map((c) => c.label).join(', ')})` : '') +
        `; ${green.length} no; ${amber.length} unsure` +
        (skipped.length ? `; ${skipped.length} skipped` : '') +
        '.';
      return {
        ok: true,
        question: ask,
        checked: cameras.length,
        inScope: inScopeCount,
        counts: { red: red.length, amber: amber.length, green: green.length },
        red: red.map((c) => ({
          label: c.label,
          answer: c.answer,
          score: c.score,
        })),
        cameras: cameras.map((c) => ({
          label: c.label,
          verdict: c.verdict,
          score: c.score,
          answer: c.answer,
          distanceKm: c.distanceKm,
          ...(c.error ? { error: c.error } : {}),
        })),
        skipped,
        marked,
        summary,
      };
    },

    async clear_camera_marks() {
      if (typeof runner === 'function') {
        const result = await runner('clear_annotations', {}, {});
        return { ok: result?.ok !== false, cleared: 'annotations' };
      }
      const engine = getGlobe?.()?.annotations;
      if (typeof engine?.clear !== 'function')
        return { ok: false, error: 'Annotation engine unavailable' };
      engine.clear();
      return { ok: true, cleared: 'annotations' };
    },
  };
}
