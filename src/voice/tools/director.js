/**
 * Auto-Director tool pack: "make me a 60-second tour of the busiest airspace".
 *
 * make_tour builds a Director scene from live analyst records
 * (src/voice/tourBuilder.js), loads it into the SceneDirector through its
 * validated `importProjectFile(file, { prepared })` document path — the same
 * seam the Scenes panel's EDIT DETAILS uses — and plays it with
 * `startScene(id, { single: true })`. Narration lines are spoken through the
 * voice session on each Director `shot_start` event. When the Director cannot
 * take a document, the pack falls back to flying the shell camera pose by pose
 * with timed holds.
 */
import {
  buildTour,
  nearestHub,
  pickFocus,
  resolveTheme,
  TOUR_SCENE_ID,
  TOUR_THEMES,
} from '../tourBuilder.js';
import { airlineFromCallsign } from '../localVision.js';
import {
  SCENE_DOCUMENT_VERSION,
  stringifySceneDocument,
} from '../../director/document.js';
import { createSceneBundle } from '../../director/sharing/bundle.js';

const TOUR_LAYERS = [
  ...new Set(
    Object.values(TOUR_THEMES)
      .map((t) => t.layer)
      .filter(Boolean),
  ),
];
const RECORD_LIMIT = 5000;
const DATA_WAIT_MS = 8000;
const GEOCODE_WAIT_MS = 2500;

/** Result timeouts (ms) the server should allow for these tools. */
export const timeouts = Object.freeze({ make_tour: 30_000 });

export const schemas = [
  {
    name: 'make_tour',
    description:
      'Cinematic auto-director: build and play a narrated camera tour of the busiest live activity. Themes: "airspace" (densest flights, highest aircraft), "ships"/"harbor" (densest vessels), "fires", "quakes", "military", or "view" (orbit the current view). "Make me a 60-second tour of the busiest airspace" -> theme "airspace", seconds 60. The tour narrates itself; answer with one short sentence.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: {
          type: 'string',
          description:
            'airspace | ships | fires | quakes | military | view, or the user’s words.',
        },
        seconds: {
          type: 'number',
          minimum: 8,
          maximum: 900,
          description: 'Total length in seconds. Default 60.',
        },
        narrate: {
          type: 'boolean',
          description: 'Speak a line at the start of each shot. Default true.',
        },
      },
      required: [],
    },
  },
  {
    name: 'stop_tour',
    description: 'Stop the tour that make_tour is playing.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'save_tour',
    description:
      'Keep the last make_tour as a named scene in the Scenes panel and download it as a scene bundle: "save that tour as Texas evening".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'tour';

/** Trigger a browser download; false when no DOM is available. */
function browserDownload(text, fileName) {
  const doc = globalThis.document;
  if (!doc?.createElement || typeof URL?.createObjectURL !== 'function')
    return false;
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const link = doc.createElement('a');
  link.href = url;
  link.download = fileName;
  doc.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
  return true;
}

/** Best-effort reverse geocode through the app's geospatial services. */
async function defaultGeocoder(lat, lon) {
  const { defaultGeospatial } = await import('../../search/defaults.js');
  const place = await defaultGeospatial.reverseGeocode?.(lat, lon);
  return (
    place?.locality ||
    place?.city ||
    place?.town ||
    place?.region ||
    place?.name ||
    null
  );
}

/**
 * @param {object} context - local tool context (see src/voice/tools/index.js)
 * @param {object} [seams] - test seams: sleep, now, download, geocoder
 */
export function createHandlers(
  context,
  {
    sleep = defaultSleep,
    now = Date.now,
    download = browserDownload,
    geocoder = defaultGeocoder,
  } = {},
) {
  const { getGlobe, runner, memory, speak } = context;
  let last = null; // { tour, scene, mode }
  let unsubscribe = null;
  let sequence = null; // fallback sequencer token

  const globe = () => {
    try {
      return getGlobe?.() || null;
    } catch {
      return null;
    }
  };
  const director = () => globe()?.sceneDirector || null;
  const shell = () => globe()?.styleManager || null;
  const say = (text) => {
    if (!text) return;
    try {
      const result = speak?.(text);
      if (typeof result?.catch === 'function') result.catch(() => {});
    } catch {
      /* narration is best effort */
    }
  };
  const toast = (text) => {
    try {
      shell()?._showToast?.(text);
    } catch {
      /* toast is best effort */
    }
  };

  function cameraState() {
    try {
      return shell()?.getCameraState?.() || null;
    } catch {
      return null;
    }
  }
  function visualState() {
    try {
      return shell()?.getVisualState?.() || null;
    } catch {
      return null;
    }
  }

  /** Analyst records for every tour layer that is on, flights enriched with airline. */
  function gatherRecords() {
    const dataManager = globe()?.dataManager;
    const records = {};
    if (!dataManager) return records;
    for (const layerId of TOUR_LAYERS) {
      if (!dataManager.isEnabled?.(layerId)) continue;
      const module = dataManager.layers?.get?.(layerId)?.module;
      if (typeof module?.getAnalystRecords !== 'function') continue;
      let rows = module.getAnalystRecords(RECORD_LIMIT) || [];
      if (
        (layerId === 'flights' || layerId === 'military') &&
        typeof module.getAllPositions === 'function'
      ) {
        const extras = new Map();
        for (const p of module.getAllPositions(RECORD_LIMIT) || [])
          extras.set(String(p.id), p);
        rows = rows.map((r) => {
          const extra = extras.get(String(r.icao24 || r.id));
          return {
            ...r,
            operator:
              r.operator ||
              extra?.airline ||
              airlineFromCallsign(r.callsign) ||
              null,
            routeOrigin: r.routeOrigin || extra?.origin || null,
            routeDestination: r.routeDestination || extra?.destination || null,
          };
        });
      }
      records[layerId] = rows;
    }
    return records;
  }

  /** Turn the theme's layer on and wait briefly for its first snapshot. */
  async function ensureLayer(theme) {
    const layerId = TOUR_THEMES[theme]?.layer;
    const dataManager = globe()?.dataManager;
    if (!layerId || !dataManager) return { layerId, enabled: false };
    let enabled = !!dataManager.isEnabled?.(layerId);
    if (!enabled && runner) {
      try {
        const result = await runner(
          'set_layer_visibility',
          { layerId, enabled: true },
          {},
        );
        enabled = result?.ok !== false;
      } catch {
        enabled = false;
      }
    }
    if (!enabled) return { layerId, enabled: false };
    const started = now();
    for (let poll = 0; poll < 20 && now() - started < DATA_WAIT_MS; poll++) {
      if ((gatherRecords()[layerId] || []).length) break;
      await sleep(400);
    }
    return { layerId, enabled: true };
  }

  async function placeNameFor(lat, lon) {
    if (nearestHub(lat, lon)) return null;
    try {
      return await Promise.race([
        geocoder(lat, lon),
        sleep(GEOCODE_WAIT_MS).then(() => null),
      ]);
    } catch {
      return null;
    }
  }

  function stopNarration() {
    unsubscribe?.();
    unsubscribe = null;
  }

  /** Speak each shot's line when the Director reports that shot starting. */
  function attachNarration(sceneDirector, tour, narrateLines) {
    stopNarration();
    if (typeof sceneDirector.subscribe !== 'function') return false;
    const lines = new Map(tour.narration.map((n) => [n.shotId, n]));
    const done = new Set([
      'scene_run_complete',
      'scene_stopped',
      'scene_run_error',
    ]);
    unsubscribe = sceneDirector.subscribe(
      ({ change }) => {
        if (change?.type !== 'run-event') return;
        if (change.event === 'shot_start') {
          if (change.detail?.sceneId !== tour.scene.id) return;
          const entry = lines.get(change.detail?.shotId);
          if (!entry) return;
          if (narrateLines) say(entry.line);
          else toast(entry.title);
        } else if (done.has(change.event)) stopNarration();
      },
      { emitCurrent: false },
    );
    return true;
  }

  /**
   * Replace the project's previous auto tour with `scene` through the
   * Director's validated import seam. Returns true when the document landed.
   */
  async function loadScene(sceneDirector, scene, { dropIds = [] } = {}) {
    const current = sceneDirector?._project;
    if (
      !current ||
      !Array.isArray(current.scenes) ||
      typeof sceneDirector.importProjectFile !== 'function'
    )
      return false;
    const drop = new Set([scene.id, ...dropIds]);
    const project = {
      ...structuredClone(current),
      scenes: [
        ...current.scenes.filter((s) => !drop.has(s.id)),
        structuredClone(scene),
      ],
    };
    let text;
    try {
      text = stringifySceneDocument(project);
    } catch {
      return false;
    }
    const assets = sceneDirector._bundleAssets?.snapshot?.() ?? new Map();
    const ok = await sceneDirector.importProjectFile(
      { name: 'Auto-Director tour', text: async () => text },
      {
        prepared: { project, assets },
        selection: { sceneId: scene.id, shotId: scene.shots[0]?.id || null },
      },
    );
    return ok === true;
  }

  /** Fallback: fly the shell camera through the shots with timed holds. */
  async function runSequence(tour, narrateLines) {
    const token = { cancelled: false };
    sequence = token;
    const camera = shell();
    (async () => {
      for (const [index, shot] of tour.scene.shots.entries()) {
        if (token.cancelled) return;
        const line = tour.narration[index];
        if (narrateLines) say(line.line);
        else toast(line.title);
        camera?.applyCameraState?.(shot.camera, shot.durationSec);
        await sleep((shot.durationSec + shot.holdSec) * 1000);
      }
      if (sequence === token) sequence = null;
    })().catch(() => {
      if (sequence === token) sequence = null;
    });
    return token;
  }

  function stopSequence() {
    if (sequence) sequence.cancelled = true;
    sequence = null;
  }

  return {
    async make_tour({ theme = 'airspace', seconds = 60, narrate = true } = {}) {
      const key = resolveTheme(theme);
      stopNarration();
      stopSequence();
      const layer = await ensureLayer(key);
      const records = gatherRecords();
      const camera = cameraState();
      const plan = pickFocus({ theme: key, records, camera });
      const named = plan.focus
        ? await placeNameFor(plan.focus.lat, plan.focus.lon)
        : null;
      const tour = buildTour({
        theme: key,
        seconds,
        records,
        camera,
        visual: visualState(),
        placeName: named ? () => named : null,
        now: now(),
      });
      if (!tour.ok) return tour;
      for (const h of tour.highlights || [])
        memory?.noteTarget?.({
          kind: tour.theme === 'ships' ? 'vessel' : 'aircraft',
          id: h.id,
          label: h.label,
          layerId: h.layer,
        });

      const sceneDirector = director();
      let mode = 'camera-sequence';
      if (sceneDirector) {
        const loaded = await loadScene(sceneDirector, tour.scene);
        if (loaded && typeof sceneDirector.startScene === 'function') {
          attachNarration(sceneDirector, tour, narrate !== false);
          const run = sceneDirector.startScene(tour.scene.id, { single: true });
          const early = await Promise.race([
            Promise.resolve(run).catch(() => null),
            sleep(250).then(() => undefined),
          ]);
          if (early && early.started === false) {
            stopNarration();
            return {
              ok: false,
              error: `The Director refused to start the tour (${early.reason || 'unknown'})`,
            };
          }
          mode = 'director';
        }
      }
      if (mode === 'camera-sequence') {
        if (!shell()?.applyCameraState)
          return { ok: false, error: 'Camera control unavailable' };
        await runSequence(tour, narrate !== false);
      }
      last = { tour, scene: tour.scene, mode };
      return {
        ok: true,
        mode,
        theme: tour.theme,
        layer: tour.layer,
        place: tour.place,
        durationSec: tour.durationSec,
        shots: tour.shots.map((s) => ({ title: s.title })),
        narrate: narrate !== false,
        saved: mode === 'director',
        sceneId: tour.scene.id,
        ...(tour.fallback
          ? {
              fallback: tour.fallback,
              note:
                tour.fallback === 'no-data'
                  ? `No ${TOUR_THEMES[key]?.noun || 'records'} loaded${layer.enabled ? '' : ' and the layer could not be enabled'}; orbiting the current view instead.`
                  : undefined,
            }
          : {}),
        hint: 'The tour is playing and narrating itself; reply with one short sentence.',
      };
    },

    async stop_tour() {
      const sceneDirector = director();
      const wasRunning = !!sceneDirector?.running || !!sequence;
      stopNarration();
      stopSequence();
      try {
        sceneDirector?.stopScene?.('Tour stopped by voice');
      } catch {
        /* nothing to stop */
      }
      try {
        globalThis.speechSynthesis?.cancel?.();
      } catch {
        /* no browser speech */
      }
      return { ok: true, wasRunning };
    },

    async save_tour({ name } = {}) {
      if (!last)
        return { ok: false, error: 'No tour to save; run make_tour first' };
      const title = String(name || '').trim() || last.scene.title;
      const slug = slugify(title);
      const id = `tour-${slug}`;
      const scene = {
        ...structuredClone(last.scene),
        id,
        title,
        shots: last.scene.shots.map((shot, i) => ({
          ...structuredClone(shot),
          id: `${id}-shot-${i + 1}`,
        })),
      };
      const sceneDirector = director();
      let persisted = false;
      if (sceneDirector) {
        try {
          persisted = await loadScene(sceneDirector, scene, {
            dropIds: [TOUR_SCENE_ID],
          });
        } catch {
          persisted = false;
        }
      }
      const stamp = new Date(now()).toISOString();
      const project = {
        version: SCENE_DOCUMENT_VERSION,
        createdAt: stamp,
        updatedAt: stamp,
        installedBuiltInSceneIds: [],
        scenes: [scene],
      };
      let downloaded = false;
      let bundle = null;
      let error;
      try {
        bundle = await createSceneBundle(project, async () => null);
        downloaded = !!download(bundle, `${slug}.gevbundle.json`);
      } catch (e) {
        error = e?.message || String(e);
      }
      last = { ...last, scene };
      return {
        ok: persisted || downloaded,
        name: title,
        sceneId: id,
        persisted,
        downloaded,
        ...(downloaded ? { file: `${slug}.gevbundle.json` } : {}),
        ...(error ? { error } : {}),
        bundleBytes: bundle ? bundle.length : 0,
      };
    },
  };
}
