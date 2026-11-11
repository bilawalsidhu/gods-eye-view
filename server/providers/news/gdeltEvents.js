// GDELT 2.0 events for the Conflicts section, from the 15-minute export
// files (data.gdeltproject.org, plain downloads; no key, and not the
// rate-limited search API). Each export is one zipped tab-separated table of
// machine-coded events, each placed by GDELT with a point and a place type.
//
// A story counts when GDELT coded physical violence in it (CAMEO roots 18
// assault, 19 fight, 20 mass violence); its place is read from all its
// placed events (choosePlace). GDELT's actor fields are machine-coded and
// often wrong, so no report says who did what: a report is the story (its
// article, and the copies other outlets ran under the same address words).
// The events carry no headline: a story's title is its page title from the
// GKG export of the same quarter hour (read for the newest hours only, it
// runs to 6 MB), else the words of its address. All of it is rules over
// GDELT's own fields; nothing reads the articles.

import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';

import { readResponseBytesCapped } from '../common/http.js';
import { categorizeText, relevanceOf, severityByRules } from './categorize.js';
import { UpstreamError, unescapeHtml, webLink } from './upstream.js';

const EXPORTS_URL = 'https://data.gdeltproject.org/gdeltv2/';
const STEP_MS = 15 * 60_000;
// An events export runs to about 100 KB zipped and 500 KB unzipped; a GKG
// export to about 6 MB and 18 MB. Unzipped off the main thread.
const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_TABLE_BYTES = 8 * 1024 * 1024;
const MAX_GKG_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_GKG_TABLE_BYTES = 32 * 1024 * 1024;
const inflate = promisify(inflateRaw);
// The most words an address's words make a title of.
const MAX_ADDRESS_WORDS = 24;
const TIMEOUT_MS = 30_000;
const MAX_PLACES = 3;

// Columns of the 2.0 events table (61).
const COL = {
  id: 0,
  eventCode: 26,
  rootCode: 28,
  quadClass: 29,
  mentions: 31,
  geoType: 51,
  place: 52,
  lat: 56,
  lon: 57,
  added: 59,
  url: 60,
};

// CAMEO event codes as the News layer's categories, and as words for an
// article whose address carries none of its own.
const EVENTS = [
  // Aerial weapons, artillery and tanks, bombings.
  [/^19[45]|^183/, 'strike', 'Strike reported'],
  [/^186|^185/, 'casualties', 'Killing reported'],
  [/^181/, 'humanitarian', 'Abduction reported'],
  [/^20/, 'casualties', 'Mass violence reported'],
  [/^19/, 'ground', 'Fighting reported'],
  [/^18/, 'other', 'Violence reported'],
];
const eventKind = (code) =>
  EVENTS.find(([pattern]) => pattern.test(code)) || EVENTS.at(-1);

// GDELT's place types: 1 country, 2 US state, 3 US city, 4 world city,
// 5 world state.
const PRECISION = {
  1: 'country',
  2: 'region',
  3: 'city',
  4: 'city',
  5: 'region',
};

/** The export holding the events GDELT added in the 15 minutes before `ms`. */
export function exportUrl(ms) {
  const at = new Date(Math.floor(ms / STEP_MS) * STEP_MS);
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${EXPORTS_URL}${stamp}.export.CSV.zip`;
}

/** An events export's quarter hour (ms), from its name, or NaN. */
export function exportAt(url) {
  const match = /(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)00\.export\.CSV\.zip$/.exec(
    url,
  );
  return match
    ? Date.UTC(match[1], match[2] - 1, match[3], match[4], match[5])
    : NaN;
}

const LASTUPDATE_URL = `${EXPORTS_URL}lastupdate.txt`;

/**
 * The time of the newest events export GDELT lists as published, in ms, or
 * null when its list cannot be read. Asking for one not listed yet would
 * be answered 404, and GDELT's CDN keeps that 404 for an hour.
 */
export async function fetchLatestExport({ fetchImpl, signal } = {}) {
  try {
    const response = await fetchImpl(LASTUPDATE_URL, {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      return null;
    }
    const text = new TextDecoder().decode(
      await readResponseBytesCapped(response, 16 * 1024, signal),
    );
    const at = exportAt(
      /\S+\.export\.CSV\.zip/.exec(text)?.[0].replace(/^http:/, 'https:') || '',
    );
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** The GKG export of the same quarter hour as an events export. */
export const gkgUrl = (eventsUrl) =>
  eventsUrl.replace(/\.export\.CSV\.zip$/, '.gkg.csv.zip');

/** The day's exports up to `now`, newest first. */
export function exportsOfDay(now, hours = 24) {
  const urls = [];
  const last = Math.floor(now / STEP_MS) * STEP_MS;
  for (let ms = last; ms > now - hours * 3_600_000; ms -= STEP_MS)
    urls.push(exportUrl(ms));
  return urls;
}

/** The one table inside an export's zip, as text, up to `maxBytes`. */
export async function unzipExport(bytes, maxBytes = MAX_TABLE_BYTES) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = () => {
    throw new UpstreamError('GDELT export unreadable', { unreadable: true });
  };
  if (bytes.length < 30 || view.getUint32(0, true) !== 0x04034b50) fail();
  // The central directory has the sizes; a local header may leave them 0.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 0x10015); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) fail();
  const dir = view.getUint32(eocd + 16, true);
  if (dir + 46 > bytes.length || view.getUint32(dir, true) !== 0x02014b50)
    fail();
  const method = view.getUint16(dir + 10, true);
  const compressed = view.getUint32(dir + 20, true);
  const local = view.getUint32(dir + 42, true);
  if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50)
    fail();
  const start =
    local +
    30 +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  if (start + compressed > bytes.length) fail();
  const data = bytes.subarray(start, start + compressed);
  try {
    if (method === 0 && data.length > maxBytes) fail();
    const table =
      method === 0
        ? data
        : method === 8
          ? await inflate(data, { maxOutputLength: maxBytes })
          : fail();
    return new TextDecoder().decode(table);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    return fail();
  }
}

/**
 * An article's address as the reports carry it: https, an http one
 * upgraded (GDELT keeps the address as it found it), else null.
 */
export const articleLink = (value) =>
  webLink(value) || webLink(String(value ?? '').replace(/^http:/, 'https:'));

/**
 * The placed events of an export's table, of the stories with physical
 * violence in them: those events, and every other placed event of the same
 * stories (they help place it).
 */
export function parseEvents(table) {
  const all = [];
  for (const line of table.split('\n')) {
    const f = line.split('\t');
    if (f.length < 61) continue;
    const violent =
      f[COL.quadClass] === '4' && ['18', '19', '20'].includes(f[COL.rootCode]);
    const precision = PRECISION[f[COL.geoType]];
    const lat = Number(f[COL.lat]);
    const lon = Number(f[COL.lon]);
    const url = articleLink(f[COL.url]);
    const added = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(f[COL.added]);
    if (
      !precision ||
      !f[COL.lat] ||
      !f[COL.lon] ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0) ||
      !url ||
      !added
    )
      continue;
    all.push({
      id: f[COL.id],
      code: f[COL.eventCode],
      violent,
      lat,
      lon,
      place: f[COL.place].trim() || null,
      precision,
      mentions: Math.max(1, Number(f[COL.mentions]) || 1),
      addedAt: `${added[1]}-${added[2]}-${added[3]}T${added[4]}:${added[5]}:${added[6]}.000Z`,
      url,
    });
  }
  const stories = new Set(all.filter((e) => e.violent).map(storyKey));
  return all.filter((e) => stories.has(storyKey(e)));
}

/**
 * The words of an article's address, when it is written in them
 * ("three-children-die-in-peshawar-cylinder-exp"), as a sentence; else null.
 */
export function addressWords(url) {
  let path;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const segment = path
    .split('/')
    .map((part) => part.replace(/\.(?:s?html?|php|aspx?)$/i, ''))
    .filter((part) => /[-_]/.test(part))
    .sort((a, b) => b.length - a.length)[0];
  if (!segment) return null;
  const words = segment.split(/[-_]+/).filter(Boolean);
  const lettered = words.filter((word) => /^\p{L}+$/u.test(word));
  if (lettered.length < 4 || lettered.length < 0.7 * words.length) return null;
  // Numbers stay ("killed nearly 500"); an id does not: a word of letters
  // and digits, five digits or more, or four or more at either end.
  const kept = words.filter(
    (word, i) =>
      /^\p{L}+$/u.test(word) ||
      (/^\d{1,4}$/.test(word) &&
        !(word.length === 4 && (i === 0 || i === words.length - 1))),
  );
  const text = kept.slice(0, MAX_ADDRESS_WORDS).join(' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Address words with the places the story is at written as names
 * ("killed in amman" → "killed in Amman"), and "u s" as "US".
 */
export function withNames(words, places) {
  let text = words.replace(/(?<![\p{L}])u s(?![\p{L}])/gu, 'US');
  const names = new Set(
    places.flatMap((place) =>
      String(place.place ?? '')
        .split(',')
        .map((part) => part.replace(/\(.*?\)/g, '').trim())
        .filter((part) => part.length > 2 && !/\(general\)/.test(part)),
    ),
  );
  for (const name of names) {
    const pattern = new RegExp(
      `(?<![\\p{L}])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`,
      'gu',
    );
    text = text.replace(pattern, name);
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A page title's site part: " | The Daily Example", " - Wire Service".
const SITE_PART = /\s+[|–—-]\s+([^|–—-]{2,60})$/u;

/**
 * A page title as a headline: entities decoded, the site's name after a
 * bar or dash taken off (when the headline before it is still one), or
 * null when it is too short to be one.
 */
export function cleanTitle(raw) {
  // An agency's tag set on with a bare hyphen ("…attack-Newswire", "…-X").
  let title = unescapeHtml(raw).replace(
    // After a word in lower case: "Jean-Pierre" keeps its name.
    /(?<=(?:^|\s)\p{Ll}\p{L}*|[\p{N}'")])-\p{Lu}\p{L}{0,15}$/u,
    '',
  );
  for (let i = 0; i < 2; i++) {
    const match = SITE_PART.exec(title);
    if (!match) break;
    const rest = title.slice(0, match.index);
    if (rest.split(/\s+/).length < 4 || match[1].split(/\s+/).length > 6) break;
    title = rest;
  }
  title = title.trim().slice(0, 300);
  return title.length >= 12 && title.split(/\s+/).length >= 3 ? title : null;
}

/**
 * GKG page titles by article address (as articleLink writes it), for the
 * addresses in `wanted`.
 */
export function parseTitles(table, wanted) {
  const titles = new Map();
  for (const line of table.split('\n')) {
    const f = line.split('\t');
    const url = f[4] && articleLink(f[4]);
    if (!url || !wanted.has(url)) continue;
    const match = /<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/s.exec(f.at(-1) || '');
    const title = match && cleanTitle(match[1]);
    if (title) titles.set(url, title);
  }
  return titles;
}

/**
 * The story an event belongs to: its article's address words, which the
 * copies other outlets run share (an agency story), else its address.
 */
export function storyKey(event) {
  return addressWords(event.url)?.toLowerCase() || event.url;
}

const PLACE_WORD = (name) =>
  new RegExp(
    `(?<![\\p{L}])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![\\p{L}])`,
    'u',
  );
/** Whether the words name a place's town or its country ("jordans" too). */
function namedIn(words, place) {
  if (!words || !place) return false;
  const parts = place
    .split(',')
    .map((part) => part.replace(/\(.*?\)/g, '').trim())
    .filter((part) => part.length > 2);
  return [parts[0], parts.at(-1)].some(
    (part) => part && PLACE_WORD(part).test(words.toLowerCase()),
  );
}

/**
 * A story's places, best first, from all its placed events. GDELT places
 * an event at a bare country when the text only names a nationality ("a
 * Sri Lankan embassy", an Australian outlet's own country), so a town or
 * region wins over a country; of those, the ones the article's own words
 * name; then the most mentioned.
 */
export function choosePlaces(events, words) {
  const byPlace = new Map();
  for (const event of events) {
    const key = `${event.lat},${event.lon}`;
    const place = byPlace.get(key) || { ...event, mentions: 0 };
    place.mentions += event.mentions;
    byPlace.set(key, place);
  }
  let places = [...byPlace.values()];
  const specific = places.filter((p) => p.precision !== 'country');
  if (specific.length) places = specific;
  const named = places.filter((p) => namedIn(words, p.place));
  if (named.length) places = named;
  return places.sort((a, b) => b.mentions - a.mentions).slice(0, MAX_PLACES);
}

// The earlier of two events: by the time GDELT added it, then by its id.
const earlier = (a, b) =>
  b.addedAt < a.addedAt ||
  (b.addedAt === a.addedAt && Number(b.id) < Number(a.id))
    ? b
    : a;

/**
 * One report per story (storyKey), its address and id the first copy's (an
 * export adding a more-mentioned event keeps both), placed by choosePlaces,
 * titled by a copy's page title (`titleOf`), else its address words, else
 * its violent event.
 */
export function eventReports(events, { titleOf = () => null } = {}) {
  const stories = new Map();
  for (const event of events) {
    const key = storyKey(event);
    const list = stories.get(key) || [];
    list.push(event);
    stories.set(key, list);
  }
  const reports = [];
  for (const list of stories.values()) {
    const violent = list
      .filter((e) => e.violent !== false)
      .sort(
        (a, b) => b.mentions - a.mentions || a.addedAt.localeCompare(b.addedAt),
      );
    if (!violent.length) continue;
    const [lead] = violent;
    const first = list.reduce(earlier);
    const { url } = first;
    const address = addressWords(url);
    const places = choosePlaces(list, address);
    const [, eventCategory, words] = eventKind(lead.code);
    const page = [url, ...list.map((e) => e.url)]
      .map((copy) => titleOf(copy))
      .find(Boolean);
    const own = page || (address ? withNames(address, places) : null);
    const title = own || eventTitle(words, places[0].place);
    // The article's words decide whether it is conflict, as any headline's
    // would: GDELT codes an election story as "fighting" too. GDELT's code
    // names the kind only where the words read as conflict without naming
    // one. A story with no words at all has GDELT's code alone to go by,
    // which is not enough to list it under Conflicts: it is minor (kept
    // for Local) until a page title comes in.
    const read = own ? categorizeText({ title: own }) : null;
    const tags = read?.tags || [];
    const relevance = read
      ? relevanceOf({ category: read.category, tags, title: own })
      : 'minor';
    const category = !read
      ? eventCategory
      : read.category !== 'other'
        ? read.category
        : relevance === 'minor'
          ? 'other'
          : eventCategory;
    const publisher = new URL(url).hostname.replace(/^www\./, '');
    const geo = ({ lat, lon, place, precision }) => ({
      lat,
      lon,
      place,
      precision,
      confidence: precision === 'city' ? 0.6 : 0.3,
      mappable: true,
      method: 'source',
    });
    reports.push({
      id: `gdelt-${first.id}`,
      title,
      url,
      publisher,
      source: { name: publisher, attribution: 'GDELT Project' },
      kind: 'gdelt',
      side: 'unknown',
      category,
      relevance,
      severity: Math.max(
        1,
        severityByRules({ category, tags, title: own || '' }),
      ),
      severityBy: 'rules',
      publishedAt: first.addedAt,
      geo: geo(places[0]),
      locations: places.slice(1).map(geo),
      media: [],
      mentions: list.reduce((sum, e) => sum + e.mentions, 0),
      copies: new Set(list.map((e) => e.url)).size,
      // A title of the event's words and its place, when the address had
      // none: a renamed place renames it (eventTitle).
      ...(own ? {} : { eventWords: words }),
      titled: page ? 'page' : own ? 'address' : 'event',
    });
  }
  return reports;
}

/** The title of a report without address words, at its (renamed) place. */
export const eventTitle = (words, place) =>
  place ? `${words} in ${place}` : words;

/**
 * One export's table, or null while GDELT has not published it (GDELT
 * lists the newest in lastupdate.txt; see fetchLatestExport).
 */
async function fetchTable(url, { fetchImpl, signal, maxBytes, tableBytes }) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new UpstreamError('GDELT exports unreachable');
  }
  if (response.status === 404) {
    await response.body?.cancel?.().catch?.(() => {});
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch?.(() => {});
    throw new UpstreamError(`GDELT exports answered ${response.status}`, {
      status: response.status,
    });
  }
  let bytes;
  try {
    bytes = await readResponseBytesCapped(response, maxBytes, signal);
  } catch (error) {
    // Over the cap stays over it; a read cut short may succeed again.
    throw new UpstreamError('GDELT export unreadable', {
      unreadable: error?.code === 'RESPONSE_TOO_LARGE',
    });
  }
  return unzipExport(bytes, tableBytes);
}

/** One events export's events, or null while it is not published yet. */
export async function fetchExport(url, { fetchImpl, signal } = {}) {
  const table = await fetchTable(url, {
    fetchImpl,
    signal,
    maxBytes: MAX_ZIP_BYTES,
    tableBytes: MAX_TABLE_BYTES,
  });
  return table === null ? null : parseEvents(table);
}

/**
 * The page titles a GKG export holds for the addresses in `wanted`, or null
 * while it is not published yet.
 */
export async function fetchTitles(url, wanted, { fetchImpl, signal } = {}) {
  const table = await fetchTable(url, {
    fetchImpl,
    signal,
    maxBytes: MAX_GKG_ZIP_BYTES,
    tableBytes: MAX_GKG_TABLE_BYTES,
  });
  return table === null ? null : parseTitles(table, wanted);
}
