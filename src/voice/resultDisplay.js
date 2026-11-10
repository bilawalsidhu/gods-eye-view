/**
 * The one adapter from a tool result to what the voice card shows.
 *
 * Most tools carry a card-ready `display` ({title, lines, chips, notes,
 * sources}) from their speech builder. The analyst, area, imagery and OSM
 * tools instead return semantic fields the engine owns (count, complete,
 * scopeLabel, needsClarification, candidates, and a `display` of scope,
 * source, window and caveat). This module turns those into the card shape so
 * every result renders the same way, and names the numbered referents the
 * card lists (the referent registry reads the same answer, so "the second
 * one" always means the second row on screen).
 *
 * What the model receives stays English (`analystHeadline` feeds the spoken
 * answer); the card shows the same answer in the active language.
 *
 * Pure: no DOM, no Cesium.
 * @module voice/resultDisplay
 */

import { analystNounFor, spokenLabel } from './speech.js';
import {
  formatDate,
  formatNumber,
  getLocale,
  msg,
  t,
  tn,
  translateKnown,
} from '../i18n/index.js';
import { layerNameForId, sourceLabel } from '../ui/layerNames.js';
import { localizePlaceName } from '../ui/placeNames.js';
import { translateStatusMessage } from '../ui/statusText.js';
import { formatQuantity } from '../ui/unitLabels.js';

/** Split "a; b" caveat text into separate notes. */
function notesOf(...values) {
  return [
    ...new Set(
      values
        .flatMap((value) => String(value || '').split(/;\s*/))
        .map((text) =>
          text
            .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    ),
  ];
}

/** The count/scope headline shared by the analyst card and spoken answer. */
const ANALYST_HEADLINE_MAX = 64;
// The card's headline wraps, and a translation runs longer than the English:
// "Al menos 12 aeronaves militares en un radio de 40 km de Los Ángeles" is 67.
// English keeps the spoken bound, so its card title still equals `say`.
const SHOWN_HEADLINE_MAX = 120;

/** Area levels in words. */
const LEVEL_WORDS = Object.freeze({
  admin1: msg('state or province'),
  admin2: msg('county or district'),
  district: msg('neighbourhood'),
  natural: msg('natural region'),
});

function boundedHeadline(value, max = ANALYST_HEADLINE_MAX) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Candidate lines for a clarification: "1 · Punjab — state or province, India". */
function candidateLines(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate, i) => {
    const level = candidate?.level
      ? LEVEL_WORDS[candidate.level]
        ? t(LEVEL_WORDS[candidate.level])
        : candidate.level
      : null;
    const detail = [level, candidate?.region, candidate?.country]
      .filter(Boolean)
      .join(', ');
    return `${i + 1} · ${spokenLabel(candidate?.name || 'Unnamed', 40)}${detail ? ` — ${detail}` : ''}`;
  });
}

function clarification(result, subject) {
  if (!result?.needsClarification) return null;
  return {
    display: {
      title: subject
        ? t('Which {place}?', { place: spokenLabel(subject, 40) })
        : t('Which place?'),
      lines: candidateLines(result.candidates),
    },
    referents: [],
  };
}

/* ---------------- the analyst card in the active language ---------------- */

/**
 * The count and its noun as the card shows them. The English matches
 * `analystNounFor`, one form for any count as the spoken headline has it.
 */
function shownCount(count, noun) {
  const values = { n: formatNumber(count) };
  switch (noun) {
    case 'aircraft':
      return tn(count, '{n} aircraft', '{n} aircraft', values);
    case 'military aircraft':
      return tn(
        count,
        '{n} military aircraft',
        '{n} military aircraft',
        values,
      );
    case 'ships':
      return tn(count, '{n} ships', '{n} ships', values);
    case 'satellites':
      return tn(count, '{n} satellites', '{n} satellites', values);
    case 'launches':
      return tn(count, '{n} launches', '{n} launches', values);
    case 'earthquakes':
      return tn(count, '{n} earthquakes', '{n} earthquakes', values);
    case 'fires':
      return tn(count, '{n} fires', '{n} fires', values);
    case 'fire perimeters':
      return tn(count, '{n} fire perimeters', '{n} fire perimeters', values);
    case 'cyclones':
      return tn(count, '{n} cyclones', '{n} cyclones', values);
    case 'buses':
      return tn(count, '{n} buses', '{n} buses', values);
    case 'bike share':
      return tn(count, '{n} bike share', '{n} bike share', values);
    case 'flock cameras':
      return tn(count, '{n} flock cameras', '{n} flock cameras', values);
    case 'military bases':
      return tn(count, '{n} military bases', '{n} military bases', values);
    case 'datacenters':
      return tn(count, '{n} datacenters', '{n} datacenters', values);
    case 'dams':
      return tn(count, '{n} dams', '{n} dams', values);
    case 'air quality':
      return tn(count, '{n} air quality', '{n} air quality', values);
    case 'results':
      return tn(count, '{n} results', '{n} results', values);
    default:
      return `${values.n} ${noun}`;
  }
}

const shownRadius = (km) => formatQuantity(Number(km), 'km');

const FIXED_SCOPES = new Map(
  [msg('anywhere in the loaded data'), msg('in view')].map((text) => [
    text,
    text,
  ]),
);

/**
 * The engine's scope phrases (analystEngine, the Contacts window in
 * gevActions) as the card shows them. The English is exactly the engine's;
 * a phrase not listed shows as given.
 */
const SCOPE_PATTERNS = [
  [
    /^within (\d+(?:\.\d+)?) km of the view centre$/,
    ([, km]) =>
      t('within {radius} of the view centre', { radius: shownRadius(km) }),
  ],
  [
    /^within (\d+(?:\.\d+)?) km of (.+) \(Contacts window\)$/,
    ([, km, place]) =>
      t('within {radius} of {place} (Contacts window)', {
        radius: shownRadius(km),
        place: localizePlaceName(place),
      }),
  ],
  [
    /^within (\d+(?:\.\d+)?) km of (.+)$/,
    ([, km, place]) =>
      t('within {radius} of {place}', {
        radius: shownRadius(km),
        place: localizePlaceName(place),
      }),
  ],
  [
    /^within (\d+(?:\.\d+)?) km$/,
    ([, km]) => t('within {radius}', { radius: shownRadius(km) }),
  ],
  [/^over (.+)$/, ([, region]) => t('over {region}', { region })],
];

function shownScope(text) {
  const scope = String(text || '').trim();
  if (!scope) return '';
  if (FIXED_SCOPES.has(scope)) return t(FIXED_SCOPES.get(scope));
  for (const [pattern, show] of SCOPE_PATTERNS) {
    const match = pattern.exec(scope);
    if (match) return show(match);
  }
  return translateKnown(scope);
}

/** The analyst headline in the active language, for the card. */
function shownAnalystHeadline(result) {
  const keys = (result?.coverage?.layersQueried || []).map(
    (layer) => layer.layerKey,
  );
  const count = Number(result?.count) || 0;
  const counted = shownCount(count, analystNounFor(keys));
  const items =
    result?.complete === false
      ? t('At least {items}', { items: counted })
      : counted;
  const scope = shownScope(result?.scopeLabel);
  return boundedHeadline(
    scope ? t('{items} {scope}', { items, scope }) : items,
    getLocale() === 'en' ? ANALYST_HEADLINE_MAX : SHOWN_HEADLINE_MAX,
  );
}

/** A layer key as the card names it. */
function shownLayerKey(key) {
  const text = String(key || '').trim();
  return layerNameForId(text) || text;
}

const shownLayerKeys = (list) =>
  String(list || '')
    .split(/,\s*/)
    .map(shownLayerKey)
    .filter(Boolean)
    .join(', ');

/** The feed windows layers declare in the voice manifest. */
const FIXED_WINDOWS = new Map(
  [msg('last 24 h'), msg('past 30 d and upcoming')].map((text) => [text, text]),
);

function shownWindow(text) {
  return String(text || '')
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      FIXED_WINDOWS.has(part)
        ? t(FIXED_WINDOWS.get(part))
        : translateKnown(part),
    )
    .join('; ');
}

const UTC_CLOCK = Object.freeze({
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const UTC_DATE = Object.freeze({
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * The note's ISO snapshot time as the card shows it: "14:32:05 UTC", dated
 * ("15.10.2026, 14:32:05 UTC") when not from today (UTC). English and
 * non-time values show as given.
 */
export function shownSnapshotTime(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (getLocale() === 'en' || !Number.isFinite(time)) return iso;
  const clock = `${formatDate(time, UTC_CLOCK)} UTC`;
  const today = new Date(now).toISOString().slice(0, 10);
  return new Date(time).toISOString().slice(0, 10) === today
    ? clock
    : `${formatDate(time, UTC_DATE)}, ${clock}`;
}

/** Coverage notes and caveats the engine and the action runner write. */
const FIXED_NOTES = new Map(
  [
    msg('the flights layer loads by viewport'),
    msg('distance is ground distance, not overhead'),
    msg(
      'the count is a lower bound because at least one layer reached its retained limit.',
    ),
    // Area, imagery and OSM card lines (areaActions, imageryActions,
    // osmActions); the model gets the English.
    msg('buffer sized to the place'),
    msg('enclosing mapped area'),
    msg('the map was cleared while looking it up'),
    msg('OpenStreetMap coverage varies by place'),
    msg('the catalog covers the last 30 days'),
    msg('there are more'),
  ].map((text) => [text, text]),
);

const LAYER_STATUS_NOTES = Object.freeze({
  off: (label) => t('{label} off', { label }),
  loading: (label) => t('{label} loading', { label }),
  error: (label) => t('{label} error', { label }),
});

const countOf = (text) => Number(String(text).replace(/,/g, ''));

const NOTE_PATTERNS = [
  [
    /^([\d,]+) m around the landmark$/,
    ([, radius]) =>
      t('{radius} m around the landmark', {
        radius: formatNumber(countOf(radius)),
      }),
  ],
  [
    /^([\d,]+) parts$/,
    ([, n]) =>
      tn(countOf(n), '{count} part', '{count} parts', {
        count: formatNumber(countOf(n)),
      }),
  ],
  [
    /^([\d,]+) of ([\d,]+) parts drawn$/,
    ([, drawn, total]) =>
      tn(
        countOf(total),
        '{drawn} of {total} part drawn',
        '{drawn} of {total} parts drawn',
        {
          drawn: formatNumber(countOf(drawn)),
          total: formatNumber(countOf(total)),
        },
      ),
  ],
  [
    /^([\d,]+) duplicate mappings merged$/,
    ([, n]) =>
      tn(
        countOf(n),
        '{count} duplicate mapping merged',
        '{count} duplicate mappings merged',
        { count: formatNumber(countOf(n)) },
      ),
  ],
  [
    /^listed the first ([\d,]+)$/,
    ([, limit]) =>
      t('listed the first {limit}', { limit: formatNumber(countOf(limit)) }),
  ],
  [
    /^counted over the bounding box of (.+), not its outline$/,
    ([, area]) =>
      t('counted over the bounding box of {area}, not its outline', {
        area: spokenLabel(area, 48),
      }),
  ],
  [
    /^counted the first ([\d,]+) loaded records$/,
    ([, returned]) =>
      t('counted the first {returned} loaded records', {
        returned: formatNumber(Number(returned.replace(/,/g, ''))),
      }),
  ],
  [
    /^counted ([\d,]+) of ([\d,]+) loaded records$/,
    ([, returned, total]) =>
      t('counted {returned} of {total} loaded records', {
        returned: formatNumber(Number(returned.replace(/,/g, ''))),
        total: formatNumber(Number(total.replace(/,/g, ''))),
      }),
  ],
  [
    /^(.+) just turned on — still loading, counts will rise$/,
    ([, layers]) =>
      t('{layers} just turned on — still loading, counts will rise', {
        layers: shownLayerKeys(layers),
      }),
  ],
  [
    // The note ends in a period unless a lower-bound clause follows it.
    /^Contacts panel snapshot(?: at (\S+))? — the same retained cohort supplies the card, speech, and follow-up memory(\.?)$/,
    ([, time, period]) =>
      (time
        ? t(
            'Contacts panel snapshot at {time} — the same retained cohort supplies the card, speech, and follow-up memory',
            { time: shownSnapshotTime(time) },
          )
        : t(
            'Contacts panel snapshot — the same retained cohort supplies the card, speech, and follow-up memory',
          )) + period,
  ],
  [
    /^([a-z0-9-]+) (off|loading|error)$/,
    ([, key, status]) =>
      layerNameForId(key)
        ? LAYER_STATUS_NOTES[status](shownLayerKey(key))
        : null,
  ],
  [
    /^([a-z0-9-]+): (.+)$/,
    ([, key, note]) =>
      layerNameForId(key) ? `${shownLayerKey(key)}: ${shownNote(note)}` : null,
  ],
];

/** A card line from a producer's English text, or null when absent. */
function shownLine(text) {
  return text ? shownNote(String(text)) : null;
}

function shownNote(text) {
  if (FIXED_NOTES.has(text)) return t(FIXED_NOTES.get(text));
  for (const [pattern, show] of NOTE_PATTERNS) {
    const match = pattern.exec(text);
    const shown = match ? show(match) : null;
    if (shown) return shown;
  }
  // A layer's empty note can be its coverage note ("Fly below 2,850 km to a
  // covered region") or its status line, English pieces joined by " · "
  // ("feeds 1090, 978 stale · 0 heard", "TTC 0 (95s old)").
  return translateStatusMessage(text);
}

/** Feed states as the card's chips show them; the values stay English. */
const FEED_STATE_LABELS = Object.freeze({
  loading: msg('loading'),
  degraded: msg('degraded'),
  stale: msg('stale'),
  partial: msg('partial'),
  fallback: msg('fallback'),
  unavailable: msg('unavailable'),
});

function shownFeedState(state) {
  const key = FEED_STATE_LABELS[state];
  return key ? t(key) : state;
}

function analystCard(result, args = {}) {
  if (!result?.ok)
    return clarification(result, result?.query || args?.scope?.name);
  const display = result.display || {};
  const unanswered = Array.isArray(result.unanswered) ? result.unanswered : [];
  const provenance = result.feedProvenance || result.coverage?.feedProvenance;
  const sources = [
    ...new Set(
      [...(provenance?.layers || []), ...(result.coverage?.layersQueried || [])]
        .map((layer) =>
          String(layer?.source || '')
            .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    ),
  ].map((label) => ({ label }));
  return {
    display: {
      title: shownAnalystHeadline(result),
      // The precise scope, unless the title already says exactly that.
      lines: [
        display.scope !== result.scopeLabel ? shownScope(display.scope) : null,
        shownWindow(display.window),
      ].filter(Boolean),
      chips: [
        ...(result.feedState && result.feedState !== 'nominal'
          ? [{ label: shownFeedState(result.feedState) }]
          : []),
        // A partial feed state already says it.
        ...(result.partial && result.feedState !== 'partial'
          ? [{ label: t('partial') }]
          : []),
      ],
      // Coverage qualifications lead the feed detail. The bounded card groups
      // overflow in its existing Notes disclosure rather than dropping them.
      preserveNotes: true,
      notes: [
        ...notesOf(result.coverage?.note, display.caveat).map(shownNote),
        ...(unanswered.length
          ? [
              t('Not answered: {layers}', {
                layers: unanswered.map(shownLayerKey).join(', '),
              }),
            ]
          : []),
      ],
      sources: sources.map(({ label }) => ({ label: sourceLabel(label) })),
    },
    referents: Array.isArray(result.items) ? result.items : [],
    resultSet: true,
  };
}

function areaCard(result, args = {}) {
  if (!result?.ok) return clarification(result, result?.query || args.query);
  const display = result.display || {};
  const km2 = Number(result.areaKm2);
  return {
    display: {
      title: `${result.name ? spokenLabel(result.name, 48) : t('Area', { context: 'voice area' })}${result.country ? `, ${spokenLabel(result.country, 24)}` : ''}`,
      lines: [
        Number.isFinite(km2) && km2 > 0 ? `${formatNumber(km2)} km²` : null,
        shownLine(display.basis),
        shownLine(display.parts),
        shownLine(display.drawnParts),
        result.notDrawn
          ? t('Not drawn: {parts}', { parts: shownNote(result.notDrawn) })
          : null,
      ].filter(Boolean),
      chips: [
        ...(result.approximate ? [{ label: t('approximate') }] : []),
        ...(result.partial ? [{ label: shownFeedState('partial') }] : []),
      ],
      notes: notesOf(display.caveat).map(shownNote),
      sources: display.source ? [{ label: display.source }] : [],
    },
    referents: [],
  };
}

const capitalized = (text) =>
  text
    ? `${String(text).charAt(0).toUpperCase()}${String(text).slice(1)}`
    : null;

function imageryCard(result) {
  if (!result?.ok) return null;
  const display = result.display || {};
  const shown = result.shown;
  const lines = shown
    ? [
        shown.cloudPct !== null && shown.cloudPct !== undefined
          ? t('{pct}% cloud', { pct: formatNumber(shown.cloudPct) })
          : null,
        result.area
          ? t('Over {area}', { area: spokenLabel(result.area, 48) })
          : null,
        tn(
          Number(result.total) || 0,
          '{count} of {total} acquisitions match',
          '{count} of {total} acquisitions match',
          {
            count: formatNumber(Number(result.count) || 0),
            total: formatNumber(Number(result.total) || 0),
          },
        ),
        capitalized(shownLine(display.window)),
      ]
    : [
        tn(
          Number(result.total) || 0,
          '{n} acquisitions searched',
          '{n} acquisitions searched',
          { n: formatNumber(Number(result.total) || 0) },
        ),
        capitalized(shownLine(display.window)),
      ];
  return {
    display: {
      title: shown
        ? `${spokenLabel(shown.source, 32)} · ${shown.date}`
        : t('No matching imagery'),
      lines: lines.filter(Boolean),
      chips:
        shown && !shown.onMap ? [{ label: shownFeedState('loading') }] : [],
      notes: notesOf(display.caveat).map(shownNote),
    },
    referents: [],
  };
}

function osmCard(result) {
  if (!result?.ok) return null;
  const display = result.display || {};
  const count = Number(result.count);
  // The kind is the preset's English noun, the model's data; one place takes
  // its singular ("1 hospital").
  const kind = spokenLabel(
    (count === 1 && result.kindSingular) || result.kind || 'places',
    32,
  );
  const values = { count: formatNumber(count), kind };
  const title = !Number.isFinite(count)
    ? t('Unknown number of {kind}', { kind })
    : result.countScope === 'bounding-box'
      ? t('About {count} {kind}', values)
      : result.complete === false
        ? t('At least {count} {kind}', values)
        : t('{count} {kind}', values);
  return {
    display: {
      title,
      lines: [
        result.area
          ? t('In {area}', { area: spokenLabel(result.area, 48) })
          : null,
        shownLine(display.merged),
      ].filter(Boolean),
      notes: notesOf(display.caveat).map(shownNote),
      sources: display.source ? [{ label: display.source }] : [],
    },
    referents: Array.isArray(result.referents) ? result.referents : [],
    resultSet: true,
  };
}

const ADAPTERS = Object.freeze({
  analyst_query: analystCard,
  resolve_area: areaCard,
  find_imagery: imageryCard,
  osm_query: osmCard,
});

/**
 * What the card shows for one result, or null when it shows nothing (a
 * silent lookup, a refusal without a question, a cancelled call).
 * @param {string} name Tool name.
 * @param {object} result Tool result as the model received it.
 * @param {object} [args] Tool arguments (names a clarification's subject).
 * @returns {{display: object, referents: Array<object>, resultSet?: boolean}|null}
 *   `resultSet` marks a fresh answer set that replaces the numbered list
 *   even when empty.
 */
export function presentResult(name, result, args = {}) {
  if (!result || typeof result !== 'object' || result.cancelled) return null;
  if (result.schedule === 'silent') return null;
  const adapter = ADAPTERS[name];
  if (adapter) {
    try {
      const card = adapter(result, args || {});
      if (card?.display?.title) return card;
    } catch {
      /* Presentation never breaks a result. */
    }
    return null;
  }
  if (!result.display?.title) return null;
  return {
    display: result.display,
    referents: Array.isArray(result.referents) ? result.referents : [],
  };
}
