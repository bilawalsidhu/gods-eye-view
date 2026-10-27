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
 *
 * Only `display` and plan/progress labels are UI text (t()). `say`,
 * `identityLine`, spoken progress lines and the tool result stay English for
 * the model; the card shows them through the shown* helpers.
 */

import { analystHeadline } from './resultDisplay.js';
import {
  formatNumber,
  getLocale,
  msg,
  t,
  tn,
  translateKnown,
} from '../i18n/index.js';
import {
  layerNameForId,
  shownLayerName,
  sourceLabel,
} from '../ui/layerNames.js';
import { localizePlaceName } from '../ui/placeNames.js';
import { CITY_POIS } from '../cityPois.js';
import { formatQuantity } from '../ui/unitLabels.js';

const LAYER_NOUNS = Object.freeze({
  flights: 'aircraft',
  military: 'military aircraft',
  'ais-live-vessels': 'ships',
  satellites: 'satellites',
});

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

function feetRounded(meters) {
  const value = Number(meters);
  return Number.isFinite(value)
    ? Math.round((value * 3.28084) / 100) * 100
    : null;
}

function feet(meters) {
  const rounded = feetRounded(meters);
  if (rounded === null) return null;
  return `${rounded.toLocaleString('en-US')} feet`;
}

/** The card's altitude, in the active language. */
function shownFeet(meters) {
  const rounded = feetRounded(meters);
  if (rounded === null) return null;
  return t('{value} feet', { value: formatNumber(rounded) });
}

function roundedKm(km) {
  const value = Number(km);
  if (!Number.isFinite(value)) return null;
  return value < 10 ? Number(value.toFixed(1)) : Math.round(value);
}

function kilometers(km) {
  const value = roundedKm(km);
  return value === null ? null : `${value} km`;
}

/** The card's distance, in the active language: "2,5 км". */
function shownKm(km) {
  const value = roundedKm(km);
  return value === null ? null : formatQuantity(value, 'km');
}

/** Sources as the card lists them. */
function shownSources(source) {
  return source ? [{ label: sourceLabel(source) }] : [];
}

// Entity labels that layers register as English data (firms/, alpr/); keep in
// step with the producers. Other names (callsigns, places) show as they came.
const ENTITY_LABELS = new Set([msg('ALPR camera')]);
const FIRE_LABEL = /^Fire · FRP (\S+) MW$/;

/** An entity label as the card shows it, in the active language. */
export function shownEntityLabel(label) {
  if (ENTITY_LABELS.has(label)) return t(label);
  const fire = FIRE_LABEL.exec(label ?? '');
  return fire ? t('Fire · FRP {frp} MW', { frp: fire[1] }) : label;
}

/*
 * Tool errors stay English in the result (the model reads them). The card
 * translates the known ones; the English must match gevActions exactly.
 */
const KNOWN_ERRORS = new Map(
  [
    msg('The flights layer is not enabled'),
    msg('The military layer is not enabled'),
    msg('The satellites layer is not enabled'),
    msg('The ais-live-vessels layer is not enabled'),
    msg('Could not enable the requested layer'),
    msg('Could not disable the requested layer'),
    msg('Radio layer unavailable'),
    msg('Camera navigation is unavailable in the current view'),
    msg('Camera navigation policy unavailable'),
    msg('Nearest-aircraft selection supports Flights or Military Flights only'),
    msg(
      'Nearest-aircraft selection needs a preset, place name, or latitude and longitude',
    ),
    msg('Could not arrive at the requested place'),
    msg('The nearest airborne aircraft could not be selected'),
  ].map((text) => [text, text]),
);

function noneWithinView(target, radius) {
  switch (target) {
    case 'flights':
      return t('No flights within {radius} of the current view', { radius });
    case 'military':
      return t('No military within {radius} of the current view', { radius });
    case 'satellites':
      return t('No satellites within {radius} of the current view', {
        radius,
      });
    case 'vessels':
      return t('No vessels within {radius} of the current view', { radius });
    default:
      return null;
  }
}

const ERROR_PATTERNS = [
  [
    /^(.+) is enabled on the (.+) feed, but no airborne aircraft is loaded in the (.+) view yet$/,
    ([, layer, source, place]) =>
      t(
        '{layer} is enabled on the {source} feed, but no airborne aircraft is loaded in the {place} view yet',
        {
          layer: shownLayerName(layer),
          source: sourceLabel(source),
          place: localizePlaceName(place),
        },
      ),
  ],
  [
    /^(.+) is enabled, but no airborne aircraft is loaded in the (.+) view yet$/,
    ([, layer, place]) =>
      t(
        '{layer} is enabled, but no airborne aircraft is loaded in the {place} view yet',
        { layer: shownLayerName(layer), place: localizePlaceName(place) },
      ),
  ],
  [
    /^(.+) is enabled, but its aircraft feed is unavailable$/,
    ([, layer]) =>
      t('{layer} is enabled, but its aircraft feed is unavailable', {
        layer: shownLayerName(layer),
      }),
  ],
  [
    /^(.+) is enabled, but its destination refresh did not complete$/,
    ([, layer]) =>
      t('{layer} is enabled, but its destination refresh did not complete', {
        layer: shownLayerName(layer),
      }),
  ],
  [
    /^(.+) is enabled, but (.+) is unavailable$/,
    ([, layer, source]) =>
      t('{layer} is enabled, but {source} is unavailable', {
        layer: shownLayerName(layer),
        source: sourceLabel(source),
      }),
  ],
  [
    /^Could not arrive at (.+)$/,
    ([, place]) =>
      t('Could not arrive at {place}', { place: localizePlaceName(place) }),
  ],
  [
    /^(.+) is no longer loaded$/,
    ([, name]) => t('{name} is no longer loaded', { name }),
  ],
  [
    /^Unknown target layer: (.*)$/,
    ([, target]) => t('Unknown target layer: {target}', { target }),
  ],
  [
    /^No (\S+) within (\d+(?:\.\d+)?) km of the current view$/,
    ([, target, km]) => noneWithinView(target, shownKm(km)),
  ],
];

/** A tool error as the card shows it. */
function shownError(error) {
  if (typeof error !== 'string' || !error) return null;
  const known = KNOWN_ERRORS.get(error);
  if (known) return t(known);
  for (const [pattern, show] of ERROR_PATTERNS) {
    const match = pattern.exec(error);
    const shown = match ? show(match) : null;
    if (shown) return shown;
  }
  return translateKnown(error);
}

// The card wraps a failed result's lines rather than cutting them: a
// translated error runs longer than the English (voiceCardPresentation).
function errorLines(result) {
  return [shownError(result?.error)].filter(Boolean);
}

function sentence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function feedTag(state) {
  return MATERIAL_FEED_TAGS[state] || null;
}

/** Feed states as the card shows them; the state values stay English. */
const FEED_STATE_LABELS = Object.freeze({
  nominal: msg('nominal'),
  loading: msg('loading'),
  degraded: msg('degraded'),
  stale: msg('stale'),
  partial: msg('partial'),
  fallback: msg('fallback'),
  unavailable: msg('unavailable'),
});

function feedStateLabel(state) {
  const key = FEED_STATE_LABELS[state];
  return key ? t(key) : state;
}

/** A feed chip only when the state is worth seeing; nominal is the default. */
function feedChips(state) {
  return state && state !== 'nominal' ? [{ label: feedStateLabel(state) }] : [];
}

/** '{label} on' / '{label} off' as the card shows it. */
function switchedTitle(label, on) {
  return on ? t('{label} on', { label }) : t('{label} off', { label });
}

// Card titles name the layer's things in whole phrases, so each language can
// inflect the noun; the English matches LAYER_NOUNS.
function frameTitle(layerId) {
  switch (layerId) {
    case 'flights':
      return t('Frame aircraft');
    case 'military':
      return t('Frame military aircraft');
    case 'ais-live-vessels':
      return t('Frame ships');
    case 'satellites':
      return t('Frame satellites');
    default:
      return t('Frame contacts');
  }
}

function inFrameTitle(layerId, count) {
  switch (layerId) {
    case 'flights':
      return tn(
        count,
        '{count} aircraft in frame',
        '{count} aircraft in frame',
      );
    case 'military':
      return tn(
        count,
        '{count} military aircraft in frame',
        '{count} military aircraft in frame',
      );
    case 'ais-live-vessels':
      return tn(count, '{count} ships in frame', '{count} ships in frame');
    case 'satellites':
      return tn(
        count,
        '{count} satellites in frame',
        '{count} satellites in frame',
      );
    default:
      return tn(
        count,
        '{count} contacts in frame',
        '{count} contacts in frame',
      );
  }
}

function nearestTitle(layerId) {
  switch (layerId) {
    case 'military':
      return t('Nearest military aircraft');
    case 'ais-live-vessels':
      return t('Nearest ships');
    case 'satellites':
      return t('Nearest satellites');
    default:
      return t('Nearest aircraft');
  }
}

/** Two shown items joined, or the one item. */
function shownPair(items) {
  return items.length === 2
    ? t('{first} and {second}', { first: items[0], second: items[1] })
    : items[0] || '';
}

/** A preset city id (`sf`, `nyc`) as its English name; any other value unchanged. */
function presetPlaceName(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return Object.hasOwn(CITY_POIS, id) ? CITY_POIS[id].name : value;
}

// A place as the card shows it: a preset city in the interface language,
// whether the call named it ("Tokyo") or gave its id ("tokyo", "nyc").
function shownPlace(value, max) {
  return localizePlaceName(displayName(presetPlaceName(value), max));
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

/** The layer as the card names it, in the active language. */
function shownLayerLabel(result) {
  const name = shownLayerName(result?.label, result?.layerId);
  return spokenLabel(name || t('Layer'));
}

/* ---------------- per-tool builders ---------------- */

function setLayerVisibility(result, args = {}) {
  const label = layerLabel(result);
  if (result?.cancelled) return null;
  if (!result?.ok) {
    const wanted = args.enabled === false ? 'off' : 'on';
    return {
      say: `Couldn't turn ${wanted} ${label}.`,
      display: { title: shownLayerLabel(result), lines: errorLines(result) },
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
      title: switchedTitle(shownLayerLabel(result), on),
      chips: on ? feedChips(result.feedState) : [],
      sources: shownSources(result.source),
    },
  };
}

function flyToLocation(result) {
  const label = spokenLabel(result?.label || result?.query || 'there');
  const title =
    spokenLabel(localizePlaceName(result?.label || result?.query)) ||
    t('there');
  if (result?.cancelled) return null;
  if (!result?.ok) {
    return {
      say: sentence(`Couldn't find ${label}`),
      display: { title, lines: errorLines(result) },
    };
  }
  return {
    say: sentence(result.arrived ? `Over ${label}` : `Flying to ${label}`),
    display: {
      title,
      lines: result.rangeM
        ? [
            t('Camera range {range}', {
              range: shownKm(result.rangeM / 1000),
            }),
          ]
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
        title: frameTitle(result?.layerId),
        lines: errorLines(result),
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
      title: inFrameTitle(result.layerId, count),
      lines: [
        t('Within {radius} of the view', {
          radius: shownKm(result?.radiusKm),
        }),
        result.detectionEnabled ? t('Labels on') : null,
      ].filter(Boolean),
      notes:
        count >= 80 ? [t('Framing uses the nearest 80 loaded contacts')] : [],
    },
    referents,
  };
}

function selectNearestAircraft(result) {
  const location = spokenLabel(
    result?.location?.label || result?.location || 'there',
  );
  const noun = LAYER_NOUNS[result?.layerId] || 'aircraft';
  const shownLocation =
    spokenLabel(
      localizePlaceName(result?.location?.label || result?.location),
    ) || t('there');
  const feed = result?.feed || {};
  const sources = shownSources(feed.source);
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
        title: nearestTitle(result?.layerId),
        lines: errorLines(result),
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
        distance
          ? t('{distance} from {location}', {
              distance: shownKm(aircraft.distanceKm),
              location: shownLocation,
            })
          : null,
        altitude
          ? t('Altitude {altitude}', {
              altitude: shownFeet(aircraft.altitudeM),
            })
          : null,
      ].filter(Boolean),
      chips: feedChips(feed.state),
      sources,
    },
    referents: [
      { n: 1, id: aircraft.id || null, label: name, layerId: result.layerId },
    ],
  };
}

const SPOKEN_ROUTE = Object.freeze({
  between: (origin, destination) => `${origin} to ${destination}`,
  from: (origin) => `from ${origin}`,
  to: (destination) => `to ${destination}`,
});

const SHOWN_ROUTE = Object.freeze({
  between: (origin, destination) =>
    t('{origin} to {destination}', { origin, destination }),
  from: (origin) => t('from {origin}', { origin }),
  to: (destination) => t('to {destination}', { destination }),
});

function routeText(properties, words = SPOKEN_ROUTE) {
  const route = spokenLabel(properties.route || '', 40);
  if (route)
    return route
      .split(/\s*(?:-|→|>)\s*/)
      .reduce((origin, destination) => words.between(origin, destination));
  const origin = spokenLabel(properties.routeOrigin || '', 12);
  const destination = spokenLabel(properties.routeDestination || '', 12);
  if (origin && destination) return words.between(origin, destination);
  if (origin) return words.from(origin);
  if (destination) return words.to(destination);
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
        title: spokenLabel(shownEntityLabel(title)),
        lines: [
          selected.layerName
            ? shownLayerName(selected.layerName, selected.layerId)
            : null,
        ].filter(Boolean),
        sources: shownSources(selected.source),
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
          ? t('Registration {registration}', {
              registration: spokenLabel(properties.registration, 16),
            })
          : null,
        route
          ? t('Route {route}', { route: routeText(properties, SHOWN_ROUTE) })
          : null,
      ].filter(Boolean),
      sources: shownSources(selected.source),
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
      title: t('View state'),
      lines: enabled.map(
        (layer) =>
          `${spokenLabel(shownLayerName(layer.name, layer.id), 32)} · ${layer.count ?? 0} · ${feedStateLabel(layer.feedState || 'nominal')}`,
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
    latitude: item.latitude,
    longitude: item.longitude,
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
        ? tn(drawn.length, 'Marked {count} place', 'Marked {count} places')
        : t('Nothing marked'),
      // The numbered referents list the marks; lines stay for extra facts.
      lines: [],
      notes: [
        ...(failed.length
          ? [t('Not found: {places}', { places: failed.join(', ') })]
          : []),
        ...(result?.outlinePending ? [t('Tracing outlines')] : []),
      ],
    },
    referents,
  };
}

function analystQuery(result) {
  if (!result?.ok || result.cancelled) return null;
  const headline = spokenLabel(analystHeadline(result), 96);
  const state =
    result.feedState ||
    result.feedProvenance?.overall ||
    result.coverage?.feedProvenance?.overall;
  const tag = feedTag(state);
  const scope = spokenLabel(result.scopeLabel || '', 96);
  const answer =
    tag === 'feed unavailable'
      ? sentence(
          `Feed unavailable${scope ? ` ${scope}` : ''}; no authoritative count${result.complete === false ? ', retained coverage is a lower bound' : ''}`,
        )
      : sentence(`${headline}${tag ? `, ${tag}` : ''}`);
  const unanswered = (Array.isArray(result.unanswered) ? result.unanswered : [])
    .map((layer) => spokenLabel(layer, 24))
    .filter(Boolean);
  const missing = unanswered.length
    ? `Partial; ${listPhrase(unanswered.slice(0, 2))}${unanswered.length > 2 ? ` and ${unanswered.length - 2} more` : ''} not answered.`
    : 'Partial answer.';
  return {
    say: `${answer}${result.partial ? ` ${missing}` : ''}`,
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

// frame_overhead targets as the schema names them.
function frameStepLabel(target) {
  switch (target) {
    case 'flights':
      return t('Frame flights');
    case 'military':
      return t('Frame military');
    case 'satellites':
      return t('Frame satellites');
    case 'vessels':
      return t('Frame vessels');
    default:
      return t('Frame {target}', { target });
  }
}

// Plan-step labels for the other tools in actionSchemas. A tool missing here
// shows its raw name in English only.
const STEP_TITLES = Object.freeze({
  zoom_to_globe: msg('Zoom out to globe'),
  show_data_layers_menu: msg('Open data layers'),
  set_panel_open: msg('Open or close a panel'),
  set_voice_inactivity_timeout: msg('Voice inactivity timeout'),
  set_context_mode: msg('Change context mode'),
  control_cockpit: msg('Control cockpit'),
  set_visual_style: msg('Change visual style'),
  set_hud: msg('Adjust HUD'),
  set_cyber_sonar: msg('Adjust cyber sonar'),
  set_detection: msg('Adjust detection overlay'),
  set_map_stack: msg('Change map stack'),
  set_post_processing: msg('Adjust post-processing'),
  control_scene: msg('Control scene'),
  control_cctv: msg('Control CCTV'),
  control_radio: msg('Control radio'),
  track_entity: msg('Track contact'),
  stop_tracking: msg('Stop tracking'),
  clear_annotations: msg('Clear marks'),
  move_camera: msg('Move camera'),
  fly_route: msg('Fly route'),
  analyst_query: msg('Analyst query'),
  next_iss_pass: msg('Next ISS pass'),
  next_satellite_pass: msg('Next satellite pass'),
});

/** A short on-screen label for one tool call in the voice card's plan. */
export function planStepLabel(name, args = {}) {
  if (Object.hasOwn(STEP_TITLES, name)) return t(STEP_TITLES[name]);
  switch (name) {
    case 'annotate_map': {
      const targets = annotationTargets(args);
      if (!targets.length) return t('Mark the map');
      const shown = shownPair(targets.slice(0, 2));
      return targets.length > 2
        ? t('Mark {targets} +{more}', {
            targets: shown,
            more: targets.length - 2,
          })
        : t('Mark {targets}', { targets: shown });
    }
    case 'fly_to_location': {
      const place = args.query || args.locationId;
      return place
        ? t('Fly to {place}', { place: shownPlace(place, 40) })
        : t('Fly to Location');
    }
    case 'select_nearest_aircraft': {
      const place = args.locationQuery || args.locationId;
      return place
        ? t('Nearest aircraft to {place}', { place: shownPlace(place, 32) })
        : t('Nearest aircraft to Here');
    }
    case 'set_layer_visibility': {
      const on = args.enabled !== false;
      const label =
        layerNameForId(args.layerId) ||
        (args.layerId ? displayName(args.layerId, 32) : '');
      // "Layer" alone is a noun the languages inflect the state for.
      if (!label) return on ? t('Layer on') : t('Layer off');
      return switchedTitle(label, on);
    }
    case 'adjust_camera_zoom':
      return args.direction === 'out' ? t('Zoom out') : t('Zoom in');
    case 'get_entity_context':
      return t('Read the view');
    case 'get_current_view_state':
      return t('Check view state');
    case 'frame_overhead':
      return frameStepLabel(spokenLabel(args.target || 'flights', 24));
    default:
      // A tool with no label: its name in English, "Action" elsewhere.
      return getLocale() === 'en'
        ? spokenLabel(String(name || 'Action').replace(/_/g, ' '), 40)
        : t('Action');
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
      return displayName(
        presetPlaceName(args.query || args.locationId || ''),
        32,
      );
    case 'select_nearest_aircraft':
      return displayName(
        presetPlaceName(args.locationQuery || args.locationId || ''),
        32,
      );
    default:
      return '';
  }
}

/** On-screen labels for progress steps. */
const STEP_LABELS = Object.freeze({
  resolve: msg('Finding places'),
  outline: msg('Tracing outline'),
  search: msg('Looking up place'),
  fly: msg('Flying'),
  layer: msg('Turning on layer'),
  refresh: msg('Loading aircraft'),
  nearest: msg('Picking nearest'),
});

/** On-screen label for a progress step. */
export function progressStepLabel(step, label) {
  const base = STEP_LABELS[step]
    ? t(STEP_LABELS[step])
    : step
      ? spokenLabel(step, 24)
      : t('Working');
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
