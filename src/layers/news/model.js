// Pure presentation model for the news layer: severity, category glyphs,
// attestation, marker looks and placement, the feed's filters and paging, and
// the event cards the News panel and the globe show. No Cesium, no DOM.

import { getLocale, msg, t, tn } from '../../i18n/index.js';

export const NEWS_LAYER_ID = 'news';
export const NEWS_OVERLAY_SOURCE_ID = 'news';
export const NEWS_PICK_PREFIX = 'news:';
export const NEWS_FEED_PAGE = 60;
export const NEWS_MAP_LIMIT = 500;
/** News is real time only: nothing older than a day is shown anywhere. */
export const NEWS_WINDOW_MS = 24 * 3_600_000;

/**
 * The window a server serves, in ms: its `windowHours` (a whole number of
 * hours up to 24; a host may serve fewer), else the full day.
 */
export function newsWindowMs(hours) {
  return Number.isInteger(hours) && hours >= 1 && hours <= 24
    ? hours * 3_600_000
    : NEWS_WINDOW_MS;
}

/** The windows the News panel offers, longest first. */
export const NEWS_WINDOW_CHOICES = Object.freeze([24, 12, 6, 3, 1]);

/**
 * The windows offered under a server's own window of `maxHours`: that window
 * itself, then each shorter choice.
 */
export function newsWindowChoices(maxHours) {
  const cap = newsWindowMs(maxHours) / 3_600_000;
  return [cap, ...NEWS_WINDOW_CHOICES.filter((hours) => hours < cap)];
}
// A publish time this far ahead of the clock is skew, not a future story
// (as data/regionalNewsWindow.js).
const NEWS_CLOCK_SKEW_MS = 15 * 60_000;
/** At most this many reports are kept in the feed list, newest first. */
export const NEWS_FEED_MAX = 600;
// Above this camera height the layer shows one beacon per hotspot; below it
// (or once a hotspot is chosen) the outlines and individual reports.
export const NEWS_DETAIL_MAX_HEIGHT_M = 2_500_000;
// "In view": reports near the view centre, only once the camera is low enough
// for "here" to mean a region, read again when it settles in a new cell.
// Near is inside the area the server names there (a country, a large
// country's state, a disputed area), else, at sea, within the radius.
export const NEWS_IN_VIEW_MAX_HEIGHT_M = 3_000_000;
export const NEWS_IN_VIEW_RADIUS_KM = 500;
export const NEWS_IN_VIEW_LIMIT = 12;
/** The Local section lists at most this many reports near the view centre. */
export const NEWS_LOCAL_LIMIT = 40;
/**
 * The News panel's sections: Conflicts (the hotspots' significant news, on the
 * map whenever the layer is on) and Local (everything near the view centre,
 * on the map while the section is chosen).
 */
export const NEWS_SECTIONS = Object.freeze(['conflicts', 'local']);
export const NEWS_SETTLE_MS = 800;
export const NEWS_CELL_DEG = 0.5;
/** A feed card's click flies the camera to this height over the event. */
export const NEWS_FOCUS_HEIGHT_M = 150_000;
// Minor news (a broad outlet's prices, sport, health) is left out unless asked for.
export const NEWS_RELEVANT = 'core,related';

const SOURCE_LABEL = msg('Source');
const DISPUTED = msg('Disputed: {name}');
const VIA = msg('via {source}');
const MEDIA_LABELS = { video: msg('Video'), photo: msg('Photos') };
const CLAIMED_BY = msg('Claimed by {who}');
const CLAIMED = msg('Claimed');
const UNCONFIRMED = msg('Not yet confirmed by others');
const REPORTED_BY_SIDE = msg('Reported by {side} sources');
const REPORTED_BY_SIDES = msg('Reported by {sides}');
const SIDE_SOURCES = msg('{side} sources');
const OFFICIAL = msg('Official');
const OFFICIAL_AFFILIATIONS = new Set(['military', 'state']);
const ATTESTATION = {
  'both-sides': msg('Reported by both sides'),
  independent: msg('Independently reported'),
  single: msg('Single source'),
};
const NEUTRAL_SIDES = Object.freeze({
  intl: msg('International'),
  independent: msg('Independent'),
  unknown: msg('Unattributed'),
  external: msg('Outside party'),
});

/**
 * Short chip names for the curated hotspots; the API's own English name is
 * the fallback for any other.
 */
export const NEWS_HOTSPOT_LABELS = Object.freeze({
  'ua-ru-war': msg('Ukraine–Russia'),
  'israel-gaza-lebanon': msg('Israel–Gaza–Lebanon'),
  'iran-hormuz': msg('Iran–Hormuz'),
  yemen: msg('Yemen–Red Sea'),
  'sudan-war': msg('Sudan'),
  sahel: msg('Sahel'),
  elsewhere: msg('Elsewhere'),
  // Core's own news (no news server): the world is one hotspot.
  worldwide: msg('Worldwide'),
});

/** A hotspot's chip label in the interface language. */
export function hotspotLabel(hotspot) {
  const key = NEWS_HOTSPOT_LABELS[hotspot?.id];
  if (key) return t(key);
  return hotspot?.catchAll ? t(NEWS_HOTSPOT_LABELS.elsewhere) : hotspot?.name;
}

/** A country's name in the interface language, from its ISO code. */
export function countryName(code) {
  if (!code) return '';
  try {
    return (
      new Intl.DisplayNames([getLocale(), 'en'], { type: 'region' }).of(code) ||
      code
    );
  } catch {
    return code;
  }
}

const AREA_IN_COUNTRY = msg('{region}, {country}');

/**
 * The Local section's area in the interface language: a country by its code,
 * a state with its country, a disputed area by its own name only.
 */
export function areaLabel(area) {
  if (!area) return '';
  if (area.kind === 'disputed' || !area.country) return area.name;
  if (area.kind === 'country') return countryName(area.country);
  return t(AREA_IN_COUNTRY, {
    region: area.name,
    country: countryName(area.country),
  });
}

/** Label for a disputed area on the map: its name, marked as disputed. */
export const disputedLabel = (area) => t(DISPUTED, { name: area.name });

// A category is told by its icon (a 16-unit SVG path, filled or stroked). On
// the map and in the feed colour is severity (NEWS_SEVERITY), never the type
// of event or a side.
export const NEWS_CATEGORIES = Object.freeze({
  strike: {
    label: msg('Strike'),
    icon: 'M8 0.8 L9.6 5.2 L14.2 3.6 L11.2 7.6 L15.2 10.6 L10.3 10.6 L8 15.2 L5.7 10.6 L0.8 10.6 L4.8 7.6 L1.8 3.6 L6.4 5.2 Z',
    solid: true,
  },
  // A threat on its way (a drone's course, an air-raid alert): nothing has
  // hit yet. Not a physical event, so never a picture card.
  alert: {
    label: msg('Alert'),
    icon: 'M1.5 8 H11.5 M8 4.5 L11.5 8 L8 11.5 M14.5 3.5 V12.5',
  },
  'air-defence': {
    label: msg('Air defence'),
    icon: 'M8 1.5 L13.5 3.5 V8 C13.5 11.3 10.8 13.4 8 14.6 C5.2 13.4 2.5 11.3 2.5 8 V3.5 Z M8 4.5 V11',
  },
  ground: {
    label: msg('Ground fighting'),
    icon: 'M3 13 L12 4 M8.5 3.5 H12.5 V7.5 M13 13 L4 4 M3.5 7.5 V3.5 H7.5',
  },
  casualties: {
    label: msg('Casualties'),
    icon: 'M6.2 2 H9.8 V6.2 H14 V9.8 H9.8 V14 H6.2 V9.8 H2 V6.2 H6.2 Z',
    solid: true,
  },
  humanitarian: {
    label: msg('Humanitarian'),
    icon: 'M8 2.5 L14.5 13.5 H1.5 Z M8 2.5 V13.5',
  },
  infrastructure: {
    label: msg('Infrastructure'),
    icon: 'M9.2 1 L3.2 9 H7.6 L6.6 15 L12.8 6.8 H8.4 Z',
    solid: true,
  },
  disaster: {
    label: msg('Disaster'),
    icon: 'M1.5 6.5 C3.5 4.5 5.5 4.5 7.5 6.5 S11.5 8.5 14.5 6.5 M1.5 10.5 C3.5 8.5 5.5 8.5 7.5 10.5 S11.5 12.5 14.5 10.5',
  },
  protest: {
    label: msg('Protest'),
    icon: 'M2.5 6.2 V9.8 H5 L12.5 13.2 V2.8 L5 6.2 Z',
  },
  political: {
    label: msg('Political'),
    icon: 'M2 14 H14 M2.5 5.5 H13.5 M8 1.8 L14 4.8 H2 Z M4.2 6.5 V12 M8 6.5 V12 M11.8 6.5 V12',
  },
  // Business, trade and industry: a national feed's news in Local.
  economy: {
    label: msg('Economy'),
    icon: 'M2 13.5 H14 M2.5 11 L6 7.5 L8.5 9.5 L13.5 4.5 M10.5 4.5 H13.5 V7.5',
  },
  other: {
    label: msg('Other'),
    icon: 'M8 4.5 A3.5 3.5 0 1 0 8.01 4.5 Z',
    solid: true,
  },
});

// Severity 0–3, in colours GEV already uses: its dim and primary text, the
// military layers' amber and the Cockpit's emergency red. They are drawn on
// a dark disc, so from minor up lightness falls as severity rises and the
// ramp still reads under colour blindness and in greyscale.
export const NEWS_SEVERITY = Object.freeze([
  { label: msg('No physical event'), color: '#7c878d' },
  { label: msg('Minor incident'), color: '#e8eaed' },
  { label: msg('Significant'), color: '#ffb800' },
  { label: msg('Major'), color: '#ff4444' },
]);
/** The feed's default floor: significant and major events. */
export const NEWS_DEFAULT_MIN_SEVERITY = 2;
const PHYSICAL = new Set([
  'strike',
  'air-defence',
  'ground',
  'casualties',
  'infrastructure',
  'disaster',
]);

export const categoryStyle = (category) =>
  NEWS_CATEGORIES[category] || NEWS_CATEGORIES.other;
export const categoryLabel = (category) => t(categoryStyle(category).label);
/** Party codes (UA, RU, IL…) are shown as-is; neutral sides are translated. */
export const sideLabel = (side) =>
  Object.hasOwn(NEUTRAL_SIDES, side) ? t(NEUTRAL_SIDES[side]) : side;

/**
 * A report's severity, 0–3: the server's (the local model's reading, else
 * its rules, raised to its event's), or a fallback from the category.
 */
export function reportSeverity(report) {
  const own = Number.isInteger(report?.severity) ? report.severity : null;
  const event = Number.isInteger(report?.event?.severity)
    ? report.event.severity
    : null;
  if (own === null && event === null)
    return PHYSICAL.has(report?.category) ? 1 : 0;
  return Math.max(own ?? 0, event ?? 0);
}
export const severityStyle = (report) => NEWS_SEVERITY[reportSeverity(report)];
export const severityLabel = (report) => t(severityStyle(report).label);

/** When a report (or its event) was last heard of, in ms; NaN when unknown. */
const lastHeard = (report) =>
  Date.parse(report?.event?.lastAt || report?.publishedAt || '');

/**
 * Whether a time is inside the window (the last 24 hours unless the server
 * serves fewer; the only news shown); one more than 15 minutes ahead of the
 * clock is not.
 */
function inWindow(value, now, windowMs = NEWS_WINDOW_MS) {
  const at = Date.parse(value || '');
  return (
    Number.isFinite(at) &&
    now - at <= windowMs &&
    at - now <= NEWS_CLOCK_SKEW_MS
  );
}

/** Whether a report is inside the window (the only news shown). */
export function withinNewsWindow(
  report,
  now = Date.now(),
  windowMs = NEWS_WINDOW_MS,
) {
  return inWindow(report?.publishedAt, now, windowMs);
}

/** The event's one-report-per-side list, inside the last 24 hours only. */
const recentSides = (report, now) =>
  (report?.event?.sides || []).filter((s) => inWindow(s.publishedAt, now));

/**
 * How a report or its event is attested, as a chip: `claimed` (someone's
 * claim, named where known), `confirmed` (both sides, or an independent
 * source), `side` (one party's own press), `single` (one report), or null.
 */
export function attestation(report) {
  const event = report?.event;
  const status = event?.status || (report?.claim ? 'claimed' : null);
  if (status === 'claimed') {
    const who = event?.claimedBy || report?.claim?.by;
    return {
      kind: 'claimed',
      label: who ? t(CLAIMED_BY, { who }) : t(CLAIMED),
    };
  }
  if (status === 'both-sides' || status === 'independent')
    return { kind: 'confirmed', label: t(ATTESTATION[status]) };
  if (status === 'side' && event.reportedSide)
    return {
      kind: 'side',
      label: t(REPORTED_BY_SIDE, { side: sideLabel(event.reportedSide) }),
    };
  if (status === 'single')
    return { kind: 'single', label: t(ATTESTATION.single) };
  return null;
}

/**
 * The attestation chip under a report. An official channel's own post is
 * already marked Official: "Claimed by" itself would read as doubt about an
 * alert. It says only that nobody else has reported it yet, and nothing for
 * an alert, which is the channel's own notice.
 */
function ownClaimChip(report) {
  const chip = attestation(report);
  if (
    chip?.kind !== 'claimed' ||
    !OFFICIAL_AFFILIATIONS.has(report.affiliation)
  )
    return chip;
  const who = report.event?.claimedBy || report.claim?.by;
  if (who && who !== report.sourceName && who !== report.publisher) return chip;
  return report.category === 'alert'
    ? null
    : { kind: 'claimed', label: t(UNCONFIRMED) };
}

// The map card is a label, not a reader: long headlines are cut.
export const NEWS_CARD_TITLE_MAX = 90;

/** A headline cut at a word to fit `max` characters. */
export function shortTitle(title, max = NEWS_CARD_TITLE_MAX) {
  const text = String(title || '');
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${word > max * 0.6 ? cut.slice(0, word) : cut}…`;
}

/** The media a post carries ("Video", "Photos"), translated. */
export function mediaLabels(report) {
  return (report?.media || [])
    .map((m) => (MEDIA_LABELS[m] ? t(MEDIA_LABELS[m]) : ''))
    .filter(Boolean);
}

/**
 * How long ago, in few words: "now" under a minute, "N min" under an hour,
 * "N h" under a day. Older is never shown; it reads
 * "24 h".
 */
export function ageWords(at, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return t('now', { context: 'age' });
  if (minutes < 60) return t('{minutes} min', { minutes });
  return t('{hours} h', { hours: Math.min(24, Math.floor(minutes / 60)) });
}

/**
 * How a report's marker looks: colour = severity, icon = category, rim =
 * attestation (`confirmed` solid, `claimed` dashed, else thin), size =
 * sources, opacity = age (fading to 45 % over a day).
 */
export function markerStyle(report, now = Date.now()) {
  const kind = attestation(report)?.kind;
  const at = lastHeard(report);
  const hours = Number.isFinite(at) ? Math.max(0, (now - at) / 3_600_000) : 0;
  return {
    category: Object.hasOwn(NEWS_CATEGORIES, report?.category)
      ? report.category
      : 'other',
    severity: reportSeverity(report),
    rim: kind === 'confirmed' || kind === 'claimed' ? kind : 'thin',
    size: eventPixelSize(report?.event?.size),
    alpha: Math.max(0.45, 1 - (0.55 * Math.min(hours, 24)) / 24),
  };
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Trend glyph for a hotspot: ▲/▼ when the last 24 h differ from the 24 h
 * before by more than a fifth, nothing when flat or without a prior day.
 */
export function hotspotTrend(last24h, prev24h) {
  if (!(prev24h > 0)) return '';
  if (last24h > prev24h * 1.2) return '▲';
  if (last24h < prev24h * 0.8) return '▼';
  return '';
}

/** Beacon size in pixels: grows with the square root of daily activity. */
export const beaconPixelSize = (last24h) =>
  Math.round(Math.min(26, 10 + Math.sqrt(Math.max(0, last24h)) * 1.4));

/** Marker size for an event: grows with the number of distinct sources. */
export function eventPixelSize(sources = 1) {
  return Math.round(
    // No smaller than 24: the category icon is half the disc and unreadable
    // below that.
    Math.min(36, 24 + 3 * Math.log2(Math.max(1, Number(sources) || 1))),
  );
}

// An event several sources report within the last few hours gets a halo.
export const NEWS_PRESSING_SOURCES = 5;
const PRESSING_MS = 3 * 3_600_000;

/** Whether an event is fresh and widely reported, or fresh and major. */
export function isPressing(report, now = Date.now()) {
  const event = report?.event;
  const fresh = now - lastHeard(report) <= PRESSING_MS;
  return Boolean(
    fresh &&
    ((event && event.size >= NEWS_PRESSING_SOURCES) ||
      reportSeverity(report) === 3),
  );
}

// The big events stand as picture cards over their marker: several
// sources, and major or pressing.
export const NEWS_CARD_LIMIT = 10;
export const NEWS_CARD_MIN_SOURCES = 2;

/** Whether an event gets a card on the map: physical events only, not statements. */
export function isCardEvent(report, now = Date.now()) {
  return Boolean(
    report?.event?.size >= NEWS_CARD_MIN_SOURCES &&
    PHYSICAL.has(report.category) &&
    (reportSeverity(report) === 3 || isPressing(report, now)),
  );
}

/** The card events among `reports`, most severe, most reported and newest first. */
export function cardEvents(reports, now = Date.now(), limit = NEWS_CARD_LIMIT) {
  return reports
    .filter((r) => r.pins?.length && isCardEvent(r, now))
    .sort(
      (a, b) =>
        reportSeverity(b) - reportSeverity(a) ||
        b.event.size - a.event.size ||
        (b.event.lastAt || '').localeCompare(a.event.lastAt || ''),
    )
    .slice(0, limit);
}

/** The distinct sides an event was reported by in the last day, lead first. */
function eventSides(report, now) {
  const sides = recentSides(report, now).map((s) => s.side);
  return [...new Set(sides.length ? sides : [report?.side].filter(Boolean))];
}

/**
 * "Reported by UA sources · RU sources", or '' when no side is known; an
 * unattributed side is left out.
 */
export function sidesLine(report, now = Date.now()) {
  const sides = eventSides(report, now).filter((side) => side !== 'unknown');
  if (!sides.length) return '';
  if (sides.length === 1)
    return t(REPORTED_BY_SIDE, { side: sideLabel(sides[0]) });
  return t(REPORTED_BY_SIDES, {
    sides: sides
      .map((side) => t(SIDE_SOURCES, { side: sideLabel(side) }))
      .join(' · '),
  });
}

/**
 * The event's picture, the publisher named, and its clip when it has one. The
 * panel shows it for any event; the globe's picture cards are for events of
 * two or more sources (isCardEvent).
 */
export function eventPicture(report) {
  const image = report?.event?.image;
  if (!image) return null;
  return {
    url: image.url,
    credit: image.publisher || '',
    ...(image.video ? { video: image.video } : {}),
  };
}

/** What an event's picture card on the globe shows. */
export function cardView(report, now = Date.now()) {
  const event = report.event;
  const sides = eventSides(report, now).map(sideLabel);
  // A globe card's picture needs two or more sources, as the card does.
  const picture =
    report?.event?.size >= NEWS_CARD_MIN_SOURCES ? eventPicture(report) : null;
  return {
    title: report.titleEn || report.title,
    meta: [
      ageWords(event?.lastAt || report.publishedAt, now),
      tn(event?.size || 1, '{count} source', '{count} sources'),
      sides.slice(0, 3).join(', ') + (sides.length > 3 ? '…' : ''),
    ]
      .filter(Boolean)
      .join(' · '),
    image: picture?.url || null,
    credit: picture?.credit || '',
  };
}

/** "Source: host ↗" line for a report's card; the card opens the article. */
export function sourceLinkLabel(url) {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
  return `${t(SOURCE_LABEL)}: ${host} ↗`;
}

/**
 * "via GDELT Project": the service a report was read through, which asks to
 * be credited where its reports show; '' when the server names none.
 */
export function attributionLabel(report) {
  return report?.attribution ? t(VIA, { source: report.attribution }) : '';
}

/** The places a report is pinned at, joined, or null. */
function placeLine(report) {
  return (
    (report.pins?.length ? report.pins : [report.geo])
      .map((p) => p?.place)
      .filter(Boolean)
      .join(' · ') || null
  );
}

/**
 * One event card in the News panel: picture,
 * headline, a mono meta line (severity, category, place, sources, age, the
 * service it came through), the sides line, then attestation and media chips. Labels and colours are
 * resolved here so the panel imports no layer code.
 */
export function feedCardView(report, now = Date.now()) {
  const severity = reportSeverity(report);
  const style = categoryStyle(report.category);
  const size = report.event?.size || 1;
  const translated = Boolean(report.titleEn && report.titleEn !== report.title);
  return {
    id: report.id,
    url: report.url,
    title: translated ? report.titleEn : report.title,
    // The local model's English headline over a post in another language:
    // the original stays beside it.
    original: translated ? report.title : null,
    snippet: report.snippet,
    severity,
    severityLabel: t(NEWS_SEVERITY[severity].label),
    color: NEWS_SEVERITY[severity].color,
    icon: style.icon,
    solid: Boolean(style.solid),
    category: categoryLabel(report.category),
    place: placeLine(report),
    placedByModel: Boolean(report.geo?.byModel),
    mappable: Boolean(report.pins?.length),
    sources: tn(size, '{count} source', '{count} sources'),
    age: ageWords(report.event?.lastAt || report.publishedAt, now),
    publisher: report.publisher,
    via: attributionLabel(report),
    sides: sidesLine(report, now),
    sourceLink: sourceLinkLabel(report.url),
    picture: eventPicture(report),
    chips: [
      // An official channel speaking for itself (a ministry, the armed
      // forces, a press service), not an outlet that quotes one.
      OFFICIAL_AFFILIATIONS.has(report.affiliation)
        ? { kind: 'official', label: t(OFFICIAL) }
        : null,
      ownClaimChip(report),
      ...mediaLabels(report).map((label) => ({ kind: 'media', label })),
    ].filter(Boolean),
    // The event's first report from each other side, under the lead.
    others: recentSides(report, now)
      .slice(1)
      .map((s) => ({
        side: sideLabel(s.side),
        publisher: s.publisher,
        title: s.title,
        url: s.url,
      })),
  };
}

/**
 * Whether a report is placed no closer than a country: it has no spot of its
 * own on the map.
 */
export const countryOnly = (report) =>
  report.pins?.length > 0 &&
  report.pins.every((pin) => pin.precision === 'country');

/**
 * Country-only reports as one group per country, in the order met:
 * `{key, place, lat, lon, count}`. They are drawn as one badge with a count,
 * not as markers piled on the country's centre.
 */
export function countryGroups(reports) {
  const groups = new Map();
  for (const report of reports) {
    if (!countryOnly(report)) continue;
    const { lat, lon, place } = report.pins[0];
    const key = place || `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { key, place: place || '', lat, lon, count: 1 });
  }
  return [...groups.values()];
}

/**
 * Marker position for a report. Many reports name the same city and would
 * stack on one centroid, so each is spread on a small deterministic ring
 * (about 1.5 km for a place, 6 km for a region, 28 km for a country) to stay
 * individually clickable. The spread is display-only; cards show the place.
 */
export function reportMarkerPosition(report, pin = 0) {
  const { lat, lon, precision } = report.pins?.[pin] || report.geo;
  const h = hash(pin ? `${report.id}~${pin}` : report.id);
  const angle = ((h % 3600) / 3600) * 2 * Math.PI;
  const radiusDeg =
    (precision === 'country' ? 0.25 : precision === 'region' ? 0.055 : 0.014) *
    (0.35 + ((h >>> 12) % 65) / 100);
  return {
    lat: lat + radiusDeg * Math.sin(angle),
    lon: lon + (radiusDeg * Math.cos(angle)) / Math.cos((lat * Math.PI) / 180),
  };
}

/**
 * Merge a page into the feed, newest first, one row per report id, keeping
 * only the window and at most `max` rows (a long session does not grow
 * the list). `mode` 'head' refreshes the top and keeps the older cursor;
 * 'append' adds an older page and takes its cursor; 'replace' starts over.
 * A head page that has older pages behind it and shares no row with the list
 * left a gap (more than a page arrived since), so it starts over too.
 */
export function mergeFeedPage(
  feed,
  page,
  mode,
  now = Date.now(),
  max = NEWS_FEED_MAX,
  windowMs = NEWS_WINDOW_MS,
) {
  const byId = new Map();
  if (mode === 'head' && page.nextBefore && feed.items.length) {
    const held = new Set(feed.items.map((item) => item.id));
    if (!page.reports.some((item) => held.has(item.id))) mode = 'replace';
  }
  const items =
    mode === 'replace'
      ? page.reports
      : mode === 'append'
        ? [...feed.items, ...page.reports]
        : [...page.reports, ...feed.items];
  for (const item of items)
    if (!byId.has(item.id) && withinNewsWindow(item, now, windowMs))
      byId.set(item.id, item);
  return {
    items: [...byId.values()]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, max),
    nextBefore:
      mode === 'head' && feed.items.length ? feed.nextBefore : page.nextBefore,
  };
}

/** Normalised filters; anything unknown falls back to its default. */
export function normalizeFilters(next = {}, hotspots = [], previous = {}) {
  const merged = { ...previous, ...next };
  const hotspot = hotspots.some((h) => h.id === merged.hotspot)
    ? merged.hotspot
    : 'all';
  const category = Object.hasOwn(NEWS_CATEGORIES, merged.category)
    ? merged.category
    : 'all';
  const minSeverity =
    Number.isInteger(merged.minSeverity) &&
    merged.minSeverity >= 0 &&
    merged.minSeverity <= 3
      ? merged.minSeverity
      : NEWS_DEFAULT_MIN_SEVERITY;
  return {
    hotspot,
    category,
    minSeverity,
    section: NEWS_SECTIONS.includes(merged.section)
      ? merged.section
      : 'conflicts',
    // A shorter window than the server's; null shows all it serves.
    hours: NEWS_WINDOW_CHOICES.includes(merged.hours) ? merged.hours : null,
  };
}

/** Whether a report passes the filters the server does not apply. */
export function passesFilters(
  report,
  filters,
  now = Date.now(),
  windowMs = NEWS_WINDOW_MS,
) {
  return (
    withinNewsWindow(report, now, windowMs) &&
    reportSeverity(report) >= filters.minSeverity
  );
}

/** Whether a report belongs on the map under the current filters. */
export function visibleOnMap(
  report,
  filters,
  now = Date.now(),
  windowMs = NEWS_WINDOW_MS,
) {
  return (
    (filters.hotspot === 'all' ||
      (report.hotspotIds || [report.hotspotId]).includes(filters.hotspot)) &&
    (filters.category === 'all' || report.category === filters.category) &&
    passesFilters(report, filters, now, windowMs)
  );
}

/**
 * The filters Local applies: every hotspot and every severity, near the view
 * centre; the category and the window still hold.
 */
export const localFilters = (filters) => ({
  ...filters,
  hotspot: 'all',
  minSeverity: 0,
});

/** API query for the Conflicts feed under the current filters: the window only. */
export function feedQueryFor(filters, extra = {}) {
  return {
    events: true,
    today: true,
    relevance: NEWS_RELEVANT,
    hotspot: filters.hotspot,
    category: filters.category === 'all' ? '' : filters.category,
    limit: NEWS_FEED_PAGE,
    ...extra,
  };
}

/** The half-degree cell a point lies in, as a key. */
export function viewCell({ lat, lon }) {
  return `${Math.floor(lat / NEWS_CELL_DEG)}:${Math.floor(lon / NEWS_CELL_DEG)}`;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function inRing(ring, { lat, lon }) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Whether a point lies in an outline's polygons (`{outer, holes}`). */
export function inPolygons(polygons, point) {
  return polygons.some(
    ({ outer, holes }) =>
      inRing(outer, point) && !holes.some((hole) => inRing(hole, point)),
  );
}

/**
 * The reports near `centre` that pass the filters, newest first: any pin
 * inside `area` (outline polygons), or without one within
 * NEWS_IN_VIEW_RADIUS_KM. Newest, not most severe: an area's own news often
 * carries no severity, and the area's fighting would otherwise crowd it out.
 */
export function reportsInView(
  reports,
  centre,
  filters,
  now = Date.now(),
  limit = NEWS_IN_VIEW_LIMIT,
  windowMs = NEWS_WINDOW_MS,
  area = null,
) {
  if (!centre) return [];
  const near = area?.length
    ? (pin) => inPolygons(area, pin)
    : (pin) => distanceKm(pin, centre) <= NEWS_IN_VIEW_RADIUS_KM;
  return reports
    .filter(
      (r) =>
        passesFilters(r, filters, now, windowMs) &&
        (filters.category === 'all' || r.category === filters.category) &&
        r.pins?.some(near),
    )
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}
