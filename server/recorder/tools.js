import { defineTool, ToolError } from '../../src/tools/catalog.js';
import { LIMIT_SCHEMA, capRows } from '../../src/tools/results.js';

const LAYERS = ['air', 'mil', 'vessel'];
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
  description: 'Layers to include: air, mil (military) or vessel. Default all.',
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

export const historyTools = Object.freeze([
  historyWindow,
  historyTrack,
  replayTo,
]);
