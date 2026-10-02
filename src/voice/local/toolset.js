import { GEV_ACTION_SCHEMAS } from '../actionSchemas.js';
import { ACTION_DESCRIPTIONS } from '../actionDescriptions.js';
import { VOICE_LAYER_MANIFEST, voiceLayer } from '../layerManifest.js';

/** Actions with hand-tuned compact wording and argument projections. */
export const CORE_ACTIONS = Object.freeze([
  'set_layer_visibility',
  'fly_to_location',
  'adjust_camera_zoom',
  'zoom_to_globe',
  'set_visual_style',
  'set_hud',
  'track_entity',
  'stop_tracking',
  'analyst_query',
  'get_entity_context',
  'get_current_view_state',
  'annotate_map',
]);

/** Actions whose result is answered in words rather than a fixed reply. */
export const QUERY_ACTIONS = Object.freeze([
  'analyst_query',
  'get_entity_context',
  'get_current_view_state',
  'next_iss_pass',
  'next_satellite_pass',
]);

export const MORE_ACTIONS_TOOL = 'more_actions';

/**
 * Actions left out of the on-device prompt to keep its cached prefix small:
 * the Cyber sonar controls apply to one HUD theme only.
 */
export const LOCAL_EXCLUDED_ACTIONS = Object.freeze(['set_cyber_sonar']);

/** Actions the on-device model can call. */
export const LOCAL_ACTIONS = Object.freeze(
  GEV_ACTION_SCHEMAS.map((schema) => schema.name).filter(
    (name) => !LOCAL_EXCLUDED_ACTIONS.includes(name),
  ),
);

// Argument paths kept for the compact profile; everything else stays valid
// but is hidden from the model to keep the cached prompt short.
const COMPACT_ARGUMENTS = {
  fly_to_location: ['query', 'rangeM'],
  select_nearest_aircraft: ['layerId', 'locationQuery'],
  control_radio: [
    'action',
    'volumePct',
    'category',
    'locationId',
    'locationQuery',
    'country',
  ],
  next_iss_pass: [],
  next_satellite_pass: ['target', 'visibleOnly'],
  analyst_query: [
    'layers',
    'scope.kind',
    'scope.name',
    'scope.km',
    'filters.field',
    'filters.op',
    'filters.value',
    'sortBy',
    'sortDir',
    'limit',
    'followUp',
  ],
  annotate_map: [
    'annotations.type',
    'annotations.target',
    'annotations.label',
    'flyTo',
  ],
  get_entity_context: ['scope'],
};

// Enum values narrowed for the compact profile: routes and arrows need
// waypoint and destination arguments the compact projection leaves out.
const COMPACT_ENUMS = {
  annotate_map: { 'annotations.type': ['pin', 'highlight', 'area', 'label'] },
};

const COMPACT_REQUIRED = {
  fly_to_location: ['query'],
  select_nearest_aircraft: ['layerId', 'locationQuery'],
};

const COMPACT_DESCRIPTIONS = {
  set_layer_visibility: {
    description: 'Turn one map data layer on or off.',
    layerId:
      'fires/wildfires=local-firms, ships/boats/vessels=ais-live-vessels, datacenters=local-datacenters, dams=local-dams, undersea cables=telegeography-submarine-cables, space missions/launches=rocket-launches, street traffic=traffic, traffic cameras=cctv, military aircraft=military, license plate readers=alpr-cameras, my receiver=local-adsb.',
  },
  fly_to_location: {
    description:
      'Fly the camera to a named place: city, country, landmark, street or address.',
    query: 'The place exactly as the user named it, e.g. "Golden Gate Bridge".',
    rangeM: 'Only when the user gives a height or distance in meters.',
  },
  adjust_camera_zoom: {
    description: 'Zoom the camera in or out from the current view.',
    amount: 'little for "a bit", medium by default, lot for "way in/out".',
  },
  zoom_to_globe: {
    description:
      'Show the whole Earth: globe view, whole planet, zoom all the way out.',
  },
  set_visual_style: {
    description:
      'Change the visual filter. surveillance=night vision, thermal=heat/FLIR, retro=CRT, normal=default look.',
  },
  set_hud: {
    description: 'Show, hide or change the layout of the HUD overlay.',
    visible: 'on or off.',
  },
  track_entity: {
    description:
      'Follow a specific aircraft (callsign), ship (name) or satellite (name) with the camera.',
    query: 'Callsign, ship name or satellite name, e.g. "UAL428" or "ISS".',
  },
  stop_tracking: {
    description: 'Stop following the tracked aircraft, ship or satellite.',
  },
  analyst_query: {
    description:
      'Answer counts, lists and superlatives about loaded data: how many flights over Texas, biggest fire, fastest aircraft, ships headed to Oakland.',
    layers: 'Layers to search. fires=local-firms, ships=ais-live-vessels.',
    'scope.kind':
      'view=near the camera (default), region=a named state/country/area, radius=within km, anywhere=global.',
    'scope.name': 'Region name for kind=region, e.g. "Texas".',
    'filters.field':
      'altitudeM, speedMps, onGround, destination, magnitude, frp, name.',
    'filters.value': 'Altitude is meters: 40,000 ft = 12192.',
    sortBy: 'Field to sort by, e.g. altitudeM, speedMps, frp, distance.',
  },
  get_entity_context: {
    description:
      'Describe what the camera is looking at: the place, selected object and visible entities.',
  },
  get_current_view_state: {
    description:
      'Read the camera, style, HUD, tracked entity and enabled layers.',
  },
  select_nearest_aircraft: {
    description:
      'Only when the user names a place: turn on flights and select the nearest airborne aircraft to that place.',
    locationQuery: 'Place name, e.g. "Austin".',
  },
  show_data_layers_menu: {
    description:
      'Open the data layers menu, optionally at one layer row. Does not turn the layer on.',
  },
  set_panel_open: { description: 'Open or close a UI panel.' },
  set_context_mode: {
    description:
      'Context modes: contacts (live contacts), space-missions, or off.',
  },
  control_cockpit: {
    description: 'Cockpit view: enter, exit, next or previous aircraft.',
  },
  set_detection: {
    description:
      'Object detection overlay: on/off, sparse/balanced/dense mode or density percent.',
  },
  set_map_stack: {
    description:
      'Switch the basemap only when named: Bing aerial=bing-aerial, aerial with labels=bing-labels, OSM/road map=osm, Esri=esri-imagery, Google 3D/photorealistic=photoreal.',
  },
  set_post_processing: {
    description: 'Bloom and sharpen effects: on/off and intensity percent.',
  },
  control_scene: { description: 'Scenes: list, play, stop or next scene.' },
  control_cctv: {
    description:
      'Traffic cameras: next, previous, nearest, select a named camera, coverage or viewsheds.',
  },
  control_radio: {
    description:
      'Radio: play (turn on the radio), pause, resume, stop, next, previous, volume with volumePct, or select a station by category and place.',
  },
  frame_overhead: {
    description: 'Frame the aircraft, ships or satellites overhead in view.',
  },
  clear_annotations: {
    description:
      'Remove all map marks. Only when the user asks to clear the map.',
  },
  move_camera: {
    description: 'Camera motion: orbit, pan, tilt, rotate, or stop moving.',
  },
  fly_route: { description: 'Fly the camera along the drawn route.' },
  next_iss_pass: { description: 'When the ISS next passes over this view.' },
  next_satellite_pass: {
    description: 'When a named satellite next passes over this view.',
  },
  annotate_map: {
    description:
      'Mark places on the map: a pin on a spot, or an area outline for a building, park or district.',
    'annotations.type': 'pin for a spot, area for a building/park/district.',
    'annotations.target': 'Place name to mark, e.g. "Texas State Capitol".',
    'annotations.label': 'Short label to show.',
    flyTo: 'true only when the place is not already in view.',
  },
};

/**
 * Pointing ("this", "here") needs the turn's pointer snapshot, which only the
 * cloud adapter captures. The on-device profile therefore offers no pointer
 * sentinel: a model that cannot point is never told it can.
 */
const LOCAL_UNSUPPORTED_ENUM_VALUES = Object.freeze(['pointer']);

function withoutUnsupportedValues(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema.enum))
    schema.enum = schema.enum.filter(
      (value) => !LOCAL_UNSUPPORTED_ENUM_VALUES.includes(value),
    );
  for (const child of Object.values(schema.properties || {}))
    withoutUnsupportedValues(child);
  if (schema.items) withoutUnsupportedValues(schema.items);
  return schema;
}

/** Schemas by action name. */
export const ACTION_SCHEMA_BY_NAME = new Map(
  GEV_ACTION_SCHEMAS.map((schema) => [schema.name, schema]),
);

/**
 * Converts a canonical argument schema into the subset every local engine
 * accepts: type, description, properties, required, items and enum. Untyped
 * values become strings so strict chat templates cannot fail on them.
 */
export function normalizeSchema(schema) {
  const source = schema && typeof schema === 'object' ? schema : {};
  const out = {};
  const type = source.type || (source.properties ? 'object' : 'string');
  out.type = type;
  if (typeof source.description === 'string')
    out.description = source.description;
  if (Array.isArray(source.enum)) out.enum = source.enum.slice();
  if (type === 'object' && source.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(source.properties))
      out.properties[key] = normalizeSchema(value);
    const required = (source.required || []).filter(
      (key) => key in out.properties,
    );
    if (required.length) out.required = required;
  }
  if (type === 'array') out.items = normalizeSchema(source.items || {});
  return out;
}

function projectSchema(schema, paths) {
  if (!paths) return structuredClone(schema);
  const tree = {};
  for (const path of paths) {
    let node = tree;
    for (const key of path.split('.')) node = node[key] ||= {};
  }
  const project = (node, keep) => {
    if (node.type === 'array')
      return { ...node, items: project(node.items || {}, keep) };
    if (node.type !== 'object' || !node.properties) return { ...node };
    const properties = {};
    for (const [key, child] of Object.entries(keep)) {
      if (!node.properties[key]) continue;
      properties[key] = Object.keys(child).length
        ? project(node.properties[key], child)
        : { ...node.properties[key] };
    }
    const required = (node.required || []).filter((key) => key in properties);
    const result = { ...node, properties };
    if (required.length) result.required = required;
    else delete result.required;
    return result;
  };
  return project(structuredClone(schema), tree);
}

function describeArguments(schema, notes, prefix = '') {
  if (schema.type === 'array' && schema.items)
    describeArguments(schema.items, notes, prefix);
  if (schema.type !== 'object' || !schema.properties) return;
  for (const [key, child] of Object.entries(schema.properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (notes[path]) child.description = notes[path];
    else delete child.description;
    describeArguments(child, notes, path);
  }
}

function applyFullDescriptions(schema, metadata) {
  if (!metadata || typeof metadata !== 'object') return;
  if (typeof metadata.description === 'string')
    schema.description = metadata.description;
  if (metadata.parameters && schema.parameters)
    applyFullDescriptions(schema.parameters, metadata.parameters);
  if (metadata.properties && schema.properties) {
    for (const [key, child] of Object.entries(metadata.properties))
      if (schema.properties[key])
        applyFullDescriptions(schema.properties[key], child);
  }
  if (metadata.items && schema.items)
    applyFullDescriptions(schema.items, metadata.items);
}

/**
 * Builds one engine-neutral function declaration
 * ({name, description, parameters}) for an action.
 * @param {string} name
 * @param {{profile?: 'compact'|'full'}} [options]
 */
export function describeAction(name, { profile = 'compact' } = {}) {
  const schema = ACTION_SCHEMA_BY_NAME.get(name);
  if (!schema) throw new TypeError('Unknown action: ' + name);
  if (profile === 'full') {
    const full = structuredClone(schema);
    applyFullDescriptions(full, ACTION_DESCRIPTIONS[name]);
    return {
      name,
      description: full.description || '',
      parameters: withoutUnsupportedValues(normalizeSchema(full.parameters)),
    };
  }
  const notes = COMPACT_DESCRIPTIONS[name] || {};
  const parameters = withoutUnsupportedValues(
    normalizeSchema(projectSchema(schema.parameters, COMPACT_ARGUMENTS[name])),
  );
  if (COMPACT_REQUIRED[name]) parameters.required = COMPACT_REQUIRED[name];
  for (const [path, values] of Object.entries(COMPACT_ENUMS[name] || {})) {
    const node = schemaAt(parameters, path);
    if (node?.enum) node.enum = node.enum.filter((v) => values.includes(v));
  }
  describeArguments(parameters, notes);
  return {
    name,
    description:
      notes.description ||
      firstSentence(ACTION_DESCRIPTIONS[name]?.description || ''),
    parameters,
  };
}

function schemaAt(schema, path) {
  let node = schema;
  for (const key of path.split('.')) {
    if (node?.type === 'array') node = node.items;
    node = node?.properties?.[key];
  }
  return node || null;
}

/** One-line index entries for actions outside the core set. */
export function describeMoreActions(core = CORE_ACTIONS) {
  const names = LOCAL_ACTIONS.filter((name) => !core.includes(name));
  return {
    name: MORE_ACTIONS_TOOL,
    description:
      'Any other app control: ' +
      names.map((name) => `${name} (${shortPurpose(name)})`).join('; ') +
      '.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: names },
        request: {
          type: 'string',
          description: "The user's request, repeated verbatim.",
        },
      },
      required: ['action', 'request'],
    },
  };
}

/**
 * Tools for a local model turn, as OpenAI-style function tools
 * ({type:'function', function}) which LiteRT-LM and OpenAI-compatible
 * servers both accept.
 */
export function buildLocalTools({
  core = LOCAL_ACTIONS,
  profile = 'compact',
  includeMore = core.length < LOCAL_ACTIONS.length,
} = {}) {
  const tools = core.map((name) => describeAction(name, { profile }));
  if (includeMore) tools.push(describeMoreActions(core));
  return tools.map((declaration) => ({
    type: 'function',
    function: declaration,
  }));
}

const PURPOSES = {
  select_nearest_aircraft: 'find the nearest aircraft to a place',
  show_data_layers_menu: 'open the data layers menu',
  set_panel_open: 'open or close a panel',
  set_context_mode: 'contacts or space missions mode',
  control_cockpit: 'cockpit view',
  set_detection: 'object detection on/off/density',
  set_map_stack: 'basemap: Bing aerial, OSM, Esri, Google 3D',
  set_post_processing: 'bloom and sharpen',
  control_scene: 'play or stop scenes',
  control_cctv: 'traffic cameras, coverage, viewsheds',
  control_radio: 'play, pause, stop, volume radio',
  frame_overhead: 'frame aircraft, ships or satellites overhead',
  clear_annotations: 'clear the map marks',
  move_camera: 'orbit, pan, tilt or stop the camera',
  fly_route: 'fly along a drawn route',
  next_iss_pass: 'when the ISS passes over',
  next_satellite_pass: 'when a satellite passes over',
  set_layer_visibility: 'layers on or off',
  fly_to_location: 'fly to a place',
  adjust_camera_zoom: 'zoom in or out',
  zoom_to_globe: 'globe view',
  set_visual_style: 'visual filter',
  set_hud: 'HUD',
  track_entity: 'follow an entity',
  stop_tracking: 'stop following',
  analyst_query: 'count or rank loaded data',
  get_entity_context: 'what is in view',
  get_current_view_state: 'current app state',
  annotate_map: 'mark places',
};

function shortPurpose(name) {
  return (
    PURPOSES[name] ||
    firstSentence(ACTION_DESCRIPTIONS[name]?.description || name)
  );
}

function firstSentence(text) {
  const match = String(text).match(/^(.+?[.!?])(\s|$)/);
  return (match ? match[1] : String(text)).trim();
}

/**
 * Coerces model-produced arguments toward the canonical schema: numeric and
 * boolean strings, case-insensitive enum values and unknown keys. The action
 * runner remains the validation authority.
 */
export function coerceArguments(name, args) {
  const schema = ACTION_SCHEMA_BY_NAME.get(name);
  if (!schema) return args && typeof args === 'object' ? args : {};
  const coerced = coerceValue(schema.parameters, args ?? {});
  if (name === 'analyst_query' && Array.isArray(coerced.filters))
    coerced.filters = coerced.filters.map((filter) =>
      coerceFilterValue(filter, coerced.layers),
    );
  return coerced;
}

/**
 * An analyst field's type from the voice layer manifest (number, text, flag
 * or time), looking first at the queried layers.
 */
export function analystFieldKind(field, layerIds = []) {
  const named = (Array.isArray(layerIds) ? layerIds : [layerIds])
    .map((id) => voiceLayer(id))
    .filter(Boolean);
  for (const entry of [...named, ...VOICE_LAYER_MANIFEST]) {
    const type = entry.query?.fields?.[field]?.type;
    if (type) return type;
  }
  return null;
}

// Filter values are untyped in the schema; their type follows the field, so
// an identifier such as icao24 "001234" stays text.
function coerceFilterValue(filter, layerIds) {
  if (!filter || typeof filter !== 'object') return filter;
  const kind = analystFieldKind(filter.field, layerIds);
  const value = filter.value;
  if (kind === 'text') return { ...filter, value: String(value) };
  if (kind === 'number' && typeof value === 'string') {
    const number = Number(value.trim().replace(/,/g, ''));
    return Number.isFinite(number) ? { ...filter, value: number } : filter;
  }
  if (kind === 'flag' && typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === 'false')
      return { ...filter, value: lowered === 'true' };
  }
  return filter;
}

function coerceValue(schema, value) {
  if (!schema || typeof schema !== 'object') return value;
  const type = schema.type;
  if (type === 'object' || (!type && schema.properties)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === null || child === undefined) continue;
      if (schema.properties && key in schema.properties)
        out[key] = coerceValue(schema.properties[key], child);
      else if (schema.additionalProperties !== false) out[key] = child;
    }
    return out;
  }
  if (type === 'array') {
    const list = Array.isArray(value) ? value : [value];
    return list.map((item) => coerceValue(schema.items, item));
  }
  if (type === 'boolean') {
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (['true', 'on', 'yes', '1'].includes(lowered)) return true;
      if (['false', 'off', 'no', '0'].includes(lowered)) return false;
    }
    return value;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value === 'string' && value.trim() !== '') {
      const number = Number(value.replace(/,/g, ''));
      if (Number.isFinite(number)) return number;
    }
    return value;
  }
  if (type === 'string') {
    const text = typeof value === 'string' ? value : String(value);
    if (Array.isArray(schema.enum)) {
      const exact = schema.enum.find((option) => option === text);
      if (exact) return exact;
      const folded = text
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
      const match = schema.enum.find(
        (option) => option.toLowerCase().replace(/[\s_]+/g, '-') === folded,
      );
      return match || text;
    }
    return text;
  }
  return value;
}
