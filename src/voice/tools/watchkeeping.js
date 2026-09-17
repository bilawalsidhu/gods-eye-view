import { createAnomalyEngine, ANOMALY_KINDS } from '../anomalyEngine.js';
import { createPatrolEngine } from '../patrolEngine.js';
import { createGeofenceEngine } from '../geofenceEngine.js';
import { haversineKm } from '../watchEngine.js';

/**
 * Tool pack: autonomous patrols, anomaly detection and geofences. The three
 * engines start when the pack is created (once the globe exists) and keep
 * running in the background; the tools read and configure them.
 */
const LAYERS = [
  'flights',
  'military',
  'ais-live-vessels',
  'earthquakes',
  'local-firms',
];
const SCOPE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['view', 'radius', 'anywhere'] },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    km: { type: 'number', minimum: 1, maximum: 5000 },
  },
  required: ['kind'],
};
const FILTERS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      field: { type: 'string' },
      op: {
        type: 'string',
        enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains'],
      },
      value: { type: ['string', 'number', 'boolean'] },
    },
    required: ['field', 'op', 'value'],
  },
};

export const schemas = Object.freeze([
  {
    name: 'patrol_start',
    description:
      'Start a standing mission that re-checks an area on a schedule and speaks a briefing with what changed (arrivals, departures, stopped ships, sharp climbs or descents, anomalies): "watch the Gulf for ships and brief me every 20 minutes", "patrol this view for military aircraft every 10 minutes". Call it ONCE per request; the first briefing is spoken automatically, so do not call patrol_brief or patrol_start again. Then just confirm in one sentence.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: 'Short mission name, e.g. "Gulf ships".',
        },
        layers: { type: 'array', items: { type: 'string', enum: LAYERS } },
        scope: SCOPE,
        filters: FILTERS,
        intervalMinutes: { type: 'number', minimum: 2, maximum: 120 },
        briefNow: {
          type: 'boolean',
          description: 'Speak the first briefing immediately (default true).',
        },
      },
      required: ['name', 'layers', 'scope'],
    },
  },
  {
    name: 'patrol_brief',
    description:
      'Run an EXISTING patrol now and speak its briefing ("brief me on the Gulf patrol"). Not needed right after patrol_start.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'patrol_list',
    description: 'List active patrols with their last briefing.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'patrol_stop',
    description:
      'Stop one patrol by name, or all patrols when name is omitted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'anomaly_list',
    description:
      'Anomalies detected automatically from position history: stopped vessels, rapid descents, orbiting aircraft, impossible position jumps (possible spoofing), vessels that went dark. Use for "anything unusual?", "any ships gone dark?".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...ANOMALY_KINDS] },
        minutes: { type: 'number', minimum: 1, maximum: 720 },
      },
    },
  },
  {
    name: 'anomaly_alerts',
    description:
      'Turn spoken anomaly alerts on or off ("stop announcing anomalies").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    },
  },
  {
    name: 'geofence_add',
    description:
      'Create a named geofence and count what enters and leaves it per hour: "draw a box around the harbor and count ships per hour" -> shape view (the current view box) or circle; "fence 15 km around here". Optionally alert on every entry.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        shape: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['view', 'circle', 'polygon'] },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            km: { type: 'number', minimum: 0.5, maximum: 2000 },
            points: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  latitude: { type: 'number' },
                  longitude: { type: 'number' },
                },
                required: ['latitude', 'longitude'],
              },
            },
          },
          required: ['kind'],
        },
        layers: { type: 'array', items: { type: 'string', enum: LAYERS } },
        alertOnEnter: { type: 'boolean' },
        draw: {
          type: 'boolean',
          description: 'Draw the fence on the map (default true).',
        },
      },
      required: ['name', 'shape', 'layers'],
    },
  },
  {
    name: 'geofence_report',
    description:
      'Counts per hour and who is inside a geofence now ("how many ships entered the harbor fence this hour?").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'geofence_list',
    description: 'List geofences.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'geofence_remove',
    description: 'Remove a geofence by name, or all when omitted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
    },
  },
]);

let engines = null;

export function getEngines() {
  return engines;
}

export function resetEnginesForTest() {
  engines?.anomalies?.destroy();
  engines?.patrols?.destroy();
  engines?.geofences?.destroy();
  engines = null;
}

function ensureEngines(context, factories = {}) {
  if (engines) return engines;
  const globe = context.getGlobe?.();
  const dataManager = globe?.dataManager;
  const getCamera = () => context.camera?.() || null;
  const toast = (text) => {
    try {
      globe?.styleManager?._showToast?.(text);
    } catch {
      /* best effort */
    }
  };
  const anomalies = (factories.createAnomalyEngine || createAnomalyEngine)({
    dataManager,
    isRelevant: (record) => nearCamera(record, getCamera()),
    onAnomaly: (record) => {
      if (record.nearby) toast(`⚠ ${record.text}`);
      if (record.spoken) context.speak?.(record.text, { kind: 'alert' });
    },
  });
  const patrols = (factories.createPatrolEngine || createPatrolEngine)({
    dataManager,
    getCamera,
    getAnomalies: () => anomalies.list({ minutes: 30, limit: 10 }),
    speak: (text) => context.speak?.(text, { kind: 'info' }),
  });
  const geofences = (factories.createGeofenceEngine || createGeofenceEngine)({
    dataManager,
    getCamera,
    onEnter: (event) => {
      toast(`⚠ ${event.text}`);
      context.speak?.(event.text, { kind: 'alert' });
    },
  });
  anomalies.start();
  patrols.start();
  geofences.start();
  engines = { anomalies, patrols, geofences };
  return engines;
}

export function createHandlers(context, factories = {}) {
  const e = ensureEngines(context, factories);
  return {
    async patrol_start(args) {
      try {
        return { ok: true, patrol: e.patrols.add(args) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    async patrol_brief({ name } = {}) {
      const patrol = e.patrols.find(name) || null;
      if (!patrol && name)
        return {
          ok: false,
          error: `No patrol named ${name}`,
          patrols: e.patrols.list().map((p) => p.name),
        };
      const target =
        patrol ||
        (e.patrols.list()[0] ? e.patrols.find(e.patrols.list()[0].id) : null);
      if (!target) return { ok: false, error: 'No patrols are running' };
      const { text } = e.patrols.run(target, { speakIt: false });
      return { ok: true, briefing: text, spokenByAssistant: true };
    },
    async patrol_list() {
      const list = e.patrols.list();
      return { ok: true, count: list.length, patrols: list };
    },
    async patrol_stop({ name } = {}) {
      return { ok: true, stopped: e.patrols.stop(name) };
    },
    async anomaly_list({ kind, minutes = 60 } = {}) {
      const list = e.anomalies.list({ kind: kind || null, minutes });
      return {
        ok: true,
        count: list.length,
        spokenAlerts: e.anomalies.spoken,
        anomalies: list,
      };
    },
    async anomaly_alerts({ enabled }) {
      return { ok: true, spokenAlerts: e.anomalies.setSpoken(enabled) };
    },
    async geofence_add({ draw = true, ...args }) {
      try {
        const fence = e.geofences.add(args);
        let drawn = false;
        if (draw && context.runner) {
          const raw = e.geofences.find(fence.id);
          try {
            await context.runner(
              'annotate_map',
              {
                annotations: [
                  {
                    type: 'area',
                    points: e.geofences.outline(raw).slice(0, 12),
                  },
                  {
                    type: 'label',
                    latitude: centroid(raw).lat,
                    longitude: centroid(raw).lon,
                    text: fence.name,
                  },
                ],
              },
              {},
            );
            drawn = true;
          } catch {
            drawn = false;
          }
        }
        return { ok: true, fence, drawn };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    async geofence_report({ name } = {}) {
      const fence = name
        ? e.geofences.find(name)
        : e.geofences.list()[0] && e.geofences.find(e.geofences.list()[0].id);
      if (!fence)
        return {
          ok: false,
          error: name ? `No geofence named ${name}` : 'No geofences yet',
        };
      return { ok: true, report: e.geofences.describe(fence) };
    },
    async geofence_list() {
      const list = e.geofences.list();
      return { ok: true, count: list.length, geofences: list };
    },
    async geofence_remove({ name } = {}) {
      return { ok: true, removed: e.geofences.remove(name) };
    },
  };
}

/**
 * An anomaly is worth interrupting for when it is within the camera's
 * neighbourhood: 200 km when zoomed in, growing with altitude up to 1500 km.
 * With no camera everything counts.
 */
export function nearCamera(record, camera) {
  if (!camera || !Number.isFinite(camera.lat) || !Number.isFinite(camera.lon))
    return true;
  if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon))
    return false;
  const altKm = Math.max(0, Number(camera.alt) || 0) / 1000;
  const radiusKm = Math.min(1500, Math.max(200, altKm * 0.6));
  return (
    haversineKm(record.lat, record.lon, camera.lat, camera.lon) <= radiusKm
  );
}

function centroid(fence) {
  if (fence.shape.kind === 'polygon') {
    const pts = fence.shape.points;
    return {
      lat: pts.reduce((s, p) => s + p[0], 0) / pts.length,
      lon: pts.reduce((s, p) => s + p[1], 0) / pts.length,
    };
  }
  return { lat: fence.shape.latitude, lon: fence.shape.longitude };
}
