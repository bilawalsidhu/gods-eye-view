// ORYN camera registry: a typed camera model, a provider interface for
// authorized sources, and a DEMO provider whose records are labeled as such.
//
// Rules this module enforces by construction:
// - A camera only has a `stream` when a provider supplied a media URL AND
//   marked it verified; otherwise the UI shows a no-stream placeholder.
// - Demo records carry `demo: true` and are never reported as live.
// - Nothing here fetches video, scrapes pages or guesses stream URLs.
import { cleanText, isValidLatitude, isValidLongitude } from './store.js';
import { cleanUrl } from './models.js';
import { msg } from '../../i18n/index.js';

export const CAMERA_STATUSES = Object.freeze([
  'unknown',
  'online',
  'offline',
  'unconfigured',
]);

export const STREAM_KINDS = Object.freeze(['hls', 'mp4', 'webm', 'mjpeg']);

export const AUTHORIZATION_KINDS = Object.freeze([
  'public-metadata',
  'organization',
  'unconfigured',
]);

/**
 * @typedef {object} CameraRecord
 * @property {string} id
 * @property {string} name
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} headingDeg
 * @property {number|null} fovDeg
 * @property {'unknown'|'online'|'offline'|'unconfigured'} status
 * @property {string|null} lastSeenAt ISO time the provider last confirmed the camera
 * @property {{id:string,label:string,url:string|null,authorization:string}} source
 * @property {{kind:string,url:string,verified:boolean}|null} stream
 * @property {string|null} snapshotUrl A still image URL, only when supplied
 * @property {boolean} demo
 * @property {string[]} eventRefs Ids of events associated by a provider or analyst
 */

/** Validate a camera record; returns null when the record is unusable. */
export function validateCamera(value) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanText(value.id, 128);
  const name = cleanText(value.name, 200);
  if (!id || !name) return null;
  if (!isValidLatitude(value.lat) || !isValidLongitude(value.lon)) return null;
  const source =
    value.source && typeof value.source === 'object' ? value.source : {};
  const authorization = AUTHORIZATION_KINDS.includes(source.authorization)
    ? source.authorization
    : 'unconfigured';
  let stream = null;
  if (value.stream && typeof value.stream === 'object') {
    const url = cleanUrl(value.stream.url);
    const kind = STREAM_KINDS.includes(value.stream.kind)
      ? value.stream.kind
      : null;
    if (url && kind && value.stream.verified === true)
      stream = { kind, url, verified: true };
  }
  const status = CAMERA_STATUSES.includes(value.status)
    ? value.status
    : 'unknown';
  return {
    id,
    name,
    lat: value.lat,
    lon: value.lon,
    headingDeg: Number.isFinite(value.headingDeg) ? value.headingDeg : null,
    fovDeg: Number.isFinite(value.fovDeg) ? value.fovDeg : null,
    status: stream ? status : status === 'online' ? 'unknown' : status,
    lastSeenAt:
      typeof value.lastSeenAt === 'string' &&
      !Number.isNaN(Date.parse(value.lastSeenAt))
        ? value.lastSeenAt
        : null,
    source: {
      id: cleanText(source.id, 64) || 'unknown',
      label: cleanText(source.label, 200) || msg('Unknown source'),
      url: cleanUrl(source.url),
      authorization,
    },
    stream,
    snapshotUrl: cleanUrl(value.snapshotUrl),
    demo: value.demo === true,
    eventRefs: Array.isArray(value.eventRefs)
      ? value.eventRefs.map((ref) => cleanText(ref, 128)).filter(Boolean)
      : [],
  };
}

/**
 * Provider interface. Implementations list cameras for an authorized source.
 * @typedef {object} CameraProvider
 * @property {string} id
 * @property {string} label
 * @property {'ready'|'not-configured'|'error'} status
 * @property {string|null} setupHint What is needed to activate the provider
 * @property {(options?:{signal?:AbortSignal}) => Promise<CameraRecord[]>} list
 */

/** Create a provider from a plain object, validating its shape. */
export function createCameraProvider({
  id,
  label,
  status = 'ready',
  setupHint = null,
  list,
}) {
  if (!id || !label)
    throw new TypeError('A provider id and label are required');
  if (typeof list !== 'function')
    throw new TypeError('A provider list() is required');
  return Object.freeze({
    id,
    label,
    status: ['ready', 'not-configured', 'error'].includes(status)
      ? status
      : 'error',
    setupHint,
    async list(options = {}) {
      const records = await list(options);
      return (Array.isArray(records) ? records : [])
        .map(validateCamera)
        .filter(Boolean);
    },
  });
}

/** Records for UI preview only. Every one is labeled DEMO and has no stream. */
export const DEMO_CAMERAS = Object.freeze([
  {
    id: 'demo-cam-001',
    name: 'DEMO · Main St & 4th Ave (intersection)',
    lat: 30.2669,
    lon: -97.7428,
    headingDeg: 45,
    fovDeg: 70,
    status: 'unconfigured',
    source: {
      id: 'demo',
      label: msg('Demo registry (not a real camera)'),
      url: null,
      authorization: 'unconfigured',
    },
    stream: null,
    demo: true,
    eventRefs: [],
  },
  {
    id: 'demo-cam-002',
    name: 'DEMO · River crossing (flood watch)',
    lat: 30.2516,
    lon: -97.7211,
    headingDeg: 190,
    fovDeg: 60,
    status: 'unconfigured',
    source: {
      id: 'demo',
      label: msg('Demo registry (not a real camera)'),
      url: null,
      authorization: 'unconfigured',
    },
    stream: null,
    demo: true,
    eventRefs: [],
  },
  {
    id: 'demo-cam-003',
    name: 'DEMO · Public works yard gate',
    lat: 30.2859,
    lon: -97.7596,
    headingDeg: 300,
    fovDeg: 90,
    status: 'unconfigured',
    source: {
      id: 'demo',
      label: msg('Demo registry (not a real camera)'),
      url: null,
      authorization: 'unconfigured',
    },
    stream: null,
    demo: true,
    eventRefs: [],
  },
  {
    id: 'demo-cam-004',
    name: 'DEMO · Transit hub platform',
    lat: 30.2634,
    lon: -97.7334,
    headingDeg: 120,
    fovDeg: 80,
    status: 'unconfigured',
    source: {
      id: 'demo',
      label: msg('Demo registry (not a real camera)'),
      url: null,
      authorization: 'unconfigured',
    },
    stream: null,
    demo: true,
    eventRefs: [],
  },
]);

export function createDemoCameraProvider() {
  return createCameraProvider({
    id: 'demo',
    label: msg('Demo camera registry'),
    status: 'ready',
    setupHint: msg(
      'Demo records only. Connect an organization camera registry or an authorized stream provider to replace them.',
    ),
    list: async () => DEMO_CAMERAS.map((record) => ({ ...record })),
  });
}

/**
 * Placeholder for an organization-owned registry. It is listed so the UI can
 * explain what is missing; it never returns cameras until configured.
 */
export function createUnconfiguredOrganizationProvider() {
  return createCameraProvider({
    id: 'organization',
    label: msg('Organization camera registry'),
    status: 'not-configured',
    setupHint: msg(
      'Requires an authorized registry endpoint and credentials provisioned server-side. No endpoint is configured in this prototype.',
    ),
    list: async () => [],
  });
}

/**
 * Wrap the engine's CCTV layer as a read-only metadata provider. Records are
 * camera poses only; the engine owns frame loading and the UI never claims a
 * stream exists for them.
 */
export function createEngineCctvProvider(getLayerModule) {
  return createCameraProvider({
    id: 'engine-cctv',
    label: msg('Public camera poses (engine CCTV layer)'),
    status: 'ready',
    setupHint: msg(
      'Camera poses come from the existing public CCTV layer. Frames are loaded by that layer when it is enabled; this registry lists metadata only.',
    ),
    list: async () => {
      const module = getLayerModule?.();
      const objects = module?.getDetectableObjects?.({ limit: 500 }) ?? [];
      return objects
        .map((object) => {
          const camera = object?.camera || object;
          const lat = Number(camera?.lat ?? object?.latitude);
          const lon = Number(camera?.lon ?? object?.longitude);
          const id = camera?.id ?? object?.id;
          if (!id || !Number.isFinite(lat) || !Number.isFinite(lon))
            return null;
          return {
            id: `cctv:${id}`,
            name: camera?.name || object?.label || `Camera ${id}`,
            lat,
            lon,
            headingDeg: Number.isFinite(camera?.headingDeg)
              ? camera.headingDeg
              : null,
            fovDeg: Number.isFinite(camera?.fovDeg) ? camera.fovDeg : null,
            status: 'unknown',
            source: {
              id: 'engine-cctv',
              label: msg('Public CCTV metadata via engine layer'),
              url: null,
              authorization: 'public-metadata',
            },
            stream: null,
            demo: false,
            eventRefs: [],
          };
        })
        .filter(Boolean);
    },
  });
}

/** Aggregate providers; failures are recorded per provider, never hidden. */
export function createCameraRegistry(providers = []) {
  const list = providers.filter(Boolean);
  let cache = { cameras: [], providerStates: [], loadedAt: null };
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener(cache);
      } catch (error) {
        console.warn('[ORYN] camera registry listener failed', error);
      }
    }
  };
  return Object.freeze({
    providers: Object.freeze([...list]),
    get snapshot() {
      return cache;
    },
    async refresh({ signal } = {}) {
      const cameras = [];
      const providerStates = [];
      for (const provider of list) {
        if (provider.status !== 'ready') {
          providerStates.push({
            id: provider.id,
            label: provider.label,
            status: provider.status,
            setupHint: provider.setupHint,
            count: 0,
            error: null,
          });
          continue;
        }
        try {
          const records = await provider.list({ signal });
          cameras.push(...records);
          providerStates.push({
            id: provider.id,
            label: provider.label,
            status: 'ready',
            setupHint: provider.setupHint,
            count: records.length,
            error: null,
          });
        } catch (error) {
          providerStates.push({
            id: provider.id,
            label: provider.label,
            status: 'error',
            setupHint: provider.setupHint,
            count: 0,
            error: error?.message || String(error),
          });
        }
      }
      cache = { cameras, providerStates, loadedAt: Date.now() };
      notify();
      return cache;
    },
    find: (id) => cache.cameras.find((camera) => camera.id === id) ?? null,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
