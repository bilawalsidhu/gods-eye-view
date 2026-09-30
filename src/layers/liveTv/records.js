import { LIVE_TV_COUNTRY_ANCHORS } from './anchors.js';

/** Channels listed per country page, and pages a country can hold. */
export const LIVE_TV_PAGE_SIZE = 40;
/** Streams kept per channel; players try them in this order. */
export const LIVE_TV_MAX_STREAMS_PER_CHANNEL = 4;
const MAX_URL_CHARS = 2048;
const MAX_TEXT_CHARS = 120;
const MAX_CATEGORIES = 4;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9._&+-]{0,127}$/;
/** Stream labels iptv-org publishes that the row repeats to the viewer. */
const KNOWN_LABELS = new Set(['Geo-blocked', 'Not 24/7']);
/**
 * Video platforms, matched anywhere in the host name. iptv-org lists direct
 * stream URLs, but a few are relays that re-stream a platform channel
 * (`twitch-m3u8.<x>.workers.dev`); those are refused too, so nothing here
 * ever plays or resolves a video platform's content (the reason #285 was
 * closed).
 */
const PLATFORM_HOSTS =
  /(youtube|youtu\.be|googlevideo|ytimg|twitch|dailymotion|facebook|fbcdn|vimeo)/i;

const text = (value, max = MAX_TEXT_CHARS) => {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) : clean;
};

/**
 * Whether a stream URL is one the browser player may open: an absolute
 * http(s) HLS playlist on a non-platform host, without embedded credentials.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlayableStreamUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  if (PLATFORM_HOSTS.test(url.hostname)) return false;
  return /\.m3u8$/i.test(url.pathname);
}

/**
 * Join the iptv-org channels, streams, blocklist and countries files into a
 * per-country index of channels with playable streams. Blocklisted (legal
 * and DMCA removals) and closed channels are dropped, and so are streams that
 * need a custom User-Agent or Referer (a browser cannot send them) or that are
 * not direct HLS playlists. Channels iptv-org marks NSFW are kept but flagged
 * `adult` and counted apart, so the viewer decides whether to list them.
 * Countries without a known anchor are counted, not placed.
 * @param {{channels: unknown, streams: unknown, blocklist: unknown, countries?: unknown}} files
 * @returns {{countries: object[], channelsByCountry: Map<string, object[]>, totals: object} | null}
 */
export function buildLiveTvIndex({ channels, streams, blocklist, countries }) {
  if (
    !Array.isArray(channels) ||
    !Array.isArray(streams) ||
    !Array.isArray(blocklist)
  )
    return null;
  const blocked = new Set(
    blocklist
      .map((entry) => entry?.channel)
      .filter((id) => typeof id === 'string'),
  );
  const names = new Map(
    (Array.isArray(countries) ? countries : [])
      .filter((entry) => COUNTRY_CODE.test(entry?.code))
      .map((entry) => [entry.code, text(entry.name) || entry.code]),
  );
  const totals = {
    channels: 0,
    streams: 0,
    adult: 0,
    excluded: { blocklist: 0, closed: 0, headers: 0, format: 0 },
    unplaced: 0,
  };
  const known = new Map();
  for (const channel of channels) {
    const id = channel?.id;
    if (typeof id !== 'string' || !CHANNEL_ID.test(id)) continue;
    if (!COUNTRY_CODE.test(channel.country)) continue;
    if (blocked.has(id)) {
      totals.excluded.blocklist++;
      continue;
    }
    if (channel.closed) {
      totals.excluded.closed++;
      continue;
    }
    known.set(id, channel);
  }
  const playable = new Map();
  // A channel's main feed first: other feeds may be another region or
  // language, so the player only falls back to them.
  const ordered = streams
    .map((stream, order) => ({ stream, order }))
    .sort(
      (a, b) =>
        (a.stream?.feed == null ? 0 : 1) - (b.stream?.feed == null ? 0 : 1) ||
        a.order - b.order,
    )
    .map(({ stream }) => stream);
  for (const stream of ordered) {
    const channel = known.get(stream?.channel);
    if (!channel) continue;
    if (stream.user_agent || stream.referrer) {
      totals.excluded.headers++;
      continue;
    }
    if (!isPlayableStreamUrl(stream.url)) {
      totals.excluded.format++;
      continue;
    }
    const list = playable.get(channel.id) || [];
    if (list.length >= LIVE_TV_MAX_STREAMS_PER_CHANNEL) continue;
    if (list.some((entry) => entry.url === stream.url)) continue;
    list.push({
      url: stream.url,
      quality: text(stream.quality, 16),
      labels: (Array.isArray(stream.labels) ? stream.labels : []).filter(
        (label) => KNOWN_LABELS.has(label),
      ),
    });
    playable.set(channel.id, list);
  }
  const channelsByCountry = new Map();
  for (const [id, list] of playable) {
    const channel = known.get(id);
    const entries = channelsByCountry.get(channel.country) || [];
    entries.push({
      id,
      name: text(channel.name) || id,
      categories: (Array.isArray(channel.categories) ? channel.categories : [])
        .map((category) => text(category, 24))
        .filter(Boolean)
        .slice(0, MAX_CATEGORIES),
      streams: list,
      ...(channel.is_nsfw === true ? { adult: true } : {}),
    });
    channelsByCountry.set(channel.country, entries);
    totals.channels++;
    if (channel.is_nsfw === true) totals.adult++;
    totals.streams += list.length;
  }
  const summary = [];
  for (const [code, entries] of channelsByCountry) {
    entries.sort(
      (a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id),
    );
    const anchor = LIVE_TV_COUNTRY_ANCHORS[code];
    if (!anchor) {
      totals.unplaced += entries.length;
      channelsByCountry.delete(code);
      continue;
    }
    const adult = entries.filter((entry) => entry.adult).length;
    summary.push({
      code,
      name: names.get(code) || code,
      lon: anchor[0],
      lat: anchor[1],
      channels: entries.length - adult,
      adult,
    });
  }
  summary.sort(
    (a, b) =>
      b.channels - a.channels ||
      b.adult - a.adult ||
      a.code.localeCompare(b.code),
  );
  return { countries: summary, channelsByCountry, totals };
}

const finite = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;

const count = (value) => Number.isInteger(value) && value >= 0;

/**
 * Validate the per-country summary the proxy returns. `channels` counts the
 * general channels and `adult` the 18+ ones; a country needs at least one.
 * @param {unknown} rows
 * @returns {object[] | null}
 */
export function sanitizeLiveTvCountries(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!COUNTRY_CODE.test(row?.code) || seen.has(row.code)) continue;
    if (!finite(row.lon, -180, 180) || !finite(row.lat, -90, 90)) continue;
    const adult = row.adult ?? 0;
    if (!count(row.channels) || !count(adult) || row.channels + adult < 1)
      continue;
    seen.add(row.code);
    out.push({
      code: row.code,
      name: text(row.name) || row.code,
      lon: row.lon,
      lat: row.lat,
      channels: row.channels,
      adult,
    });
  }
  return out;
}

/**
 * Validate one country page of channels the proxy returns.
 * @param {unknown} rows
 * @returns {object[] | null}
 */
export function sanitizeLiveTvChannels(rows) {
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !CHANNEL_ID.test(row.id)) continue;
    const streams = (Array.isArray(row.streams) ? row.streams : [])
      .filter((stream) => isPlayableStreamUrl(stream?.url))
      .slice(0, LIVE_TV_MAX_STREAMS_PER_CHANNEL)
      .map((stream) => ({
        url: stream.url,
        quality: text(stream.quality, 16),
        labels: (Array.isArray(stream.labels) ? stream.labels : []).filter(
          (label) => KNOWN_LABELS.has(label),
        ),
      }));
    if (!streams.length) continue;
    out.push({
      id: row.id,
      name: text(row.name) || row.id,
      categories: (Array.isArray(row.categories) ? row.categories : [])
        .map((category) => text(category, 24))
        .filter(Boolean)
        .slice(0, MAX_CATEGORIES),
      streams,
      ...(row.adult === true ? { adult: true } : {}),
    });
  }
  return out;
}

/** Whether a country code has the shape iptv-org uses. */
export const isLiveTvCountryCode = (value) =>
  typeof value === 'string' && COUNTRY_CODE.test(value);
