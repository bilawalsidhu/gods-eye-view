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
 * These lines are the app's OWN spoken replies and card lines: they are
 * composed after the model has spoken, then read aloud and painted, so they
 * translate through `t()` at compose time (I18N.md rule 5). Translation never
 * changes what the model hears or says — only what GEV says back and shows.
 */

import { analystHeadline } from './resultDisplay.js';
import { t } from '../i18n/index.js';

/** Layer nouns, as message keys resolved at compose time. */
const LAYER_NOUN_KEYS = Object.freeze({
  flights: 'voice.noun.aircraft',
  military: 'voice.noun.militaryAircraft',
  'ais-live-vessels': 'voice.noun.ships',
  satellites: 'voice.noun.satellites',
});

/** Feed states that change what a spoken answer means (keys, not text). */
const MATERIAL_FEED_TAG_KEYS = Object.freeze({
  stale: 'voice.tag.stale',
  degraded: 'voice.tag.degraded',
  unavailable: 'voice.tag.feedUnavailable',
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
  if (list.length === 2) {
    return `${list[0]}${t('voice.speech.and')}${list[1]}`;
  }
  return `${list
    .slice(0, -1)
    .join(
      t('voice.speech.listSeparator'),
    )}${t('voice.speech.and')}${list.at(-1)}`;
}

/** Join clause fragments ('Selected X', '12 km from Y') for speaking. */
function commaPhrase(parts) {
  return parts.filter(Boolean).join(t('voice.speech.commaSeparator'));
}

function feet(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round((value * 3.28084) / 100) * 100;
  return t('voice.unit.feet', { n: rounded.toLocaleString('en-US') });
}

function kilometers(km) {
  const value = Number(km);
  if (!Number.isFinite(value)) return null;
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} km`;
}

function sentence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  return /[.!?…。！？]$/.test(trimmed)
    ? trimmed
    : `${trimmed}${t('voice.speech.fullStop')}`;
}

function feedTag(state) {
  const key = MATERIAL_FEED_TAG_KEYS[state];
  return key ? t(key) : null;
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

function layerNoun(layerId, fallbackKey) {
  const key = LAYER_NOUN_KEYS[layerId];
  return t(key || fallbackKey);
}

function layerLabel(result) {
  return spokenLabel(result?.label || result?.layerId || t('voice.noun.layer'));
}

/* ---------------- per-tool builders ---------------- */

function setLayerVisibility(result, args = {}) {
  const label = layerLabel(result);
  if (result?.cancelled) return null;
  if (!result?.ok) {
    const wanted = args.enabled === false ? 'layerOffFailed' : 'layerOnFailed';
    return {
      say: t(`voice.speech.${wanted}`, { label }),
      display: { title: label, lines: [result?.error].filter(Boolean) },
    };
  }
  const on = result.enabled !== false;
  const tag = on ? feedTag(result.feedState) : null;
  const say =
    on && result.feedState === 'unavailable'
      ? t('voice.speech.layerOnFeedUnavailable', { label })
      : sentence(
          `${t(on ? 'voice.speech.layerOn' : 'voice.speech.layerOff', { label })}${tag ? t('voice.speech.tagSuffix', { tag }) : ''}`,
        );
  return {
    say,
    display: {
      title: t(on ? 'voice.speech.layerOn' : 'voice.speech.layerOff', {
        label,
      }),
      chips: on ? feedChips(result.feedState) : [],
      sources: result.source ? [{ label: result.source }] : [],
    },
  };
}

function flyToLocation(result) {
  const label = spokenLabel(
    result?.label || result?.query || t('voice.common.there'),
  );
  if (result?.cancelled) return null;
  if (!result?.ok) {
    return {
      say: sentence(t('voice.speech.findFailed', { label })),
      display: { title: label, lines: [result?.error].filter(Boolean) },
    };
  }
  return {
    say: sentence(
      t(result.arrived ? 'voice.speech.arrived' : 'voice.speech.flyingTo', {
        label,
      }),
    ),
    display: {
      title: label,
      lines: result.rangeM
        ? [
            t('voice.speech.cameraRange', {
              range: kilometers(result.rangeM / 1000),
            }),
          ]
        : [],
    },
  };
}

function frameOverhead(result) {
  const noun = layerNoun(result?.layerId, 'voice.noun.contacts');
  const radius = kilometers(result?.radiusKm);
  if (result?.cancelled) return null;
  if (!result?.ok) {
    // Absence is asserted only for an explicit empty query; a refused or
    // unavailable camera move says the frame did not happen.
    const error = result?.error || '';
    let say;
    if (/not enabled/i.test(error))
      say = t('voice.speech.layerOffFrame', { noun });
    else if (result?.count === 0 && radius)
      say = t('voice.speech.noneWithin', { noun, radius });
    else if (/unknown target/i.test(error))
      say = t('voice.speech.cannotFrameLayer');
    else say = t('voice.speech.frameFailed', { noun });
    return {
      say,
      display: {
        title: t('voice.speech.frameTitle', { noun }),
        lines: [result?.error].filter(Boolean),
      },
    };
  }
  // The layer query returns at most 80, so a full page is a lower bound.
  const count = Number(result.count) || 0;
  const countText =
    count >= 80 ? t('voice.speech.atLeast', { count }) : String(count);
  const referents = (result.nearest || [])
    .filter((entry) => entry?.label || entry?.id)
    .map((entry, index) => ({
      n: index + 1,
      id: entry.icao24 || entry.mmsi || entry.id || null,
      label: spokenLabel(entry.label || entry.id),
      layerId: result.layerId,
    }));
  return {
    say: sentence(t('voice.speech.framed', { count: countText, noun, radius })),
    display: {
      title: t('voice.speech.inFrameTitle', { count, noun }),
      lines: [
        radius ? t('voice.speech.withinView', { radius }) : null,
        result.detectionEnabled ? t('voice.speech.labelsOn') : null,
      ].filter(Boolean),
      notes: count >= 80 ? [t('voice.speech.frameNote')] : [],
    },
    referents,
  };
}

function selectNearestAircraft(result) {
  const location = spokenLabel(
    result?.location?.label || result?.location || t('voice.common.there'),
  );
  const noun = layerNoun(result?.layerId, 'voice.noun.aircraft');
  const feed = result?.feed || {};
  const sources = feed.source ? [{ label: feed.source }] : [];
  if (result?.cancelled) return null;
  if (!result?.ok) {
    let say;
    if (result?.stage === 'location')
      say = t('voice.speech.cannotReach', { location });
    else if (feed.state === 'unavailable')
      say = t('voice.speech.aircraftFeedUnavailable');
    else if (result?.stage === 'nearest')
      say = t('voice.speech.noneLoadedNear', { noun, location });
    else if (result?.stage === 'layer')
      say = t('voice.speech.nounOnFailed', { noun });
    else say = t('voice.speech.nearestFailed', { noun });
    return {
      say,
      display: {
        title: t('voice.speech.nearestTitle', { noun }),
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
    commaPhrase([
      t('voice.speech.selected', { name }),
      distance ? t('voice.speech.distanceFrom', { distance, location }) : null,
      altitude,
      tag,
    ]),
  );
  return {
    say,
    display: {
      title: name,
      lines: [
        distance
          ? t('voice.speech.distanceFrom', { distance, location })
          : null,
        altitude ? t('voice.speech.altitudeLine', { altitude }) : null,
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
  if (route)
    return route.replace(/\s*(?:-|→|>)\s*/g, t('voice.speech.routeTo'));
  const origin = spokenLabel(properties.routeOrigin || '', 12);
  const destination = spokenLabel(properties.routeDestination || '', 12);
  if (origin && destination)
    return t('voice.speech.routeOriginDestination', { origin, destination });
  if (origin) return t('voice.speech.routeFromOrigin', { origin });
  if (destination) return t('voice.speech.routeToDestination', { destination });
  return null;
}

function getEntityContext(result) {
  const selected = result?.selected;
  if (!result?.ok || !selected) return null;
  const properties = selected.properties || {};
  const isAircraft =
    selected.layerId === 'flights' || selected.layerId === 'military';
  const title = spokenLabel(
    properties.callsign ||
      selected.name ||
      selected.id ||
      t('voice.common.selection'),
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
    commaPhrase([
      title,
      spokenLabel(properties.operator || '', 32) ||
        t('voice.speech.operatorUnknown'),
      spokenLabel(properties.type || '', 32) || t('voice.speech.typeUnknown'),
      route || t('voice.speech.noRoute'),
    ]),
  );
  return {
    say: null,
    identityLine,
    display: {
      title,
      lines: [
        properties.registration
          ? t('voice.speech.registrationLine', {
              reg: spokenLabel(properties.registration, 16),
            })
          : null,
        route ? t('voice.speech.routeLine', { route }) : null,
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
      ? t('voice.speech.kmUp', {
          n: Math.round(heightM / 1000).toLocaleString('en-US'),
        })
      : t('voice.speech.mUp', { n: Math.round(heightM) })
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
    height ? t('voice.speech.cameraHeight', { height }) : null,
    t('voice.speech.styleLine', { style }),
    names.length
      ? t('voice.speech.layersOn', {
          layers:
            listPhrase(names.slice(0, 4)) +
            (names.length > 4
              ? t('voice.speech.andMore', { count: names.length - 4 })
              : ''),
        })
      : t('voice.speech.noLayersOn'),
    tagged.length ? listPhrase(tagged.slice(0, 2)) : null,
  ];
  const sentenceSeparator = t('voice.speech.sentenceSeparator');
  return {
    say: parts
      .filter(Boolean)
      .map((part) => sentence(part[0].toUpperCase() + part.slice(1)))
      .join(sentenceSeparator),
    display: {
      title: t('voice.speech.viewStateTitle'),
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
    latitude: item.latitude,
    longitude: item.longitude,
  }));
  const sentenceSeparator = t('voice.speech.sentenceSeparator');
  const parts = [];
  if (failed.length)
    parts.push(
      t('voice.speech.placeFailed', {
        labels: listPhrase(failed.slice(0, 3)),
      }),
    );
  if (result?.ok && result.routeFallback)
    parts.push(t('voice.speech.straightLineNote'));
  if (result?.capped) parts.push(t('voice.speech.mapFull'));
  return {
    // Successful marks are not announced; the model keeps explaining.
    say: parts.length ? parts.join(sentenceSeparator) : null,
    display: {
      title: result?.ok
        ? t('voice.speech.marked', { count: drawn.length })
        : t('voice.speech.nothingMarked'),
      // The numbered referents list the marks; lines stay for extra facts.
      lines: [],
      notes: [
        ...(failed.length
          ? [
              t('voice.speech.notFound', {
                labels: failed.join(t('voice.speech.listSeparator')),
              }),
            ]
          : []),
        ...(result?.outlinePending ? [t('voice.speech.tracingOutlines')] : []),
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
    state === 'unavailable'
      ? sentence(
          t('voice.speech.feedUnavailableHead', {
            scope: scope ? ` ${scope}` : '',
            tail:
              result.complete === false ? t('voice.speech.lowerBoundTail') : '',
          }),
        )
      : sentence(
          `${headline}${tag ? t('voice.speech.tagSuffix', { tag }) : ''}`,
        );
  const unanswered = (Array.isArray(result.unanswered) ? result.unanswered : [])
    .map((layer) => spokenLabel(layer, 24))
    .filter(Boolean);
  const missing = unanswered.length
    ? t('voice.speech.partialMissing', {
        layers:
          listPhrase(unanswered.slice(0, 2)) +
          (unanswered.length > 2
            ? t('voice.speech.andMore', { count: unanswered.length - 2 })
            : ''),
      })
    : t('voice.speech.partialAnswer');
  return {
    say: `${answer}${result.partial ? `${t('voice.speech.sentenceSeparator')}${missing}` : ''}`,
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
        ? t('voice.plan.markTargets', {
            targets: listPhrase(targets.slice(0, 2)),
            extra:
              targets.length > 2
                ? t('voice.plan.markMore', { count: targets.length - 2 })
                : '',
          })
        : t('voice.plan.markMap');
    }
    case 'fly_to_location':
      return t('voice.plan.flyTo', {
        target: displayName(
          args.query || args.locationId || t('voice.noun.location'),
          40,
        ),
      });
    case 'select_nearest_aircraft':
      return t('voice.plan.nearestTo', {
        target: displayName(
          args.locationQuery || args.locationId || t('voice.common.here'),
          32,
        ),
      });
    case 'set_layer_visibility':
      return t(
        args.enabled === false
          ? 'voice.speech.layerOff'
          : 'voice.speech.layerOn',
        {
          label: displayName(args.layerId || t('voice.noun.layer'), 32),
        },
      );
    case 'get_entity_context':
      return t('voice.plan.readView');
    case 'get_current_view_state':
      return t('voice.plan.checkViewState');
    case 'frame_overhead':
      return t('voice.plan.frame', {
        target: spokenLabel(args.target || 'flights', 24),
      });
    default:
      return spokenLabel(
        String(name || t('voice.plan.fallback')).replace(/_/g, ' '),
        40,
      );
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
    default:
      return '';
  }
}

/** On-screen labels for progress steps (message keys). */
const STEP_LABEL_KEYS = Object.freeze({
  resolve: 'voice.progress.resolve',
  outline: 'voice.progress.outline',
  search: 'voice.progress.search',
  fly: 'voice.progress.fly',
  layer: 'voice.progress.layer',
  refresh: 'voice.progress.refresh',
  nearest: 'voice.progress.nearest',
});

/** On-screen label for a progress step. */
export function progressStepLabel(step, label) {
  const key = STEP_LABEL_KEYS[step];
  const base = key
    ? t(key)
    : spokenLabel(step || t('voice.progress.working'), 24);
  return label
    ? `${base}${t('voice.progress.separator')}${spokenLabel(label, 32)}`
    : base;
}

/**
 * Spoken progress line for a slow tool's current step, or null when the step
 * should stay silent. Lines are code-authored: no hedges, no invented facts.
 */
export function progressLine(step, label) {
  const place = spokenLabel(label, 32);
  switch (step) {
    case 'resolve':
      return place
        ? t('voice.spoken.findingPlace', { place })
        : t('voice.spoken.findingPlaces');
    case 'search':
      return place ? t('voice.spoken.lookingUp', { place }) : null;
    case 'fly':
      return place ? t('voice.spoken.headingTo', { place }) : null;
    case 'layer':
      return place ? t('voice.spoken.turningOn', { place }) : null;
    case 'refresh':
      return t('voice.spoken.loadingAircraft');
    case 'nearest':
      return t('voice.spoken.pickingNearest');
    case 'still':
      return place
        ? t('voice.spoken.stillWorkingPlace', { place })
        : t('voice.spoken.stillWorking');
    default:
      return null;
  }
}
