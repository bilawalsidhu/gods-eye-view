/**
 * Layer status texts in the UI language.
 *
 * Layers report errors, loading labels and status notes as English data
 * (stats, analyst records, what the model receives); the Layers panel, the
 * loading chip, layer cards and the voice card show them translated through
 * here, by their shape.
 *
 * Pure: imports only i18n and layer names, no DOM.
 * @module ui/statusText
 */
import { sourceLabel } from './layerNames.js';
import { formatNumber, msg, t, tn, translateKnown } from '../i18n/index.js';

const STATUS_SEPARATOR = ' · ';

// Live-source failures arrive as English data (src/sources/live/contract.js,
// standalone.js, flights and military ingestion), some with a source name or a
// number in them; the row shows them in the UI language. Keep these in step
// with the producers. Anything else shows its catalog entry, or as it came.
const FEED_ERRORS = new Set([
  msg('OpenSky OAuth client missing/invalid'),
  msg('OpenSky OAuth rejected credentials'),
  msg('OpenSky username/password rejected'),
  msg('OpenSky auth missing'),
  msg('OpenSky auth required'),
  msg('OpenSky auth invalid'),
  msg('OpenSky auth failed'),
]);
const FEED_ERROR_PATTERNS = [
  // Street Level provider errors (providers/{kartaview,panoramax}/source.js),
  // ahead of the generic "<source> HTTP <status>".
  [
    /^KartaView answered HTTP (\d+)$/,
    ([, status]) => t('KartaView answered HTTP {status}', { status }),
  ],
  [
    /^Panoramax answered HTTP (\d+)$/,
    ([, status]) => t('Panoramax answered HTTP {status}', { status }),
  ],
  [
    /^KartaView refused the request \(code (-?\d+)\)$/,
    ([, code]) => t('KartaView refused the request (code {code})', { code }),
  ],
  // Weather imagery (weather/source.js, infraredImage.js) and vector tile
  // (sources/vectorTiles.js) failures carry their own wording; the generic
  // pattern below would take "Weather image" for a source name.
  [
    /^Weather (image )?HTTP (\d+)$/,
    ([, image, status]) =>
      image
        ? t('Weather image HTTP {status}', { status })
        : t('Weather HTTP {status}', { status }),
  ],
  [
    /^Vector tiles unavailable \(HTTP (\d+)\)$/,
    ([, status]) => t('Vector tiles unavailable (HTTP {status})', { status }),
  ],
  // Layer statuses with a number or a feed name in them: GNSS
  // (gnss/source.js), CelesTrak groups (satellites/ingestion.js) and transit
  // feeds (transit/ingestion.js).
  [
    /^GNSS feed unavailable \(HTTP (\d{3})\)$/,
    ([, status]) => t('GNSS feed unavailable (HTTP {status})', { status }),
  ],
  [
    /^(\d+) CelesTrak groups? unavailable$/,
    ([, groups]) =>
      tn(
        Number(groups),
        '{count} CelesTrak group unavailable',
        '{count} CelesTrak groups unavailable',
        { count: formatNumber(Number(groups)) },
      ),
  ],
  [
    /^(.+) feed unavailable$/,
    ([, feed]) => t('{feed} feed unavailable', { feed: translateKnown(feed) }),
  ],
  [
    /^Source snapshot (\d+) min old$/,
    ([, minutes]) => t('Source snapshot {minutes} min old', { minutes }),
  ],
  [
    /^(.+) rate limited \(anonymous\)$/,
    ([, source]) =>
      t('{source} rate limited (anonymous)', { source: sourceLabel(source) }),
  ],
  [
    /^(.+) rate limited$/,
    ([, source]) => t('{source} rate limited', { source: sourceLabel(source) }),
  ],
  [
    /^(.+) HTTP (\d{3})$/,
    ([, source, status]) =>
      t('{source} HTTP {status}', { source: sourceLabel(source), status }),
  ],
  [
    /^(.+) network error$/,
    ([, source]) =>
      t('{source} network error', { source: sourceLabel(source) }),
  ],
  [
    /^Malformed (.+) aircraft rows$/,
    ([, source]) =>
      t('Malformed {source} aircraft rows', { source: sourceLabel(source) }),
  ],
  [
    /^Malformed (.+) response$/,
    ([, source]) =>
      t('Malformed {source} response', { source: sourceLabel(source) }),
  ],
];

/** One error text in the UI language, or null when nothing matches. */
function feedErrorText(text) {
  if (FEED_ERRORS.has(text)) return t(text);
  const known = translateKnown(text);
  if (known !== text) return known;
  for (const [pattern, format] of FEED_ERROR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return format(match);
  }
  return null;
}

/**
 * A layer's error text in the UI language (see FEED_ERRORS). An error made of
 * several statuses joined by " · " (Local ADS-B) translates piece by piece,
 * and so does a lone status piece ("feed 1090 unreachable").
 */
export function translateFeedError(text) {
  if (typeof text !== 'string') return text;
  const whole = feedErrorText(text);
  if (whole !== null) return whole;
  // feedErrorText has already looked the text up in the catalog.
  if (!text.includes(STATUS_SEPARATOR)) return statusPatternText(text) ?? text;
  return text
    .split(STATUS_SEPARATOR)
    .map((piece) => feedErrorText(piece) ?? statusPatternText(piece) ?? piece)
    .join(STATUS_SEPARATOR);
}

// A decoder feed with no band is named by the server's "entry N" (its place
// in LOCAL_RECEIVER_FEEDS, server/providers/local-receivers.js).
const FEED_ENTRY = /^entry (\d+)$/;

function shownFeedName(name) {
  const entry = FEED_ENTRY.exec(name);
  return entry ? t('entry {n}', { n: entry[1] }) : name;
}

// Feed states named in a Local ADS-B feed problem ("feeds 1090, 978 stale").
const FEED_PROBLEM_FORMS = Object.freeze({
  stale: (count, names) =>
    tn(count, 'feed {names} stale', 'feeds {names} stale', { names }),
  unreachable: (count, names) =>
    tn(count, 'feed {names} unreachable', 'feeds {names} unreachable', {
      names,
    }),
  invalid: (count, names) =>
    tn(count, 'feed {names} invalid', 'feeds {names} invalid', { names }),
});

// Working texts with a number or a name in them arrive as English data, one
// piece of a " · " joined line each: transit (transit/queries.js) and Local
// ADS-B (localAdsb/status.js). The Layers panel and the voice card's analyst
// notes show them through here. Keep these in step with the producers.
const STATUS_PIECE_PATTERNS = [
  [/^Loading (.+)$/, ([, feeds]) => t('Loading {feeds}', { feeds })],
  [
    /^(\d+) heard$/,
    ([, heard]) =>
      tn(Number(heard), '{count} heard', '{count} heard', {
        count: formatNumber(Number(heard)),
      }),
  ],
  [
    /^(USB )?(\d+(?:\.\d+)?) msg\/s$/,
    ([, usb, rate]) =>
      usb
        ? t('USB {rate} msg/s', { rate: formatNumber(Number(rate)) })
        : t('{rate} msg/s', { rate: formatNumber(Number(rate)) }),
  ],
  [
    /^(\d+) feeds? live$/,
    ([, live]) =>
      tn(Number(live), '{count} feed live', '{count} feeds live', {
        count: formatNumber(Number(live)),
      }),
  ],
  [
    /^feeds? (.+) (stale|unreachable|invalid)$/,
    ([, names, status]) => {
      const list = names.split(', ');
      return FEED_PROBLEM_FORMS[status](
        list.length,
        list.map(shownFeedName).join(', '),
      );
    },
  ],
  // A quiet transit feed in the coverage line, "TTC 0 (95s old)"
  // (transit/queries.js); the feed name and the numbers stay as they came.
  [
    /^(.+) (\d+) \((\d+)s old\)$/,
    ([, feed, count, seconds]) =>
      t('{feed} {count} ({seconds}s old)', { feed, count, seconds }),
  ],
];

/** A status piece by its shape in the UI language, or null. */
function statusPatternText(piece) {
  for (const [pattern, format] of STATUS_PIECE_PATTERNS) {
    const match = pattern.exec(piece);
    if (match) return format(match);
  }
  return null;
}

/** One piece of a status line in the UI language, or as it came. */
function translateStatusPiece(piece) {
  const known = translateKnown(piece);
  if (known !== piece) return known;
  return statusPatternText(piece) ?? piece;
}

/** A status line of " · " joined pieces in the UI language, piece by piece. */
export function translateStatusLine(text) {
  return text
    .split(STATUS_SEPARATOR)
    .map(translateStatusPiece)
    .join(STATUS_SEPARATOR);
}
