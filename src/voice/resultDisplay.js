/**
 * The one adapter from a tool result to what the voice card shows.
 *
 * Most tools carry a card-ready `display` ({title, lines, chips, notes,
 * sources}) from their speech builder. The analyst instead returns semantic
 * fields the engine owns (count, complete, scopeLabel, partial, and a
 * `display` of scope, window and caveat). This module turns those into the
 * card shape so every result renders the same way, and names the numbered
 * referents the card lists (the referent registry reads the same answer, so
 * "the second one" always means the second row on screen).
 *
 * What the model receives stays English (`analystHeadline` feeds the spoken
 * answer); the card shows the same answer in the active language.
 *
 * Pure: no DOM, no Cesium.
 * @module voice/resultDisplay
 */

import { voiceLayer } from './layerManifest.js';
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
import { translateStatusLine } from '../ui/statusText.js';
import { formatQuantity } from '../ui/unitLabels.js';

const LAYER_NOUNS = Object.freeze({
  flights: 'aircraft',
  military: 'military aircraft',
  'local-adsb': 'aircraft',
  'ais-live-vessels': 'ships',
  satellites: 'satellites',
  'rocket-launches': 'launches',
  earthquakes: 'earthquakes',
  'local-firms': 'fires',
});

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

export function analystNounFor(layerKeys) {
  const keys = [...new Set(layerKeys.filter(Boolean))];
  if (keys.length !== 1) return 'results';
  const key = keys[0];
  return LAYER_NOUNS[key] || voiceLayer(key)?.aliases?.[0] || 'results';
}

/** The count/scope headline shared by the analyst card and spoken answer. */
const ANALYST_HEADLINE_MAX = 64;
// The card's headline wraps, and a translation runs longer than the English:
// "Al menos 12 aeronaves militares en un radio de 40 km de Los Ángeles" is 67.
// English keeps the spoken bound, so its card title still equals `say`.
const SHOWN_HEADLINE_MAX = 120;

function boundedHeadline(value, max = ANALYST_HEADLINE_MAX) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function analystHeadline(result) {
  const keys = (result?.coverage?.layersQueried || []).map(
    (layer) => layer.layerKey,
  );
  const count = Number(result?.count) || 0;
  const floor = result?.complete === false ? 'At least ' : '';
  return boundedHeadline(
    `${floor}${count.toLocaleString('en-US')} ${analystNounFor(keys)} ${result?.scopeLabel || ''}`,
  );
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
  ].map((text) => [text, text]),
);

const LAYER_STATUS_NOTES = Object.freeze({
  off: (label) => t('{label} off', { label }),
  loading: (label) => t('{label} loading', { label }),
  error: (label) => t('{label} error', { label }),
});

const NOTE_PATTERNS = [
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
  // Transit's empty note when no feed covers the view (transit/queries.js);
  // the model gets the English.
  [
    /^Fly below ([\d,]+) km to a covered region$/,
    ([, km]) =>
      t('Fly below {km} km to a covered region', {
        km: formatNumber(Number(km.replace(/,/g, ''))),
      }),
  ],
  [
    /^No feed here yet · ([\d,]+) regions available$/,
    ([, regions]) => {
      const count = Number(regions.replace(/,/g, ''));
      return tn(
        count,
        'No feed here yet · {n} region available',
        'No feed here yet · {n} regions available',
        { n: formatNumber(count) },
      );
    },
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

function shownNote(text) {
  if (FIXED_NOTES.has(text)) return t(FIXED_NOTES.get(text));
  for (const [pattern, show] of NOTE_PATTERNS) {
    const match = pattern.exec(text);
    const shown = match ? show(match) : null;
    if (shown) return shown;
  }
  // A layer's empty note can be its status line, English pieces joined by
  // " · " ("feeds 1090, 978 stale · 0 heard", "TTC 0 (95s old)").
  const known = translateKnown(text);
  return known !== text ? known : translateStatusLine(text);
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

function analystCard(result) {
  if (!result?.ok) return null;
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
        ...(result.partial ? [{ label: t('partial') }] : []),
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

const ADAPTERS = Object.freeze({
  analyst_query: analystCard,
});

/**
 * What the card shows for one result, or null when it shows nothing (a
 * silent lookup, a refusal, a cancelled call).
 * @param {string} name Tool name.
 * @param {object} result Tool result as the model received it.
 * @param {object} [args] Tool arguments.
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
