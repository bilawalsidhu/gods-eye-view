import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';

const DEFAULT_COMMAND_ENTRIES = [
  {
    id: 'open-data-layers',
    label: 'Open Data Layers',
    group: 'Panels',
    keywords: ['layers', 'data', 'panel'],
    action: {
      name: 'set_panel_open',
      args: { panelId: 'data-panel', open: true },
    },
  },
  {
    id: 'open-cameras',
    label: 'Open Cameras',
    group: 'Panels',
    keywords: ['cctv', 'camera', 'panel'],
    action: {
      name: 'set_panel_open',
      args: { panelId: 'cctv-panel', open: true },
    },
  },
  {
    id: 'open-radio',
    label: 'Open Radio',
    group: 'Panels',
    keywords: ['radio', 'audio', 'panel'],
    action: {
      name: 'set_panel_open',
      args: { panelId: 'radio-panel', open: true },
    },
  },
  {
    id: 'open-context',
    label: 'Open Context',
    group: 'Panels',
    keywords: ['context', 'contacts', 'missions', 'panel'],
    action: {
      name: 'set_panel_open',
      args: { panelId: 'global-context-panel', open: true },
    },
  },
  {
    id: 'open-location',
    label: 'Open Location',
    group: 'Panels',
    keywords: ['location', 'search', 'place', 'panel'],
    action: {
      name: 'set_panel_open',
      args: { panelId: 'location-bar', open: true },
    },
  },
  {
    id: 'contacts-context',
    label: 'Enter Contacts Context',
    group: 'Context',
    keywords: ['contacts', 'aircraft', 'vessels', 'nearby'],
    action: {
      name: 'set_context_mode',
      args: { mode: 'contacts' },
    },
  },
  {
    id: 'space-missions-context',
    label: 'Enter Space Missions',
    group: 'Context',
    keywords: ['space', 'missions', 'launches', 'rockets'],
    action: {
      name: 'set_context_mode',
      args: { mode: 'space-missions' },
    },
  },
  {
    id: 'hud-on',
    label: 'Show HUD',
    group: 'Display',
    keywords: ['hud', 'heads up', 'display', 'show'],
    action: {
      name: 'set_hud',
      args: { visible: 'on' },
    },
  },
  {
    id: 'hud-off',
    label: 'Hide HUD',
    group: 'Display',
    keywords: ['hud', 'heads up', 'display', 'hide'],
    action: {
      name: 'set_hud',
      args: { visible: 'off' },
    },
  },
  {
    id: 'style-normal',
    label: 'Normal Visual Style',
    group: 'Visual',
    keywords: ['normal', 'style', 'filter', 'visual'],
    action: {
      name: 'set_visual_style',
      args: { style: 'normal' },
    },
  },
  {
    id: 'style-thermal',
    label: 'Thermal Visual Style',
    group: 'Visual',
    keywords: ['thermal', 'flir', 'style', 'filter'],
    action: {
      name: 'set_visual_style',
      args: { style: 'thermal' },
    },
  },
  {
    id: 'map-osm',
    label: 'Use OpenStreetMap',
    group: 'Map',
    keywords: ['osm', 'openstreetmap', 'map', 'basemap'],
    action: {
      name: 'set_map_stack',
      args: { stack: 'osm' },
    },
  },
];

function boundedText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text && text.length <= maxLength ? text : null;
}

function validateSchemaValue(value, schema, path) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new TypeError(`${path} must match the action schema enum`);

  if (schema.type === 'string' && typeof value !== 'string')
    throw new TypeError(`${path} must be a string`);
  if (schema.type === 'boolean' && typeof value !== 'boolean')
    throw new TypeError(`${path} must be a boolean`);
  if (
    schema.type === 'number' &&
    (typeof value !== 'number' || !Number.isFinite(value))
  )
    throw new TypeError(`${path} must be a finite number`);
  if (
    schema.type === 'integer' &&
    (!Number.isInteger(value) || !Number.isFinite(value))
  )
    throw new TypeError(`${path} must be an integer`);

  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum)
      throw new TypeError(`${path} is below the schema minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum)
      throw new TypeError(`${path} is above the schema maximum`);
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems)
      throw new TypeError(`${path} has too few items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems)
      throw new TypeError(`${path} has too many items`);
    value.forEach((item, index) =>
      validateSchemaValue(item, schema.items, `${path}[${index}]`),
    );
  }

  if (schema.type === 'object') {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new TypeError(`${path} must be a plain object`);
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required))
        throw new TypeError(`${path} is missing required ${required}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false)
          throw new TypeError(`${path} contains unknown argument ${key}`);
        continue;
      }
      validateSchemaValue(item, properties[key], `${path}.${key}`);
    }
  }
}

function actionSchemaByName(schemas) {
  return new Map(
    (Array.isArray(schemas) ? schemas : []).map((schema) => [
      schema?.name,
      schema,
    ]),
  );
}

function normalizeKeywords(value) {
  if (!Array.isArray(value))
    throw new TypeError('Command keywords must be an array');
  const keywords = value.map((entry) => boundedText(entry, 80));
  if (keywords.some((entry) => !entry))
    throw new TypeError('Command keywords must be bounded text');
  return [...new Set(keywords)];
}

function normalizeCommandEntry(entry, schemaIndex) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    throw new TypeError('Command entries must be objects');
  const id = boundedText(entry.id, 120);
  const label = boundedText(entry.label, 120);
  const group = boundedText(entry.group, 80);
  const name = boundedText(entry.action?.name, 120);
  if (!id || !label || !group || !name)
    throw new TypeError(
      'Command id, label, group, and action name are required',
    );
  const schema = schemaIndex.get(name);
  if (!schema) throw new TypeError(`Unknown command action: ${name}`);
  const args = entry.action?.args ?? {};
  validateSchemaValue(args, schema.parameters, `command ${id}.args`);
  return Object.freeze({
    id,
    label,
    group,
    keywords: Object.freeze(normalizeKeywords(entry.keywords || [])),
    action: Object.freeze({
      name,
      args: Object.freeze(structuredClone(args)),
    }),
  });
}

/**
 * Validate human-facing command metadata against the canonical typed action
 * schema without importing provider/model descriptions.
 */
export function createCommandCatalog(
  entries = DEFAULT_COMMAND_ENTRIES,
  { schemas = GEV_ACTION_SCHEMAS } = {},
) {
  const schemaIndex = actionSchemaByName(schemas);
  const seen = new Set();
  return Object.freeze(
    entries.map((entry) => {
      const normalized = normalizeCommandEntry(entry, schemaIndex);
      if (seen.has(normalized.id))
        throw new TypeError(`Duplicate command id: ${normalized.id}`);
      seen.add(normalized.id);
      return normalized;
    }),
  );
}

function searchableText(command) {
  return [command.label, command.group, ...command.keywords]
    .join(' ')
    .toLowerCase();
}

function commandScore(command, query) {
  const label = command.label.toLowerCase();
  const normalized = query.toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const searchable = searchableText(command);
  if (!tokens.every((token) => searchable.includes(token))) return 0;

  let score = 100;
  if (label === normalized) score += 1000;
  else if (label.startsWith(normalized)) score += 700;
  else if (label.includes(normalized)) score += 500;

  for (const token of tokens) {
    if (label.split(/\s+/).some((word) => word.startsWith(token))) score += 80;
    if (command.keywords.some((keyword) => keyword.toLowerCase() === token))
      score += 60;
  }
  return score;
}

/** Deterministic catalog search; no model call and no execution authority. */
export function searchCommandCatalog(catalog, query, { limit = 10 } = {}) {
  const normalizedQuery = String(query ?? '').trim();
  const boundedLimit = Math.max(
    1,
    Math.min(50, Math.floor(Number(limit) || 10)),
  );
  const commands = Array.isArray(catalog) ? catalog : [];
  if (!normalizedQuery) return commands.slice(0, boundedLimit);

  return commands
    .map((command, index) => ({
      command,
      index,
      score: commandScore(command, normalizedQuery),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.command.label.localeCompare(b.command.label) ||
        a.index - b.index,
    )
    .slice(0, boundedLimit)
    .map(({ command }) => command);
}

export const DEFAULT_COMMAND_CATALOG = createCommandCatalog();
