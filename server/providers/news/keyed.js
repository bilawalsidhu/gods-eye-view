// The News layer's routes answered by Core itself, when no news server is
// configured (GEV_NEWS_ORIGIN). Conflicts: the day's GDELT events (no key;
// gdeltEvents.js), one report per article at GDELT's place for it, and with
// LIVEUAMAP_API_KEY Liveuamap's mapped items too. Local: World News API
// (WORLDNEWSAPI_KEY) by the country at the view centre; without its key the
// section answers 503 {error: 'no_key', key} and reads nothing, and past
// its day's reads (WORLDNEWSAPI_DAILY_READS) 503 {error: 'key_quota', key}.
// Conflicts' categories, relevance and severity are the shared rules
// (categorize.js); a country's own news keeps World News API's category.
// A news server may replace these readings with its own.
//
// A read that has something to serve is not waited for: what was read is
// served while it is read again. A section that cannot be read answers 502,
// never an empty list.
//
// The answers are the same /api/news contract a news server serves
// (src/layers/news/records.js reads both).

import {
  CATEGORY_ORDER,
  categorizeText,
  relevanceOf,
  severityByRules,
} from './categorize.js';
import {
  areaAt,
  countryAnchor,
  countryByCode,
  countryPolygons,
} from './areas.js';
import {
  eventReports,
  fetchLatestExport,
  eventTitle,
  exportAt,
  exportsOfDay,
  fetchExport,
  fetchTitles,
  gkgUrl,
  storyKey,
} from './gdeltEvents.js';
import { fetchLiveuamap, fetchWorldNews, UpstreamError } from './upstream.js';

/** The keys each section reads with, by the key registry's id. */
export const NEWS_KEYS = Object.freeze({
  liveuamap: 'LIVEUAMAP_API_KEY',
  worldnewsapi: 'WORLDNEWSAPI_KEY',
});

/** The one hotspot: the world, its reports drawn as markers at every zoom. */
export const WORLDWIDE_HOTSPOT = 'worldwide';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// GDELT publishes an export every 15 minutes and lists the newest in
// lastupdate.txt: the day's missing ones up to it are read every 5 minutes,
// newest first, a dozen a read (the first day's 96 fill in over the next
// reads, a few seconds apart, while each reads something new). One listed
// but missing (404) an hour and a half after its time is taken as never
// published; one that fails GDELT_EXPORT_TRIES times (a try a round), or
// cannot be read at all, is given up on, so one bad file never holds the
// rest back. Only while GDELT itself answers is a file given up on. The first
// answer waits at most FIRST_ANSWER_MS for the first exports.
const GDELT_FRESH_MS = 5 * 60_000;
const GDELT_EXPORTS_PER_READ = 12;
const GDELT_PARALLEL = 4;
const GDELT_NEXT_MS = 2_000;
const GDELT_GONE_MS = 90 * 60_000;
const GDELT_EXPORT_TRIES = 3;
const MAX_GDELT_REPORTS = 5000;
// Events kept of one story, to place it by.
const MAX_STORY_EVENTS = 200;
// Page titles are read from the GKG exports of the newest three hours: one
// runs to 6 MB, so the day's 96 are not fetched. A file that fails is tried
// with the next reads, a few times.
const GDELT_TITLED_EXPORTS = 12;
const GKG_TRIES = 3;
const LIVE_FRESH_MS = 5 * 60_000;
const COUNTRY_FRESH_MS = 30 * 60_000;
// A failed read is not tried again for a minute; what was read before is
// served meanwhile, up to these ages (GDELT's: since an export last came in).
const RETRY_MS = 60_000;
// A read with nothing to serve yet is waited for at most this long, well under
// the browser's own 15 s: it goes on, and the next ask is served from it.
const FIRST_ANSWER_MS = 10_000;
const GDELT_STALE_MS = 2 * HOUR_MS;
const LIVE_STALE_MS = HOUR_MS;
// World News API's terms allow a cache of at most an hour, deleted after:
// a country's news is kept no longer, served or not (dropExpiredCountries).
const COUNTRY_STALE_MS = HOUR_MS;
const MAX_COUNTRIES = 64;
// World News API reads a UTC day, across all countries: each is about 1.5
// of the free plan's 50 daily points.
const DEFAULT_DAILY_READS = 30;
const DEFAULT_LIMIT = 50;
const EMPTY_OUTLINE = Object.freeze({
  polygons: [],
  borders: [],
  disputed: [],
  area: null,
});
// A country's own news keeps World News API's category: the rules read
// fighting and crises, and in everyday news their words mislead ("advances
// in the rankings" is no ground fighting). Fighting in the country reaches
// Local as the Conflicts reports placed there.
const WORLD_NEWS_CATEGORY = { politics: 'political', business: 'economy' };

const list = (value) =>
  value ? new Set(value.split(',').filter(Boolean)) : null;

/** The rules' reading of a Conflicts headline: category, relevance, severity. */
function readTitle(title) {
  const read = categorizeText({ title });
  const { category } = read;
  return {
    category,
    relevance: relevanceOf({
      category,
      tags: read.tags,
      title,
      dedicated: true,
    }),
    severity: severityByRules({ category, tags: read.tags, title }),
  };
}

/** A one-report event carrying the report's picture, for its card. */
function pictureEvent(id, report, image, video, publisher) {
  return {
    id,
    status: 'single',
    size: 1,
    reports: 1,
    severity: report.severity,
    firstAt: report.publishedAt,
    lastAt: report.publishedAt,
    sides: [],
    image: { url: image, publisher, ...(video ? { video } : {}) },
  };
}

const media = ({ image, video }) =>
  video ? ['video'] : image ? ['photo'] : [];

/** A Liveuamap item as a report of the Conflicts section. */
export function liveuamapReport(item) {
  const id = `lum-${item.id}`;
  const report = {
    id,
    hotspotId: WORLDWIDE_HOTSPOT,
    hotspotIds: [WORLDWIDE_HOTSPOT],
    title: item.title,
    url: item.url,
    publisher: 'Liveuamap',
    source: { name: 'Liveuamap' },
    kind: 'liveuamap',
    side: 'unknown',
    // A conflict map: everything it posts is at least related.
    ...readTitle(item.title),
    severityBy: 'rules',
    publishedAt: item.publishedAt,
    geo: {
      lat: item.lat,
      lon: item.lon,
      place: item.place,
      precision: 'city',
      confidence: 1,
      mappable: true,
      method: 'source',
    },
    media: media(item),
  };
  if (item.image)
    report.event = pictureEvent(
      id,
      report,
      item.image,
      item.video,
      'Liveuamap',
    );
  return report;
}

/**
 * A GDELT place named by its town and the area Natural Earth has there (a
 * disputed area as itself, else the country): GDELT's own names follow old
 * FIPS regions ("Bureij, Yerushalayim, Israel" for a camp in Gaza, "Abuja,
 * …, Niger" for Nigeria's capital). Its point stays. A town a disputed
 * area is named after ("Jerusalem" in East Jerusalem) lies on both sides
 * of its line: GDELT puts the whole city at one point, so it is named as
 * the town alone.
 */
export function gdeltPlace(geo) {
  const area = areaAt(geo.lat, geo.lon);
  const town = String(geo.place ?? '')
    .split(',')[0]
    .trim();
  const straddles =
    area?.kind === 'disputed' &&
    town &&
    area.name.toLowerCase().includes(town.toLowerCase());
  const place =
    geo.precision === 'country' && area?.kind === 'country'
      ? area.name
      : straddles
        ? town
        : [town, area?.name].filter(Boolean).join(', ');
  return { ...geo, place: place || null };
}

/**
 * A World News API article as a report of the Local section: placed in its
 * publisher's country alone, at a point inside it.
 */
export function worldNewsReport(article, country) {
  const id = `wna-${article.id}`;
  const anchor = countryAnchor(country);
  const report = {
    id,
    hotspotId: null,
    hotspotIds: [],
    title: article.title,
    url: article.url,
    publisher: article.publisher,
    // World News API's free plan asks to be credited where its news shows.
    source: { name: article.publisher, attribution: 'World News API' },
    kind: 'worldnewsapi',
    side: 'unknown',
    category: WORLD_NEWS_CATEGORY[article.category] || 'other',
    // Local news: what the country's own outlets publish, with no severity
    // of its own.
    relevance: 'minor',
    publishedAt: article.publishedAt,
    geo: {
      lat: anchor.lat,
      lon: anchor.lon,
      place: country.name,
      precision: 'country',
      confidence: 1,
      mappable: true,
      method: 'source',
    },
    media: media(article),
  };
  if (article.image)
    report.event = pictureEvent(
      id,
      report,
      article.image,
      article.video,
      article.publisher,
    );
  return report;
}

const AT = /^(-?\d{1,2}(?:\.\d{1,2})?),(-?\d{1,3}(?:\.\d{1,2})?)$/;
function point(value) {
  const match = AT.exec(String(value ?? ''));
  if (!match) return null;
  const [lat, lon] = [Number(match[1]), Number(match[2])];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

const noKey = (key) => ({ status: 503, body: { error: 'no_key', key } });
const rejectedKey = (key) => ({
  status: 503,
  body: { error: 'key_rejected', key },
});
const spentKey = (key) => ({ status: 503, body: { error: 'key_quota', key } });

/**
 * The keyed news routes. `answer(path, params)` resolves to `{status, body}`
 * for `/hotspots`, `/feed` and `/outline`, whose queries the proxy has
 * already checked against the client's allowlist. `later(run, ms)` runs
 * the next GDELT read of a day still filling in (an unref'd timer).
 * `firstAnswerMs` bounds the wait for a read with nothing to serve yet.
 * @param {{env?: () => object, fetchImpl?: typeof fetch, now?: () => number, log?: (message: string) => void, later?: (run: () => void, ms: number) => void, firstAnswerMs?: number}} [options]
 */
export function createKeyedNews({
  env = () => process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  log = (message) => console.warn(message),
  later = (run, ms) => setTimeout(run, ms).unref(),
  firstAnswerMs = FIRST_ANSWER_MS,
} = {}) {
  const keyOf = (id) => String(env()[NEWS_KEYS[id]] ?? '').trim();
  const inFlight = new Map();
  // GDELT's stories of the last day (their events and report, by
  // storyKey), and the exports read.
  const gdelt = {
    stories: new Map(),
    reports: new Map(),
    // Page titles by article address, of the stories kept.
    titles: new Map(),
    read: new Set(),
    // Exports still missing well after their time: not looked for again.
    gone: new Set(),
    // Failed reads of each export not read yet: `{tries, at}`.
    failures: new Map(),
    // Exports read among the newest whose GKG titles are not in yet, with
    // the tries made: `{tries, triedAt}`.
    untitled: new Map(),
    titling: null,
    // When a read last brought an export in.
    readAt: null,
    checkedAt: null,
    failedAt: null,
  };
  const live = new Map();
  const countries = new Map();
  // The keys refused so far, by section: logged once each.
  const refused = new Set();
  // World News API reads of the UTC day; `spent` once it answered 402.
  const budget = { day: null, reads: 0, spent: false, logged: false };
  // The areas (disputed area or country) of a placed Conflicts report's
  // pins, its first and the others, looked up once.
  const reportAreas = new WeakMap();
  const areasOf = (report) => {
    if (!reportAreas.has(report))
      reportAreas.set(
        report,
        new Set(
          [report.geo, ...(report.locations || [])]
            .filter(Boolean)
            .map((pin) => areaAt(pin.lat, pin.lon)?.key),
        ),
      );
    return reportAreas.get(report);
  };

  /** A failed read in the log: a refused key once, never the key itself. */
  function logFailure(section, what, key, error) {
    // The day's reads spent: said once, by spendRead.
    if (error.quota && error.status === null) return;
    if (error.rejected) {
      const id = `${section}\0${key}`;
      if (refused.has(id)) return;
      refused.add(id);
      log(
        `[news] ${NEWS_KEYS[section]} was refused (${error.status})${section === 'liveuamap' ? "; Conflicts are GDELT's alone" : ''}`,
      );
      return;
    }
    log(`[news] ${what} read failed: ${error.message}`);
  }

  /**
   * A cached read (`{key, value, readAt, failedAt, error}`, kept in `store`
   * under `id`): served as it is within `freshMs`; past that read again,
   * and served meanwhile up to `staleMs`, so only a read with nothing to
   * serve is waited for. One read at a time per key; a failed read is tried
   * again after RETRY_MS. A new key drops what the old one read.
   */
  async function cached(
    store,
    id,
    { section, key, freshMs, staleMs, read, what },
  ) {
    const at = now();
    const stored = store.get(id);
    const prior = stored?.key === key ? stored : { key };
    if (prior.value && at - prior.readAt < freshMs) return prior;
    if (prior.failedAt && at - prior.failedAt < RETRY_MS) return prior;
    const flight = `${id}\0${key}`;
    if (!inFlight.has(flight))
      inFlight.set(
        flight,
        read(key)
          .then(
            (value) => ({ key, value, readAt: now() }),
            (error) => {
              logFailure(section, what, key, error);
              // What is held now: news deleted meanwhile stays deleted.
              const held = store.get(id);
              return {
                ...(held?.key === key ? held : { key }),
                failedAt: now(),
                error,
              };
            },
          )
          .then((entry) => {
            // A read with a key replaced meanwhile is dropped.
            if (keyOf(section) === key) keep(store, id, entry);
            return entry;
          })
          .finally(() => inFlight.delete(flight)),
      );
    if (prior.value && at - prior.readAt < staleMs) return prior;
    // Meanwhile a refused key stays refused; an older failure is not this one.
    return firstAnswer(inFlight.get(flight), {
      ...prior,
      error: prior.error?.rejected ? prior.error : null,
    });
  }

  /** An entry stored as the most recently used (the countries are capped). */
  function keep(store, id, entry) {
    store.delete(id);
    store.set(id, entry);
    while (store.size > MAX_COUNTRIES) store.delete(store.keys().next().value);
  }

  /** `read`, waited for at most firstAnswerMs; then `fallback`, as it goes on. */
  async function firstAnswer(read, fallback) {
    let timer;
    try {
      return await Promise.race([
        read,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(fallback), firstAnswerMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** An entry's reports while they may be served, else why there are none. */
  function served(entry, staleMs, id) {
    if (entry.value && now() - entry.readAt < staleMs)
      return { reports: entry.value, readAt: entry.readAt };
    if (entry.error?.rejected) return { rejected: id };
    if (entry.error?.quota) return { quota: id };
    return { failed: true };
  }

  async function liveuamapReports() {
    const key = keyOf('liveuamap');
    if (!key) return { missing: 'liveuamap' };
    const entry = await cached(live, 'liveuamap', {
      section: 'liveuamap',
      key,
      freshMs: LIVE_FRESH_MS,
      staleMs: LIVE_STALE_MS,
      what: 'liveuamap',
      read: async (k) =>
        (await fetchLiveuamap({ key: k, fetchImpl, now: now() }))
          .map(liveuamapReport)
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    });
    return served(entry, LIVE_STALE_MS, 'liveuamap');
  }

  /**
   * A story placed (again) from all its events and the titles in: an
   * agency story run by several outlets is one report.
   */
  function placeStory(key) {
    const [report] = eventReports(gdelt.stories.get(key), {
      titleOf: (url) => gdelt.titles.get(url) || null,
    });
    if (!report) return;
    const { eventWords, ...rest } = report;
    const geo = gdeltPlace(report.geo);
    gdelt.reports.set(key, {
      ...rest,
      ...(eventWords ? { title: eventTitle(eventWords, geo.place) } : {}),
      hotspotId: WORLDWIDE_HOTSPOT,
      hotspotIds: [WORLDWIDE_HOTSPOT],
      geo,
      locations: report.locations.map(gdeltPlace),
    });
  }

  /** An export's events into their stories, each placed again. */
  function addEvents(events) {
    const changed = new Set();
    for (const event of events) {
      const key = storyKey(event);
      const list = gdelt.stories.get(key) || [];
      if (list.length < MAX_STORY_EVENTS) list.push(event);
      gdelt.stories.set(key, list);
      changed.add(key);
    }
    for (const key of changed) placeStory(key);
  }

  /** The stories a GKG export titled, re-titled. */
  function addTitles(titles) {
    for (const [key, list] of gdelt.stories) {
      const titled = list.filter((event) => titles.has(event.url));
      if (!titled.length) continue;
      for (const { url } of titled) gdelt.titles.set(url, titles.get(url));
      placeStory(key);
    }
  }

  /**
   * The page titles of the newest exports read, from their GKG exports one
   * at a time (each runs to 18 MB unzipped), in the background: no answer
   * waits for them, and a story is re-titled as its title comes in. A file
   * that fails or is not up yet only leaves address words: it is tried
   * again with a later read while among the newest, up to GKG_TRIES times.
   */
  function readTitles() {
    gdelt.titling ??= (async () => {
      let failed = null;
      for (const [url, tried] of [...gdelt.untitled]) {
        if (!gdelt.untitled.has(url)) continue;
        if (tried.triedAt !== null && now() - tried.triedAt < GDELT_FRESH_MS)
          continue;
        tried.tries += 1;
        tried.triedAt = now();
        const wanted = new Set();
        for (const list of gdelt.stories.values())
          for (const event of list) wanted.add(event.url);
        let titles = null;
        try {
          titles = await fetchTitles(gkgUrl(url), wanted, { fetchImpl });
        } catch (error) {
          failed ??= error;
        }
        if (titles || tried.tries >= GKG_TRIES) gdelt.untitled.delete(url);
        if (titles?.size) addTitles(titles);
      }
      if (failed) log(`[news] gdelt titles read failed: ${failed.message}`);
    })()
      .catch((error) => log(`[news] gdelt titles failed: ${error.message}`))
      .finally(() => {
        gdelt.titling = null;
      });
    return gdelt.titling;
  }

  /**
   * Up to a dozen of the day's exports not read yet, newest first; whether
   * to carry on at once (the round brought one in, and more are missing).
   * One not up yet is looked for again; one still missing GDELT_GONE_MS
   * after its time is not.
   */
  async function readExports() {
    const at = now();
    const day = exportsOfDay(at);
    // Up to the newest GDELT lists; all of the day when its list fails.
    const latest = await fetchLatestExport({ fetchImpl });
    const listed = (url) => latest === null || exportAt(url) <= latest;
    const newest = new Set(day.slice(0, GDELT_TITLED_EXPORTS));
    const wanted = (url) =>
      listed(url) && !gdelt.read.has(url) && !gdelt.gone.has(url);
    const missing = day.filter(wanted).slice(0, GDELT_EXPORTS_PER_READ);
    let failed = null;
    let added = 0;
    const failing = [];
    const unreadable = [];
    const unpublished = [];
    for (let i = 0; i < missing.length; i += GDELT_PARALLEL)
      await Promise.all(
        missing.slice(i, i + GDELT_PARALLEL).map(async (url) => {
          let events;
          try {
            events = await fetchExport(url, { fetchImpl });
          } catch (error) {
            failed = error;
            (error.unreadable ? unreadable : failing).push(url);
            return;
          }
          if (!events) {
            if (at - exportAt(url) >= GDELT_GONE_MS) unpublished.push(url);
            return;
          }
          // The events count now; the titles follow (readTitles).
          gdelt.read.add(url);
          gdelt.failures.delete(url);
          added += 1;
          gdelt.readAt = now();
          addEvents(events);
          if (newest.has(url))
            gdelt.untitled.set(url, { tries: 0, triedAt: null });
        }),
      );
    if (failed) log(`[news] gdelt read failed: ${failed.message}`);
    // A file is blamed only while GDELT itself answers (its list read, or
    // another export of the round read): then a 404 long after its time is
    // never published, an unreadable file stays so, and a failing one gets a
    // few tries, one a GDELT_FRESH_MS. With GDELT down, no file is blamed.
    const answering = added > 0 || latest !== null;
    if (answering)
      for (const url of [...unpublished, ...unreadable]) gdelt.gone.add(url);
    if (added)
      for (const url of failing) {
        const prior = gdelt.failures.get(url);
        if (prior && now() - prior.at < GDELT_FRESH_MS) continue;
        const tries = (prior?.tries || 0) + 1;
        gdelt.failures.set(url, { tries, at: now() });
        if (tries >= GDELT_EXPORT_TRIES) gdelt.gone.add(url);
      }
    // Nothing read and a failure: tried again after RETRY_MS, not after
    // GDELT_FRESH_MS. Something read: the round counts.
    if (failed && !added) gdelt.failedAt = now();
    else {
      gdelt.checkedAt = now();
      gdelt.failedAt = null;
    }
    // Only the day is kept, and titled while among the newest.
    const kept = new Set(day);
    for (const set of [gdelt.read, gdelt.gone])
      for (const url of set) if (!kept.has(url)) set.delete(url);
    for (const url of gdelt.failures.keys())
      if (!kept.has(url)) gdelt.failures.delete(url);
    for (const url of gdelt.untitled.keys())
      if (!newest.has(url)) gdelt.untitled.delete(url);
    return (
      added > 0 && missing.length === GDELT_EXPORTS_PER_READ && day.some(wanted)
    );
  }

  /** GDELT's reports of the last day, newest first, or `{failed}`. */
  async function gdeltReports() {
    const at = now();
    const fresh = gdelt.checkedAt && at - gdelt.checkedAt < GDELT_FRESH_MS;
    const resting = gdelt.failedAt && at - gdelt.failedAt < RETRY_MS;
    if (!fresh && !resting && !inFlight.has('gdelt')) {
      const round = readExports()
        .then(
          (more) => {
            // More of the day to fill in: carry on shortly, without holding
            // the answer.
            if (!more) return;
            gdelt.checkedAt = null;
            later(() => void gdeltReports(), GDELT_NEXT_MS);
          },
          (error) => {
            log(`[news] gdelt read failed: ${error.message}`);
            gdelt.failedAt = now();
          },
        )
        .finally(() => {
          inFlight.delete('gdelt');
          void readTitles();
        });
      inFlight.set('gdelt', round);
    }
    // Only a read with nothing (recent) to serve is waited for: the
    // newest exports' events, not their titles.
    const current = () =>
      gdelt.readAt !== null && now() - gdelt.readAt < GDELT_STALE_MS;
    // A slow GDELT must not outlast the browser's own timeout: what has come
    // in by then is served.
    if (!current() && inFlight.has('gdelt'))
      await firstAnswer(inFlight.get('gdelt'));
    if (!current()) return { failed: true };
    const dayAgo = new Date(now() - DAY_MS).toISOString();
    // Exports are read in parallel, so reports of one time arrive in any
    // order: the most mentioned comes first, then by id.
    const reports = [...gdelt.reports.values()]
      .filter((r) => r.publishedAt >= dayAgo)
      .sort(
        (a, b) =>
          b.publishedAt.localeCompare(a.publishedAt) ||
          b.mentions - a.mentions ||
          a.id.localeCompare(b.id),
      )
      .slice(0, MAX_GDELT_REPORTS);
    if (reports.length !== gdelt.reports.size) {
      const kept = new Set(reports);
      for (const [key, report] of gdelt.reports)
        if (!kept.has(report)) {
          for (const event of gdelt.stories.get(key) || [])
            gdelt.titles.delete(event.url);
          gdelt.reports.delete(key);
          gdelt.stories.delete(key);
        }
    }
    return { reports, readAt: gdelt.readAt };
  }

  /**
   * The Conflicts section's reports: GDELT's, with Liveuamap's when its key
   * is set. Liveuamap failing (or refusing its key) leaves GDELT's.
   */
  async function conflictReports() {
    const [articles, items] = await Promise.all([
      gdeltReports(),
      keyOf('liveuamap') ? liveuamapReports() : {},
    ]);
    if (!articles.reports && !items.reports) return { failed: true };
    return {
      reports: [...(articles.reports || []), ...(items.reports || [])].sort(
        (a, b) => b.publishedAt.localeCompare(a.publishedAt),
      ),
      readAt: Math.max(articles.readAt || 0, items.readAt || 0),
    };
  }

  const dailyReads = () => {
    const raw = String(env().WORLDNEWSAPI_DAILY_READS ?? '').trim();
    const reads = raw ? Number(raw) : NaN;
    return Number.isInteger(reads) && reads >= 0 ? reads : DEFAULT_DAILY_READS;
  };

  /** Whether a World News API read is left today (UTC); counts it if so. */
  function spendRead() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (budget.day !== day)
      Object.assign(budget, { day, reads: 0, spent: false, logged: false });
    if (!budget.spent && budget.reads < dailyReads()) {
      budget.reads += 1;
      return true;
    }
    if (!budget.logged)
      log(
        "[news] World News API's reads for today are spent; Local reads again after 00:00 UTC",
      );
    budget.logged = true;
    return false;
  }

  /** World News API's news an hour old is deleted, as its terms ask. */
  function dropExpiredCountries() {
    for (const [code, entry] of countries)
      if (entry.value && now() - entry.readAt >= COUNTRY_STALE_MS) {
        const { value, readAt, ...rest } = entry;
        countries.set(code, rest);
      }
  }

  async function countryReports(country) {
    const key = keyOf('worldnewsapi');
    if (!key) return { missing: 'worldnewsapi' };
    const stored = countries.get(country.code);
    if (stored) keep(countries, country.code, stored);
    const entry = await cached(countries, country.code, {
      section: 'worldnewsapi',
      key,
      freshMs: COUNTRY_FRESH_MS,
      staleMs: COUNTRY_STALE_MS,
      what: `worldnewsapi:${country.code}`,
      read: async (k) => {
        // Not asked: no status, unlike an answer.
        if (!spendRead())
          throw new UpstreamError("World News API's reads for today spent", {
            quota: true,
          });
        const { day } = budget;
        try {
          const reports = (
            await fetchWorldNews({
              key: k,
              country: country.code,
              fetchImpl,
              now: now(),
            })
          ).map((article) => worldNewsReport(article, country));
          // Deleted an hour on, whether or not anything is asked then.
          setTimeout(dropExpiredCountries, COUNTRY_STALE_MS + 1000).unref?.();
          return reports;
        } catch (error) {
          // Out of points: nothing more is asked today.
          if (error.status === 402) budget.spent = true;
          // Never reached (offline): no read of the day it was counted in.
          if (error.unreached && budget.day === day && budget.reads > 0)
            budget.reads -= 1;
          throw error;
        }
      },
    });
    return served(entry, COUNTRY_STALE_MS, 'worldnewsapi');
  }

  const refusal = (read) =>
    read.missing
      ? noKey(read.missing)
      : read.rejected
        ? rejectedKey(read.rejected)
        : read.quota
          ? spentKey(read.quota)
          : read.failed
            ? { status: 502, body: { error: 'news_upstream_error' } }
            : null;

  async function hotspots(params) {
    const read = await conflictReports();
    const refused = refusal(read);
    if (refused) return refused;
    const hours = Number(params.get('hours')) || 24;
    const since = new Date(now() - hours * HOUR_MS).toISOString();
    // The reports Conflicts lists: a minor one is in no count.
    const shown = read.reports.filter(
      (r) => r.publishedAt >= since && r.relevance !== 'minor',
    );
    return {
      status: 200,
      body: {
        hotspots: [
          {
            id: WORLDWIDE_HOTSPOT,
            name: 'Worldwide',
            kind: 'conflict',
            catchAll: true,
            bbox: [-180, -90, 180, 90],
            parties: [],
            developing: [],
            counts: {
              last24h: shown.length,
              mapped24h: shown.filter((r) => r.geo).length,
              prev24h: null,
            },
            latestAt: shown[0]?.publishedAt ?? null,
          },
        ],
        categories: CATEGORY_ORDER,
        ingest: { lastRunAt: new Date(read.readAt).toISOString() },
        windowHours: hours,
        maxWindowHours: 24,
      },
    };
  }

  /** Reports filtered, newest first, and paged by `before`. */
  function page(reports, params) {
    const since = params.get('since');
    const before = params.get('before');
    const dayAgo = new Date(now() - DAY_MS).toISOString();
    const categories = list(params.get('category'));
    const relevance = list(params.get('relevance'));
    const hotspot = params.get('hotspot');
    const limit = Number(params.get('limit')) || DEFAULT_LIMIT;
    const kept = reports.filter(
      (r) =>
        (!hotspot || hotspot === 'all' || r.hotspotIds.includes(hotspot)) &&
        (!since || r.publishedAt >= since) &&
        (!before || r.publishedAt < before) &&
        (!params.has('today') || r.publishedAt >= dayAgo) &&
        (!params.has('geo') || r.geo) &&
        (!categories || categories.has(r.category)) &&
        (!relevance || relevance.has(r.relevance)),
    );
    const shown = kept.slice(0, limit);
    // A page ends between two times: the next asks for those `before` the
    // last, and a GDELT export's reports all share its quarter hour.
    while (
      shown.length < kept.length &&
      kept[shown.length].publishedAt === shown.at(-1).publishedAt
    )
      shown.push(kept[shown.length]);
    const events = params.has('events');
    return {
      reports: events ? shown : shown.map(({ event, ...report }) => report),
      nextBefore: kept.length > shown.length ? shown.at(-1).publishedAt : null,
    };
  }

  async function feed(params) {
    const at = params.has('at') ? point(params.get('at')) : null;
    const area = at ? areaAt(at.lat, at.lon) : null;
    if (!area) {
      // Conflicts, or Local at sea (by distance, in the browser).
      const read = await conflictReports();
      return refusal(read) || { status: 200, body: page(read.reports, params) };
    }
    // Local in a country: its own outlets, with the Conflicts reports
    // placed inside it (those failing leave the outlets'). In a disputed
    // area no country's outlets speak for it: the Conflicts reports there
    // alone, so their failing is the answer's.
    const country = area.kind === 'country';
    const [national, conflicts] = await Promise.all([
      country ? countryReports(area.country) : { reports: [] },
      conflictReports(),
    ]);
    const refused = refusal(national) || (!country && refusal(conflicts));
    if (refused) return refused;
    const inside = (conflicts.reports || []).filter((r) =>
      areasOf(r).has(area.key),
    );
    const reports = [...national.reports, ...inside].sort((a, b) =>
      b.publishedAt.localeCompare(a.publishedAt),
    );
    return { status: 200, body: page(reports, params) };
  }

  function outline(params) {
    if (params.has('at')) {
      const at = point(params.get('at'));
      const area = at ? areaAt(at.lat, at.lon) : null;
      if (!area) return { status: 200, body: EMPTY_OUTLINE };
      return {
        status: 200,
        body: {
          ...EMPTY_OUTLINE,
          polygons:
            area.kind === 'country'
              ? countryPolygons(area.country)
              : area.polygons,
          area: {
            key: area.key,
            name: area.name,
            kind: area.kind,
            country: area.code,
          },
        },
      };
    }
    // A developing situation's country; the world has no outline.
    const country = countryByCode(
      String(params.get('country') ?? '').slice(0, 2),
    );
    return {
      status: 200,
      body: country
        ? { ...EMPTY_OUTLINE, polygons: countryPolygons(country) }
        : EMPTY_OUTLINE,
    };
  }

  return {
    async answer(path, params) {
      dropExpiredCountries();
      if (path === '/hotspots') return hotspots(params);
      if (path === '/feed') return feed(params);
      if (path === '/outline') return outline(params);
      return { status: 404, body: { error: 'not_found' } };
    },
  };
}
