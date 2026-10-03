/**
 * Voice result envelope: what a tool result should SAY and what it should
 * SHOW, composed by code rather than by prompt prose.
 *
 *   { say, display, referents?, schedule? }
 *
 * - `say` is one short spoken line (≤25 words, numbers verbatim). Material
 *   caveats are folded in as one or two words ("stale", "feed unavailable").
 *   `null` means the model continues naturally with nothing extra to say.
 * - `display` is for the voice card and is never read aloud unless the user
 *   asks why, how sure, or which source.
 * - `referents` number the things the card lists, so "the second one" can
 *   resolve later.
 * - `schedule` is `speak` (default) or `silent` (a lookup the model uses to
 *   continue, not something to read back).
 *
 * Builders are small pure functions keyed by tool name. Tools without one are
 * returned unchanged.
 */

import { voiceLayer } from './layerManifest.js';

const LAYER_NOUNS = Object.freeze({
  flights: 'aircraft',
  military: 'military aircraft',
  'local-adsb': 'aircraft',
  'ais-live-vessels': 'ships',
  satellites: 'satellites',
  'rocket-launches': 'launches',
  earthquakes: 'earthquakes',
  'local-firms': 'fires',
  'osm-places': 'places',
});

const AIRCRAFT_LAYERS = new Set(['flights', 'military', 'local-adsb']);
const MAX_ANALYST_HEADLINE = 64;

export function analystNounFor(layerKeys) {
  const keys = [...new Set((layerKeys || []).filter(Boolean))];
  if (keys.length > 1 && keys.every((key) => AIRCRAFT_LAYERS.has(key)))
    return 'aircraft';
  if (keys.length !== 1) return 'results';
  const key = keys[0];
  return LAYER_NOUNS[key] || voiceLayer(key)?.aliases?.[0] || 'results';
}

/** The count/scope headline shared by the analyst card and spoken answer. */
export function analystHeadline(result) {
  const keys = (result?.coverage?.layersQueried || []).map(
    (layer) => layer.layerKey,
  );
  const count = Number(result?.count) || 0;
  const floor = result?.complete === false ? 'At least ' : '';
  return spokenLabel(
    `${floor}${count.toLocaleString('en-US')} ${analystNounFor(keys)} ${result?.scopeLabel || ''}`,
    MAX_ANALYST_HEADLINE,
  );
}

/** Feed states that change what a spoken answer means. */
const MATERIAL_FEED_TAGS = Object.freeze({
  stale: 'stale',
  degraded: 'degraded',
  unavailable: 'feed unavailable',
});

const MAX_LABEL = 48;

/** Collapse whitespace and control characters, and bound a spoken label. */
export function spokenLabel(value, max = MAX_LABEL) {
  const text = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function listPhrase(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

function feet(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round((value * 3.28084) / 100) * 100;
  return `${rounded.toLocaleString('en-US')} feet`;
}

function kilometers(km) {
  const value = Number(km);
  if (!Number.isFinite(value)) return null;
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} km`;
}

function sentence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function feedTag(state) {
  return MATERIAL_FEED_TAGS[state] || null;
}

/** A feed chip only when the state is worth seeing; nominal is the default. */
function feedChips(state) {
  return state && state !== 'nominal' ? [{ label: state }] : [];
}

/** Ids such as `austin` or `local-firms` read as names on screen. */
function displayName(value, max) {
  const label = spokenLabel(value, max);
  return /^[a-z0-9-]+$/.test(label)
    ? label
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    : label;
}

function layerLabel(result) {
  return spokenLabel(result?.label || result?.layerId || 'Layer');
}

/* ---------------- per-tool builders ---------------- */

function setLayerVisibility(result, args = {}) {
  const label = layerLabel(result);
  if (result?.cancelled) return null;
  if (!result?.ok) {
    const wanted = args.enabled === false ? 'off' : 'on';
    return {
      say: `Couldn't turn ${wanted} ${label}.`,
      display: { title: label, lines: [result?.error].filter(Boolean) },
    };
  }
  const on = result.enabled !== false;
  const tag = on ? feedTag(result.feedState) : null;
  const say =
    tag === 'feed unavailable'
      ? `${label} on, but its feed is unavailable.`
      : sentence(`${label} ${on ? 'on' : 'off'}${tag ? `, ${tag}` : ''}`);
  return {
    say,
    display: {
      title: `${label} ${on ? 'on' : 'off'}`,
      chips: on ? feedChips(result.feedState) : [],
      sources: result.source ? [{ label: result.source }] : [],
    },
  };
}

function flyToLocation(result) {
  const label = spokenLabel(result?.label || result?.query || 'there');
  if (result?.cancelled) return null;
  if (!result?.ok) {
    return {
      say: sentence(`Couldn't find ${label}`),
      display: { title: label, lines: [result?.error].filter(Boolean) },
    };
  }
  return {
    say: sentence(result.arrived ? `Over ${label}` : `Flying to ${label}`),
    display: {
      title: label,
      lines: result.rangeM
        ? [`Camera range ${kilometers(result.rangeM / 1000)}`]
        : [],
    },
  };
}

function frameOverhead(result) {
  const noun = LAYER_NOUNS[result?.layerId] || 'contacts';
  const radius = kilometers(result?.radiusKm);
  if (result?.cancelled) return null;
  if (!result?.ok) {
    // Absence is asserted only for an explicit empty query; a refused or
    // unavailable camera move says the frame did not happen.
    const error = result?.error || '';
    let say;
    if (/not enabled/i.test(error))
      say = `The ${noun} layer is off. Turn it on?`;
    else if (result?.count === 0 && radius)
      say = `No ${noun} within ${radius}.`;
    else if (/unknown target/i.test(error)) say = "I can't frame that layer.";
    else say = `Couldn't frame the ${noun} right now.`;
    return {
      say,
      display: {
        title: `Frame ${noun}`,
        lines: [result?.error].filter(Boolean),
      },
    };
  }
  // The layer query returns at most 80, so a full page is a lower bound.
  const count = Number(result.count) || 0;
  const countText = count >= 80 ? `at least ${count}` : String(count);
  const referents = (result.nearest || [])
    .filter((entry) => entry?.label || entry?.id)
    .map((entry, index) => ({
      n: index + 1,
      id: entry.icao24 || entry.mmsi || entry.id || null,
      label: spokenLabel(entry.label || entry.id),
      layerId: result.layerId,
    }));
  return {
    say: sentence(`Framed ${countText} ${noun} within ${radius}`),
    display: {
      title: `${count} ${noun} in frame`,
      lines: [
        `Within ${radius} of the view`,
        result.detectionEnabled ? 'Labels on' : null,
      ].filter(Boolean),
      notes: count >= 80 ? ['Framing uses the nearest 80 loaded contacts'] : [],
    },
    referents,
  };
}

function selectNearestAircraft(result) {
  const location = spokenLabel(
    result?.location?.label || result?.location || 'there',
  );
  const noun = LAYER_NOUNS[result?.layerId] || 'aircraft';
  const feed = result?.feed || {};
  const sources = feed.source ? [{ label: feed.source }] : [];
  if (result?.cancelled) return null;
  if (!result?.ok) {
    let say;
    if (result?.stage === 'location') say = `Couldn't get to ${location}.`;
    else if (feed.state === 'unavailable')
      say = 'The aircraft feed is unavailable.';
    else if (result?.stage === 'nearest')
      say = `No airborne ${noun} loaded near ${location} yet.`;
    else if (result?.stage === 'layer') say = `Couldn't turn on ${noun}.`;
    else say = `Couldn't select the nearest ${noun}.`;
    return {
      say,
      display: {
        title: `Nearest ${noun}`,
        lines: [result?.error].filter(Boolean),
        chips: feedChips(feed.state),
        sources,
      },
    };
  }
  const aircraft = result.aircraft || {};
  const name = spokenLabel(aircraft.callsign || result.label || aircraft.id);
  const distance = kilometers(aircraft.distanceKm);
  const altitude = feet(aircraft.altitudeM);
  const tag = feedTag(feed.state);
  const say = sentence(
    [
      `Selected ${name}`,
      distance ? `${distance} from ${location}` : null,
      altitude,
      tag,
    ]
      .filter(Boolean)
      .join(', '),
  );
  return {
    say,
    display: {
      title: name,
      lines: [
        distance ? `${distance} from ${location}` : null,
        altitude ? `Altitude ${altitude}` : null,
      ].filter(Boolean),
      chips: feedChips(feed.state),
      sources,
    },
    referents: [
      { n: 1, id: aircraft.id || null, label: name, layerId: result.layerId },
    ],
  };
}

function routeText(properties) {
  const route = spokenLabel(properties.route || '', 40);
  if (route) return route.replace(/\s*(?:-|→|>)\s*/g, ' to ');
  const origin = spokenLabel(properties.routeOrigin || '', 12);
  const destination = spokenLabel(properties.routeDestination || '', 12);
  if (origin && destination) return `${origin} to ${destination}`;
  if (origin) return `from ${origin}`;
  if (destination) return `to ${destination}`;
  return null;
}

function getEntityContext(result) {
  const selected = result?.selected;
  if (!result?.ok || !selected) return null;
  const properties = selected.properties || {};
  const isAircraft =
    selected.layerId === 'flights' || selected.layerId === 'military';
  const title = spokenLabel(
    properties.callsign || selected.name || selected.id || 'Selection',
  );
  if (!isAircraft) {
    return {
      say: null,
      display: {
        title,
        lines: [selected.layerName].filter(Boolean),
        sources: selected.source ? [{ label: selected.source }] : [],
      },
    };
  }
  // Operator, type and route are always covered, from returned fields only;
  // a missing one is a short phrase rather than a sentence. This is the
  // answer to "what is this aircraft?" only; other questions about the
  // selection (altitude, speed, registration) answer from its properties.
  const route = routeText(properties);
  const identityLine = sentence(
    [
      title,
      spokenLabel(properties.operator || '', 32) || 'operator unknown',
      spokenLabel(properties.type || '', 32) || 'type unknown',
      route || 'no route on file',
    ].join(', '),
  );
  return {
    say: null,
    identityLine,
    display: {
      title,
      lines: [
        properties.registration
          ? `Registration ${spokenLabel(properties.registration, 16)}`
          : null,
        route ? `Route ${route}` : null,
      ].filter(Boolean),
      sources: selected.source ? [{ label: selected.source }] : [],
    },
    referents: [
      {
        n: 1,
        id: selected.id || null,
        label: title,
        layerId: selected.layerId,
      },
    ],
  };
}

function getCurrentViewState(result) {
  if (!result?.ok) return null;
  const heightM = Number(result.camera?.heightM);
  const height = Number.isFinite(heightM)
    ? heightM >= 1000
      ? `${Math.round(heightM / 1000).toLocaleString('en-US')} km up`
      : `${Math.round(heightM)} m up`
    : null;
  const layers = Array.isArray(result.layers) ? result.layers : [];
  const enabled = layers.filter((layer) => layer.enabled !== false);
  const names = enabled.map((layer) => spokenLabel(layer.name || layer.id, 24));
  const tagged = enabled
    .filter((layer) => feedTag(layer.feedState))
    .map(
      (layer) =>
        `${spokenLabel(layer.name || layer.id, 24)} ${feedTag(layer.feedState)}`,
    );
  const style = spokenLabel(result.style || 'normal', 20);
  const parts = [
    height ? `Camera ${height}` : null,
    `${style} style`,
    names.length
      ? `${listPhrase(names.slice(0, 4))}${names.length > 4 ? ` and ${names.length - 4} more` : ''} on`
      : 'no layers on',
    tagged.length ? listPhrase(tagged.slice(0, 2)) : null,
  ];
  return {
    say: parts
      .filter(Boolean)
      .map((part) => sentence(part[0].toUpperCase() + part.slice(1)))
      .join(' '),
    display: {
      title: 'View state',
      lines: enabled.map(
        (layer) =>
          `${spokenLabel(layer.name || layer.id, 32)} · ${layer.count ?? 0} · ${layer.feedState || 'nominal'}`,
      ),
    },
    schedule: 'silent',
  };
}

function annotateMap(result) {
  const failed = (
    Array.isArray(result?.failedLabels) ? result.failedLabels : []
  )
    .map((label) => spokenLabel(label, 40))
    .filter(Boolean);
  const drawn = (Array.isArray(result?.items) ? result.items : []).filter(
    (item) => item?.ok,
  );
  const referents = drawn.map((item, index) => ({
    n: index + 1,
    id: item.id || null,
    label: spokenLabel(item.label || item.target || `Mark ${index + 1}`),
  }));
  const parts = [];
  if (failed.length)
    parts.push(`Couldn't place ${listPhrase(failed.slice(0, 3))}.`);
  if (result?.ok && result.routeFallback)
    parts.push('That line is straight-line distance, not a street route.');
  if (result?.capped) parts.push('The map is full. Clear it first?');
  return {
    // Successful marks are not announced; the model keeps explaining.
    say: parts.length ? parts.join(' ') : null,
    display: {
      title: result?.ok
        ? `Marked ${drawn.length} ${drawn.length === 1 ? 'place' : 'places'}`
        : 'Nothing marked',
      // The numbered referents list the marks; lines stay for extra facts.
      lines: [],
      notes: [
        ...(failed.length ? [`Not found: ${failed.join(', ')}`] : []),
        ...(result?.outlinePending ? ['Tracing outlines'] : []),
      ],
    },
    referents,
  };
}

function analystQuery(result) {
  if (!result?.ok || result.cancelled) return null;
  const headline = analystHeadline(result);
  const provenance = feedTag(
    result.feedState || result.feedProvenance?.overall,
  );
  const unanswered = (Array.isArray(result.unanswered) ? result.unanswered : [])
    .map((layer) => spokenLabel(layer, 24))
    .filter(Boolean);
  const missing = unanswered.length
    ? `Partial; ${listPhrase(unanswered.slice(0, 2))}${unanswered.length > 2 ? ` and ${unanswered.length - 2} more` : ''} not answered.`
    : 'Partial answer.';
  return {
    say: [
      sentence(headline),
      provenance === 'feed unavailable'
        ? 'Feed unavailable.'
        : provenance
          ? `Feed ${provenance}.`
          : null,
      result.partial ? missing : null,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** Default builders by tool name. */
export const SPEECH_BUILDERS = Object.freeze({
  set_layer_visibility: setLayerVisibility,
  fly_to_location: flyToLocation,
  frame_overhead: frameOverhead,
  select_nearest_aircraft: selectNearestAircraft,
  get_entity_context: getEntityContext,
  get_current_view_state: getCurrentViewState,
  annotate_map: annotateMap,
  analyst_query: analystQuery,
});

/**
 * Attach `say`/`display`/`referents`/`schedule` to a tool result. A result that
 * has no builder, is not an object, or makes its builder throw is returned
 * unchanged, so speech composition can never break an action.
 */
export function attachVoiceResult(
  name,
  result,
  args = {},
  builders = SPEECH_BUILDERS,
) {
  const builder = builders?.[name];
  if (typeof builder !== 'function' || !result || typeof result !== 'object')
    return result;
  let envelope;
  try {
    envelope = builder(result, args);
  } catch {
    return result;
  }
  if (!envelope) return result;
  const out = { ...result };
  if ('say' in envelope) out.say = envelope.say ?? null;
  if (envelope.identityLine) out.identityLine = envelope.identityLine;
  if (envelope.display) out.display = envelope.display;
  if (envelope.referents?.length) out.referents = envelope.referents;
  if (envelope.schedule) out.schedule = envelope.schedule;
  return out;
}

/* ---------------- plan steps and progress lines ---------------- */

function annotationTargets(args) {
  const list = Array.isArray(args?.annotations) ? args.annotations : [];
  return list
    .map((spec) =>
      spokenLabel(
        spec?.label ||
          spec?.target ||
          spec?.points
            ?.map((point) => point?.target)
            .filter(Boolean)
            .join(' → '),
        40,
      ),
    )
    .filter(Boolean);
}

/** A short on-screen label for one tool call in the voice card's plan. */
export function planStepLabel(name, args = {}) {
  switch (name) {
    case 'annotate_map': {
      const targets = annotationTargets(args);
      return targets.length
        ? `Mark ${listPhrase(targets.slice(0, 2))}${targets.length > 2 ? ` +${targets.length - 2}` : ''}`
        : 'Mark the map';
    }
    case 'fly_to_location':
      return `Fly to ${displayName(args.query || args.locationId || 'location', 40)}`;
    case 'select_nearest_aircraft':
      return `Nearest aircraft to ${displayName(args.locationQuery || args.locationId || 'here', 32)}`;
    case 'set_layer_visibility':
      return `${displayName(args.layerId || 'Layer', 32)} ${args.enabled === false ? 'off' : 'on'}`;
    case 'get_entity_context':
      return 'Read the view';
    case 'get_current_view_state':
      return 'Check view state';
    case 'frame_overhead':
      return `Frame ${spokenLabel(args.target || 'flights', 24)}`;
    case 'resolve_area':
      return args.around
        ? `Area around ${displayName(args.query || 'landmark', 32)}`
        : `${args.draw ? 'Outline' : 'Find'} ${displayName(args.query || 'area', 36)}`;
    case 'find_imagery':
      return 'Find recent imagery';
    case 'osm_query':
      return `Find ${spokenLabel(args.what || 'places', 32)}`;
    default:
      return spokenLabel(String(name || 'Action').replace(/_/g, ' '), 40);
  }
}

/**
 * The spoken subject of a tool call for "Still working on …", or '' when the
 * call has no natural one.
 */
export function narrationLabel(name, args = {}) {
  switch (name) {
    case 'annotate_map':
      return annotationTargets(args)[0] || '';
    case 'fly_to_location':
      return displayName(args.query || args.locationId || '', 32);
    case 'select_nearest_aircraft':
      return displayName(args.locationQuery || args.locationId || '', 32);
    case 'resolve_area':
      return displayName(args.query || '', 32);
    case 'find_imagery':
      return 'the imagery';
    case 'osm_query':
      return spokenLabel(args.what || '', 32);
    default:
      return '';
  }
}

/** On-screen labels for progress steps. */
const STEP_LABELS = Object.freeze({
  resolve: 'Finding places',
  outline: 'Tracing outline',
  search: 'Looking up place',
  fly: 'Flying',
  layer: 'Turning on layer',
  refresh: 'Loading aircraft',
  nearest: 'Picking nearest',
  draw: 'Drawing outline',
  catalog: 'Searching imagery catalog',
  drape: 'Loading imagery',
  osm: 'Searching OpenStreetMap',
});

/** On-screen label for a progress step. */
export function progressStepLabel(step, label) {
  const base = STEP_LABELS[step] || spokenLabel(step || 'Working', 24);
  return label ? `${base}: ${spokenLabel(label, 32)}` : base;
}

/**
 * Spoken progress line for a slow tool's current step, or null when the step
 * should stay silent. Lines are code-authored: no hedges, no invented facts.
 */
export function progressLine(step, label) {
  const place = spokenLabel(label, 32);
  switch (step) {
    case 'resolve':
      return place ? `Finding ${place} on the map.` : 'Finding those places.';
    case 'search':
      return place ? `Looking up ${place}.` : null;
    case 'draw':
      return place ? `Outlining ${place}.` : null;
    case 'catalog':
      return 'Searching the imagery catalog.';
    case 'drape':
      return 'Loading the image.';
    case 'osm':
      return place
        ? `Searching OpenStreetMap for ${place}.`
        : 'Searching OpenStreetMap.';
    case 'fly':
      return place ? `Heading to ${place}.` : null;
    case 'layer':
      return place ? `Turning on ${place}.` : null;
    case 'refresh':
      return 'Loading aircraft there.';
    case 'nearest':
      return 'Picking the nearest aircraft.';
    case 'still':
      return place ? `Still working on ${place}.` : 'Still working on it.';
    default:
      return null;
  }
}
