import { QUERY_ACTIONS } from './toolset.js';

const LAYER_NAMES = {
  flights: 'Flights',
  military: 'Military flights',
  earthquakes: 'Earthquakes',
  satellites: 'Satellites',
  'rocket-launches': 'Space missions',
  traffic: 'Traffic',
  cctv: 'Traffic cameras',
  radio: 'Radio',
  bikeshare: 'Bike share',
  'ais-live-vessels': 'Ships',
  'local-datacenters': 'Datacenters',
  'local-dams': 'Dams',
  'telegeography-submarine-cables': 'Undersea cables',
  'local-firms': 'Fires',
  'alpr-cameras': 'Plate readers',
  'local-adsb': 'Local receiver',
};

const STYLE_NAMES = {
  normal: 'Normal view',
  surveillance: 'Night vision',
  thermal: 'Thermal',
  retro: 'Retro',
  anime: 'Anime',
  noir: 'Noir',
  snow: 'Snow',
};

const STACK_NAMES = {
  photoreal: 'Google 3D',
  'bing-aerial': 'Bing aerial',
  'bing-labels': 'Aerial with labels',
  'esri-imagery': 'Esri imagery',
  osm: 'OpenStreetMap',
};

/**
 * Whether a completed action needs a model pass to be put into words.
 * @param {string} name
 */
export function needsSpokenAnswer(name) {
  return QUERY_ACTIONS.includes(name);
}

/**
 * Whether the model gets another round with this result, to answer it or to
 * make the call that depends on it ("track the nearest aircraft").
 * @param {string} name
 * @param {object} [result]
 */
export function needsContinuation(name, result = null) {
  if (result?.cancelled) return false;
  return QUERY_ACTIONS.includes(name);
}

/** The envelope's spoken line, when the action composed one. */
function envelopeSay(result) {
  if (!result || result.cancelled) return null;
  return typeof result.say === 'string' && result.say.trim()
    ? result.say.trim()
    : null;
}

const comparable = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Whether a result has something to say beyond the acknowledgement already
 * spoken while it ran: an envelope line that differs from the plain
 * confirmation ("Flights on, but its feed is unavailable", "At least 500 …").
 * @param {string} name
 * @param {object} args
 * @param {object} result
 */
export function isMaterialReply(name, args = {}, result = {}) {
  const say = envelopeSay(result);
  if (!say) return false;
  return comparable(say) !== comparable(fixedReply(name, args, result));
}

/**
 * Short spoken confirmation for an action result. The shared envelope's
 * `say` is authoritative (it carries feed state, lower bounds and partial
 * answers); otherwise a fixed line echoes the resulting state, never the
 * request.
 * @param {string} name
 * @param {object} args
 * @param {object} result
 */
export function actionReply(name, args = {}, result = {}) {
  return envelopeSay(result) || fixedReply(name, args, result);
}

function fixedReply(name, args = {}, result = {}) {
  if (!result || result.ok === false) return failureReply(name, result);
  switch (name) {
    case 'set_layer_visibility': {
      const label =
        LAYER_NAMES[result.layerId || args.layerId] || result.label || 'Layer';
      return `${label} ${result.enabled === false || args.enabled === false ? 'off' : 'on'}.`;
    }
    case 'fly_to_location':
      return `Flying to ${spokenPlace(result.label || args.query || 'there')}.`;
    case 'adjust_camera_zoom':
      return `Zoomed ${result.direction || args.direction || 'in'}.`;
    case 'zoom_to_globe':
      return 'Globe view.';
    case 'set_visual_style':
      return `${STYLE_NAMES[result.style || args.style] || 'Style set'}.`;
    case 'set_hud': {
      const hud = result.hud || {};
      if (args.visible === 'off' || hud.visible === false) return 'HUD off.';
      if (args.layout) return `HUD ${args.layout} layout.`;
      return 'HUD on.';
    }
    case 'track_entity':
      return `Tracking ${result.label || result.callsign || result.name || args.query || 'target'}.`;
    case 'stop_tracking':
      return 'Tracking stopped.';
    case 'select_nearest_aircraft':
      return `Selected ${result.label || 'the nearest aircraft'}${result.location ? ` near ${spokenPlace(result.location)}` : ''}.`;
    case 'annotate_map': {
      const failed = result.failedLabels?.length || 0;
      if (failed && result.partial)
        return 'Marked, but I couldn’t place some of it.';
      return 'Marked.';
    }
    case 'clear_annotations':
      return 'Map cleared.';
    case 'set_map_stack':
      return `${STACK_NAMES[result.requested || args.stack] || 'Basemap'} basemap.`;
    case 'set_detection':
      return result.enabled === false ? 'Detection off.' : 'Detection on.';
    case 'set_post_processing':
      return 'Done.';
    case 'show_data_layers_menu':
      return 'Data layers.';
    case 'set_panel_open':
      return args.open === false ? 'Closed.' : 'Opened.';
    case 'move_camera':
      return args.motion === 'stop' ? 'Camera stopped.' : 'Moving.';
    case 'control_radio':
      if (result.radioPlaybackRequested) return 'Turning on the radio.';
      return 'Radio updated.';
    case 'frame_overhead':
      return Number.isFinite(result.count)
        ? `Framed ${result.count}.`
        : 'Framed.';
    default:
      return typeof result.say === 'string' && result.say.trim()
        ? result.say
        : 'Done.';
  }
}

/**
 * Present-tense acknowledgement spoken while a slow action is still running.
 * Never claims the result; null means stay quiet until it finishes.
 */
export function progressReply(name, args = {}) {
  if (name === 'set_layer_visibility') {
    const label = (LAYER_NAMES[args.layerId] || 'the layer').toLowerCase();
    return `${args.enabled === false ? 'Turning off' : 'Turning on'} ${label}.`;
  }
  if (name === 'analyst_query' || name === 'get_entity_context')
    return 'Checking.';
  if (name === 'fly_to_location')
    return `Flying to ${spokenPlace(args.query || 'there')}.`;
  if (name === 'annotate_map') return 'Marking it.';
  if (name === 'track_entity') return 'Looking for it.';
  return null;
}

function failureReply(name, result = {}) {
  if (result?.cancelled) return null;
  const reason = shortReason(result?.error);
  if (name === 'track_entity') return reason || 'Nothing matched.';
  if (name === 'fly_to_location')
    return reason
      ? `Couldn’t fly there. ${reason}`
      : 'Couldn’t find that place.';
  return reason ? `That failed. ${reason}` : 'That failed.';
}

function shortReason(error) {
  const text = String(error || '').trim();
  if (!text) return '';
  const sentence = text.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ');
  const clipped = sentence.length > 90 ? sentence.slice(0, 87) + '…' : sentence;
  return /[.!?…]$/.test(clipped) ? clipped : clipped + '.';
}

function spokenPlace(label) {
  return String(label).split(',')[0].trim() || 'there';
}

/** Joins several confirmations into one short utterance. */
export function combineReplies(replies) {
  const parts = replies.filter(Boolean);
  if (!parts.length) return '';
  return parts.join(' ');
}

/**
 * Deterministic words for a query result, used when the model pass is not
 * available or fails.
 */
export function fallbackAnswer(name, result = {}) {
  if (!result || result.ok === false) return failureReply(name, result);
  if (name === 'analyst_query') {
    const stale =
      result.feedState && result.feedState !== 'nominal'
        ? `, ${result.feedState}`
        : '';
    const first = result.items?.[0];
    const example = first ? ` Top: ${itemName(first)}.` : '';
    // A capped count is a floor; a layer that could not answer is named.
    const floor = result.complete === false ? 'At least ' : '';
    const missing = result.unanswered?.length
      ? ` ${result.unanswered.join(', ')} not answered.`
      : '';
    return `${floor}${result.count ?? 0} ${result.scopeLabel || 'found'}${stale}.${example}${missing}`;
  }
  if (name === 'get_entity_context') {
    const place =
      result.selected?.name ||
      result.basemap?.place?.name ||
      result.basemap?.place?.label ||
      result.basemap?.viewportPlaces?.dominantLocality;
    return place ? `Looking at ${place}.` : 'I can’t tell from here.';
  }
  if (typeof result.say === 'string' && result.say.trim()) return result.say;
  if (name === 'get_current_view_state') return 'State read.';
  return 'Done.';
}

function itemName(item) {
  return (
    item.callsign ||
    item.name ||
    item.label ||
    item.title ||
    item.id ||
    'unnamed'
  );
}

const DROP_KEYS = new Set([
  'action',
  'coverage',
  'feedProvenance',
  'lifecycleState',
  'lifecycleUncertain',
  'viewportSamples',
  'debug',
  'geometry',
  'positions',
  'raw',
]);

/**
 * Shrinks a query result before it is prefilled into a small model: drops
 * bookkeeping, then lowers depth, list length and string length until the
 * JSON fits the character budget (about four characters per token).
 */
export function compactResultForModel(result, { budget = 1200 } = {}) {
  const passes = [
    { maxDepth: 4, maxItems: 3, maxString: 160 },
    { maxDepth: 3, maxItems: 3, maxString: 100 },
    { maxDepth: 3, maxItems: 2, maxString: 80 },
    { maxDepth: 2, maxItems: 1, maxString: 60 },
    { maxDepth: 1, maxItems: 1, maxString: 60 },
  ];
  let compact = {};
  for (const pass of passes) {
    compact = shrinkResult(result, pass);
    if (JSON.stringify(compact).length <= budget) return compact;
  }
  return compact;
}

function shrinkResult(result, { maxDepth, maxItems, maxString }) {
  const seen = new WeakSet();
  const shrink = (value, depth) => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && value.length > maxString)
        return value.slice(0, maxString) + '…';
      if (typeof value === 'number' && !Number.isInteger(value))
        return Math.round(value * 100) / 100;
      return value;
    }
    if (seen.has(value) || depth > maxDepth) return undefined;
    seen.add(value);
    if (Array.isArray(value))
      return value
        .slice(0, maxItems)
        .map((item) => shrink(item, depth + 1))
        .filter((item) => item !== undefined);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (DROP_KEYS.has(key) || item === null || item === undefined) continue;
      const next = shrink(item, depth + 1);
      if (next === undefined) continue;
      if (Array.isArray(next) && !next.length) continue;
      if (
        next &&
        typeof next === 'object' &&
        !Array.isArray(next) &&
        !Object.keys(next).length
      )
        continue;
      out[key] = next;
    }
    return out;
  };
  return shrink(result, 0) || {};
}
