import { exportIncident, INCIDENTS_ENDPOINT } from '../incidents.js';

/**
 * Incident replay tool pack: `export_incident` freezes the current view into
 * a self-contained HTML evidence file (screenshot, nearby tracks, replay
 * scrubber, transcript, alerts) saved under .gev-logs/incidents/ and offered
 * as a download; `list_incidents` lists the saved bundles.
 */
/** Result timeouts (ms) the server should allow for these tools. */
export const timeouts = Object.freeze({ export_incident: 60_000 });

export const schemas = [
  {
    name: 'export_incident',
    description:
      'Save an incident replay bundle for what is on screen now: a screenshot, every aircraft and ship track near the camera over the last few minutes with a replay slider, the recent transcript and alerts, as one HTML file. Use for "export this", "save this incident", "make a report of what just happened". Title is optional.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Short title spoken by the user, if any.',
        },
        minutes: {
          type: 'number',
          minimum: 0.5,
          maximum: 15,
          description: 'Minutes of history to include around now (default 5).',
        },
        radiusKm: {
          type: 'number',
          minimum: 1,
          maximum: 500,
          description:
            'Include tracks within this distance of the camera (default 50).',
        },
      },
    },
  },
  {
    name: 'list_incidents',
    description:
      'List previously saved incident replay bundles (newest first).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export function createHandlers(context = {}) {
  const { camera, captureImage, fetchJson } = context;
  return {
    async export_incident({ title, minutes, radiusKm } = {}) {
      const overrides = {};
      if (typeof camera === 'function') overrides.camera = camera;
      if (typeof captureImage === 'function')
        overrides.captureImage = captureImage;
      if (typeof fetchJson === 'function') overrides.fetchJson = fetchJson;
      if (context.history !== undefined) overrides.history = context.history;
      if (context.diagnostics !== undefined)
        overrides.diagnostics = context.diagnostics;
      if (context.download !== undefined) overrides.download = context.download;
      if (typeof context.now === 'function') overrides.now = context.now;
      const result = await exportIncident(
        { title, minutes, radiusKm },
        overrides,
      );
      if (result.ok && typeof context.speak === 'function' && !result.tracks)
        context.speak('Saved, but no tracks were inside the radius.');
      return result;
    },
    async list_incidents() {
      const fetch = typeof fetchJson === 'function' ? fetchJson : null;
      if (!fetch) return { ok: false, error: 'Server access unavailable' };
      const data = await fetch(INCIDENTS_ENDPOINT);
      const incidents = Array.isArray(data?.incidents) ? data.incidents : [];
      return { ok: true, count: incidents.length, incidents };
    },
  };
}
