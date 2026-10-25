import { defineTool, ToolError } from '../../src/tools/catalog.js';
import { LIMIT_SCHEMA, capRows } from '../../src/tools/results.js';

const LAYERS = ['air', 'mil', 'vessel', 'local'];
const TIME = {
  type: 'string',
  description: 'ISO 8601 time, e.g. 2026-10-25T14:00:00Z.',
};
const BBOX = {
  type: 'object',
  description: 'Area in degrees.',
  properties: {
    west: { type: 'number', minimum: -180, maximum: 180 },
    south: { type: 'number', minimum: -90, maximum: 90 },
    east: { type: 'number', minimum: -180, maximum: 180 },
    north: { type: 'number', minimum: -90, maximum: 90 },
  },
  required: ['west', 'south', 'east', 'north'],
  additionalProperties: false,
};
const LAYER_LIST = {
  type: 'array',
  description:
    'Layers to include: air, mil (military), vessel or local (your own ADS-B receivers). Default all.',
  items: { type: 'string', enum: LAYERS },
  maxItems: LAYERS.length,
};

const seconds = (iso, name) => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms))
    throw new ToolError('invalid_arguments', `${name} is not a valid time`);
  return Math.floor(ms / 1000);
};
const iso = (s) => new Date(s * 1000).toISOString();
const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const row = (p) => ({
  id: p.id,
  layer: p.layer,
  time: iso(p.ts),
  lat: round(p.lat, 5),
  lon: round(p.lon, 5),
  alt_m: round(p.alt, 0),
  heading: round(p.heading, 0),
  speed_ms: round(p.speed, 1),
});

async function history(services, path, params, signal) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v != null && v !== '') query.set(k, String(v));
  let response;
  try {
    response = await services.app.fetch(`/api/history/${path}?${query}`, {
      signal,
    });
  } catch {
    throw new ToolError('unavailable', 'The history recorder is not reachable');
  }
  if (!response.ok)
    throw new ToolError(
      'unavailable',
      'No history recorder is running. Start the server with GEV_RECORDER=1.',
    );
  return response.json();
}

const bboxParam = (b) => (b ? `${b.west},${b.south},${b.east},${b.north}` : '');
const layersParam = (l) => (l ? l.join(',') : '');

export const historyWindow = defineTool({
  name: 'history_window',
  title: 'History in an area',
  description:
    'Recorded positions of aircraft and ships in a time window, optionally ' +
    'limited to an area and layers. Covers only times the local recorder ran.',
  inputSchema: {
    type: 'object',
    properties: {
      from: TIME,
      to: TIME,
      bbox: BBOX,
      layers: LAYER_LIST,
      limit: LIMIT_SCHEMA,
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  requires: ['app'],
  async run(args, { services, signal }) {
    const body = await history(
      services,
      'window',
      {
        from: seconds(args.from, 'from'),
        to: seconds(args.to, 'to'),
        bbox: bboxParam(args.bbox),
        layers: layersParam(args.layers),
      },
      signal,
    );
    const ids = new Set(body.points.map((p) => p.id));
    const capped = capRows(body.points.map(row), args.limit);
    return {
      summary: `${body.points.length} recorded positions of ${ids.size} contacts.`,
      data: { contacts: ids.size, ...capped },
    };
  },
});

export const historyTrack = defineTool({
  name: 'history_track',
  title: 'Recorded track',
  description:
    'Recorded path of one contact (aircraft hex, or ship MMSI) in a time window, oldest first.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        maxLength: 32,
        description: 'ICAO24 hex or MMSI.',
      },
      from: TIME,
      to: TIME,
      limit: LIMIT_SCHEMA,
    },
    required: ['id', 'from', 'to'],
    additionalProperties: false,
  },
  requires: ['app'],
  async run(args, { services, signal }) {
    const body = await history(
      services,
      `track/${encodeURIComponent(args.id)}`,
      { from: seconds(args.from, 'from'), to: seconds(args.to, 'to') },
      signal,
    );
    return {
      summary: `${body.points.length} recorded positions for ${args.id}.`,
      data: { id: args.id, ...capRows(body.points.map(row), args.limit) },
    };
  },
});

export const replayTo = defineTool({
  name: 'replay_to',
  title: 'Where everything was',
  description:
    'Last recorded position of every contact at a past time (within 10 minutes before it), optionally limited to an area and layers.',
  inputSchema: {
    type: 'object',
    properties: {
      time: TIME,
      bbox: BBOX,
      layers: LAYER_LIST,
      limit: LIMIT_SCHEMA,
    },
    required: ['time'],
    additionalProperties: false,
  },
  requires: ['app'],
  async run(args, { services, signal }) {
    const body = await history(
      services,
      'at',
      {
        to: seconds(args.time, 'time'),
        bbox: bboxParam(args.bbox),
        layers: layersParam(args.layers),
      },
      signal,
    );
    return {
      summary: `${body.points.length} contacts were last seen near ${args.time}.`,
      data: capRows(body.points.map(row), args.limit),
    };
  },
});

async function send(services, path, init, signal) {
  let response;
  try {
    response = await services.app.fetch(`/api/history/${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
  } catch {
    throw new ToolError('unavailable', 'The history recorder is not reachable');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ToolError(
      response.status === 400 ? 'invalid_arguments' : 'unavailable',
      body.error ||
        'No history recorder is running. Start the server with GEV_RECORDER=1.',
    );
  return body;
}

const fenceRow = (f) => ({
  id: f.id,
  name: f.name,
  west: f.west,
  south: f.south,
  east: f.east,
  north: f.north,
  layers: f.layers,
  created: iso(f.created_ts),
});
const eventRow = (e) => ({
  time: iso(e.ts),
  fence: e.fence,
  fence_id: e.fence_id,
  contact: e.id,
  layer: e.layer,
  kind: e.kind,
  lat: round(e.lat, 5),
  lon: round(e.lon, 5),
});

export const geofenceAdd = defineTool({
  name: 'geofence_add',
  kind: 'action',
  title: 'Watch an area',
  description:
    'Create a named box that logs an event whenever a recorded contact enters or leaves it. ' +
    'Only positions recorded after it is created count. Read events with geofence_events.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      bbox: BBOX,
      layers: LAYER_LIST,
    },
    required: ['name', 'bbox'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  requires: ['app'],
  async run(args, { services, signal }) {
    const body = await send(
      services,
      'fences',
      {
        method: 'POST',
        body: JSON.stringify({
          name: args.name,
          ...args.bbox,
          layers: args.layers || [],
        }),
      },
      signal,
    );
    return {
      summary: `Watching "${args.name}" as fence ${body.id}.`,
      data: { id: body.id },
    };
  },
});

export const geofenceList = defineTool({
  name: 'geofence_list',
  title: 'Watched areas',
  description: 'List the areas being watched for contacts entering or leaving.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requires: ['app'],
  async run(_args, { services, signal }) {
    const body = await send(services, 'fences', { method: 'GET' }, signal);
    return {
      summary: `${body.fences.length} watched areas.`,
      data: { fences: body.fences.map(fenceRow) },
    };
  },
});

export const geofenceEvents = defineTool({
  name: 'geofence_events',
  title: 'Area alerts',
  description: 'Recent enter and exit events from watched areas, newest first.',
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        ...TIME,
        description: 'Only events after this ISO 8601 time. Default all.',
      },
      fence_id: { type: 'integer', minimum: 1 },
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['app'],
  async run(args, { services, signal }) {
    const query = new URLSearchParams();
    if (args.since) query.set('since', String(seconds(args.since, 'since')));
    if (args.fence_id) query.set('fence', String(args.fence_id));
    const body = await send(
      services,
      `events?${query}`,
      { method: 'GET' },
      signal,
    );
    return {
      summary: `${body.events.length} area events.`,
      data: capRows(body.events.map(eventRow), args.limit),
    };
  },
});

export const geofenceRemove = defineTool({
  name: 'geofence_remove',
  kind: 'action',
  title: 'Stop watching an area',
  description:
    'Remove a watched area by its id. Its past events stay until they age out.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'integer', minimum: 1 } },
    required: ['id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  requires: ['app'],
  async run(args, { services, signal }) {
    await send(services, `fences/${args.id}`, { method: 'DELETE' }, signal);
    return {
      summary: `Stopped watching fence ${args.id}.`,
      data: { id: args.id },
    };
  },
});

export const historyTools = Object.freeze([
  historyWindow,
  historyTrack,
  replayTo,
  geofenceAdd,
  geofenceList,
  geofenceEvents,
  geofenceRemove,
]);
