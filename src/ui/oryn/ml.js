// ORYN analytics foundation: typed model definitions, an inference-provider
// interface and a findings record. No model ships with the prototype; every
// definition below resolves to a provider whose status is `not-configured`,
// and the UI renders that state instead of inventing detections.
import { msg } from '../../i18n/index.js';

/**
 * @typedef {object} ModelDefinition
 * @property {string} id Stable identifier, e.g. `vehicle-count`
 * @property {string} name
 * @property {string} version Model version identifier reported by the provider
 * @property {string} task One of MODEL_TASKS
 * @property {{kind:string,description:string}} input
 * @property {{kind:string,description:string}} output
 * @property {string} description
 */

export const MODEL_TASKS = Object.freeze([
  'object-detection',
  'object-counting',
  'change-detection',
  'segmentation',
  'anomaly-detection',
  'event-correlation',
]);

export const MODEL_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'vehicle-count',
    name: 'Vehicle detection and counting',
    version: 'unconfigured',
    task: 'object-counting',
    input: {
      kind: 'video-frame',
      description: 'Authorized camera frame with timestamp and camera pose',
    },
    output: {
      kind: 'detections',
      description: 'Bounding boxes with class, count and optional confidence',
    },
    description:
      'Counts vehicles in authorized camera frames and aggregates traffic flow over time.',
  }),
  Object.freeze({
    id: 'fire-smoke',
    name: 'Fire and smoke detection',
    version: 'unconfigured',
    task: 'object-detection',
    input: { kind: 'video-frame', description: 'Authorized camera frame' },
    output: {
      kind: 'detections',
      description: 'Fire or smoke regions with optional confidence',
    },
    description:
      'Flags candidate fire or smoke in camera imagery for analyst review.',
  }),
  Object.freeze({
    id: 'scene-change',
    name: 'Multi-temporal change detection',
    version: 'unconfigured',
    task: 'change-detection',
    input: {
      kind: 'image-pair',
      description: 'Two georeferenced images of the same footprint',
    },
    output: {
      kind: 'change-mask',
      description: 'Candidate change polygons with per-region magnitude',
    },
    description:
      'Compares two satellite or aerial observations and proposes candidate changes.',
  }),
  Object.freeze({
    id: 'flood-extent',
    name: 'Flood extent analysis',
    version: 'unconfigured',
    task: 'segmentation',
    input: {
      kind: 'image',
      description: 'Georeferenced optical or SAR scene',
    },
    output: { kind: 'polygons', description: 'Candidate inundated area' },
    description:
      'Estimates inundated area from imagery; results require analyst review.',
  }),
  Object.freeze({
    id: 'vegetation-index',
    name: 'Vegetation index trend',
    version: 'unconfigured',
    task: 'anomaly-detection',
    input: {
      kind: 'image-series',
      description: 'Multispectral observations over a field boundary',
    },
    output: {
      kind: 'time-series',
      description: 'NDVI or NDMI values per observation date with flags',
    },
    description:
      'Tracks NDVI and NDMI over time per field. NDMI responds to canopy water content; it is not a soil-moisture measurement.',
  }),
  Object.freeze({
    id: 'event-correlation',
    name: 'Geospatial event correlation',
    version: 'unconfigured',
    task: 'event-correlation',
    input: {
      kind: 'event-set',
      description: 'Public events, camera observations and analyst notes',
    },
    output: {
      kind: 'links',
      description: 'Proposed links between events with supporting evidence',
    },
    description:
      'Proposes relationships between events in space and time for analyst confirmation.',
  }),
]);

/**
 * @typedef {object} InferenceProvider
 * @property {string} id
 * @property {string} label
 * @property {'ready'|'not-configured'|'error'} status
 * @property {string|null} setupHint
 * @property {string[]} modelIds Models this provider can run
 * @property {(request:{modelId:string,input:any,signal?:AbortSignal}) => Promise<Finding[]>} run
 */

/**
 * @typedef {object} Finding
 * @property {string} id
 * @property {string} modelId
 * @property {string} modelVersion
 * @property {string} providerId
 * @property {'queued'|'running'|'complete'|'failed'} status
 * @property {string} createdAt
 * @property {string|null} completedAt
 * @property {'model'} provenance Always `model`
 * @property {{kind:string,id:string}|null} sourceAsset
 * @property {number|null} confidence Only when the model produced one
 * @property {object|null} output
 * @property {string|null} error
 */

export function createInferenceProvider({
  id,
  label,
  status = 'not-configured',
  setupHint = null,
  modelIds = [],
  run,
}) {
  if (!id || !label)
    throw new TypeError('A provider id and label are required');
  return Object.freeze({
    id,
    label,
    status: ['ready', 'not-configured', 'error'].includes(status)
      ? status
      : 'error',
    setupHint,
    modelIds: Object.freeze([...modelIds]),
    async run(request) {
      if (status !== 'ready' || typeof run !== 'function')
        throw new Error(`Inference provider ${id} is not configured`);
      return run(request);
    },
  });
}

/** The only provider in the prototype: explicitly not configured. */
export function createUnconfiguredInferenceProvider() {
  return createInferenceProvider({
    id: 'none',
    label: msg('No inference backend'),
    status: 'not-configured',
    setupHint: msg(
      'Connect an inference service (server-side, with its own credentials) and register the models it serves. No model runs in this prototype and no findings are generated.',
    ),
    modelIds: MODEL_DEFINITIONS.map((model) => model.id),
  });
}

/** Resolve the provider that can run a model, or null with the reason. */
export function createInferenceRegistry(providers = []) {
  const list = providers.filter(Boolean);
  return Object.freeze({
    providers: Object.freeze([...list]),
    models: MODEL_DEFINITIONS,
    describe(modelId) {
      const model = MODEL_DEFINITIONS.find((entry) => entry.id === modelId);
      if (!model) return null;
      const provider =
        list.find(
          (entry) =>
            entry.status === 'ready' && entry.modelIds.includes(modelId),
        ) ?? null;
      const fallback = list.find((entry) => entry.modelIds.includes(modelId));
      return {
        model,
        provider,
        status: provider ? 'ready' : (fallback?.status ?? 'not-configured'),
        setupHint: provider ? null : (fallback?.setupHint ?? null),
      };
    },
  });
}
