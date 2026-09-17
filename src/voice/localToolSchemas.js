/**
 * Tools that exist only on the local (Ollama) voice path. The server appends
 * them to the shared GEV tool list; the browser adapter serves them itself
 * (memory, watch alerts, vision, data reports, time travel) before falling
 * back to the upstream action runner. Kept terse: every word here is prompt.
 */
const LAYERS = [
  'flights',
  'military',
  'ais-live-vessels',
  'earthquakes',
  'local-firms',
  'cctv',
];

const FILTER = {
  type: 'array',
  description:
    'AND-ed conditions on record fields. Fields: flights/military: callsign, operator (airline), aircraftType, altitudeM, speedMps, heading, onGround, originCountry, routeOrigin, routeDestination, aircraftClass, distanceKm; ais-live-vessels: name, speedKts, courseDeg, shipType, destination, distanceKm; earthquakes: mag, place, depth; local-firms: frp, confidence.',
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

const SCOPE = {
  type: 'object',
  additionalProperties: false,
  description:
    'Where to look. view = what the camera sees now; radius = km around a point (omit latitude/longitude to mean "here", the current camera position); anywhere = all loaded records. Distance is handled by scope; never add a distance filter.',
  properties: {
    kind: { type: 'string', enum: ['view', 'radius', 'anywhere'] },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    km: { type: 'number', minimum: 1, maximum: 5000 },
  },
  required: ['kind'],
};

import { packSchemas, packTimeouts } from './tools/index.js';

const CORE_TOOL_SCHEMAS = [
  {
    name: 'remember_place',
    description:
      'Save the current camera view under the name the user says: "remember this place as home" -> name "home"; "call this my marina" -> name "marina". Never ask for a name that was already spoken.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: 'Short label chosen by the user.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'go_to_saved_place',
    description:
      'Fly to a place the user previously saved with remember_place ("take me home", "back to the office"). Use list_saved_places if unsure of the name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'list_saved_places',
    description: 'List the names of saved places.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'forget_place',
    description: 'Delete a saved place by name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'recall_recent_target',
    description:
      'Look up things the assistant recently flew to or tracked, including earlier sessions ("that ship from yesterday", "the plane we followed"). Returns ids and labels; then call track_entity or fly_to_location with them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['aircraft', 'vessel', 'satellite', 'place', 'any'],
        },
        query: {
          type: 'string',
          description: 'Optional words to match against labels.',
        },
      },
    },
  },
  {
    name: 'ask_about_view',
    description:
      'Answer a VISUAL question about what is on screen right now by looking at a screenshot: read signs or labels, describe terrain or buildings, judge a camera feed ("is that a tanker", "how is traffic on that camera", "what does the sign say", "describe what you see"). Do not use for data questions; use get_entity_context or data_report for those.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: {
          type: 'string',
          description: 'The visual question in the user’s words.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'data_report',
    description:
      'Use this, not analyst_query, for any question that asks which, most, how many, average, busiest, or by airline/type/country: it groups and counts loaded live data ("which airlines are over Texas", "how many ships under 8 knots near Rotterdam", "busiest camera cluster in Europe", "average altitude of flights in view"). Returns groups with counts or a metric plus the nearest items. cctv supports count grouped by cell for density questions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layer: { type: 'string', enum: LAYERS },
        scope: SCOPE,
        filters: FILTER,
        groupBy: {
          type: 'string',
          description:
            'Field to group by (operator, originCountry, aircraftClass, shipType, destination, place) or "cell" for a 1-degree grid density.',
        },
        metric: { type: 'string', enum: ['count', 'avg', 'min', 'max', 'sum'] },
        field: {
          type: 'string',
          description: 'Numeric field for avg/min/max/sum.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['layer', 'scope'],
    },
  },
  {
    name: 'watch_add',
    description:
      'Create a standing alert. The assistant speaks up when a NEW record matches: "tell me when a plane comes within 20 km of here" -> scope {kind:"radius", km:20} and no filters; "alert me on quakes over magnitude 5" -> filters [{field:"mag",op:"gte",value:5}]; "warn me if a ship in view drops under 3 knots" -> scope view plus speedKts lt 3. Alerts persist across sessions until cleared.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layer: { type: 'string', enum: LAYERS.filter((l) => l !== 'cctv') },
        description: {
          type: 'string',
          description: 'Short spoken label, e.g. "plane near home".',
        },
        scope: SCOPE,
        filters: FILTER,
        once: {
          type: 'boolean',
          description: 'Remove the watch after its first alert.',
        },
      },
      required: ['layer', 'description', 'scope'],
    },
  },
  {
    name: 'watch_list',
    description: 'List active alerts (watches).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'watch_clear',
    description: 'Remove one alert by id, or all alerts when id is omitted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'rewind_time',
    description:
      'Replay the last minutes of aircraft and ship positions ("rewind ten minutes", "go back five minutes and play at 4x"). Live layers pause while rewound.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minutes: { type: 'number', minimum: 0.5, maximum: 15 },
        rate: {
          type: 'number',
          description: '0 pause, 1 real time, 4 or 16 fast.',
        },
      },
      required: ['minutes'],
    },
  },
  {
    name: 'resume_live',
    description: 'Leave rewind mode and return to live positions.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export const LOCAL_TOOL_SCHEMAS = Object.freeze([
  ...CORE_TOOL_SCHEMAS,
  ...packSchemas(),
]);

export const LOCAL_TOOL_NAMES = Object.freeze(
  LOCAL_TOOL_SCHEMAS.map((tool) => tool.name),
);

export function isLocalTool(name) {
  return LOCAL_TOOL_NAMES.includes(name);
}

/**
 * How long the server waits for a tool_result before giving up, per tool.
 * Tools not listed here get the default (10 s). Vision and multi-frame
 * sweeps run the local vision model and can take a minute or more.
 */
export const LOCAL_TOOL_TIMEOUTS = Object.freeze({
  ask_about_view: 60_000,
  data_report: 20_000,
  ...packTimeouts(),
});
