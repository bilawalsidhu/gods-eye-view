/**
 * @module data/satelliteFeeds
 * @description Registry of satellites that expose a public, near-real-time feed,
 * plus pure lookup helpers. Keyed by NORAD catalog number so the satellites
 * layer (which keys everything on NORAD id) can mark feed-capable dots, and the
 * SAT FEED panel can resolve a spec from whatever subject is currently tracked.
 *
 * Two feed kinds:
 *  - `video`   — a live embed (the ISS). Carries one or more named `sources`
 *                so the panel can switch between, e.g., NASA's official channel
 *                and an always-on Earth-view rebroadcast.
 *  - `imagery` — an auto-refreshing full-disk still from a geostationary
 *                weather satellite. `frameUrl(nowMs)` returns the current best
 *                frame URL; the controller re-reads it every `refreshMs`.
 *
 * Everything here is data plus pure functions — no DOM, no network, no timers.
 * NORAD ids are cross-checked against CelesTrak's `geo` / `stations` groups
 * (the same catalog `satellites.js` loads); an id that ever falls out of the
 * catalog simply loses its dot badge, the panel still opens if that object is
 * tracked by name.
 */

const TEN_MIN_MS = 10 * 60 * 1000;

/** Privacy-enhanced YouTube embed host (no cookies until the viewer plays). */
const YT_EMBED_HOST = 'https://www.youtube-nocookie.com';

/**
 * Build a channel live-stream embed URL. `live_stream?channel=<id>` always
 * resolves to whatever broadcast that channel currently has live, so the embed
 * survives the upstream restarting its stream (which rotates the video id).
 * `mute=1` is mandatory — browsers block autoplay with sound.
 * @param {string} channelId YouTube `UC…` channel id.
 * @returns {string}
 */
export function youtubeChannelLiveEmbed(channelId) {
  const params = new URLSearchParams({
    channel: channelId,
    autoplay: '1',
    mute: '1',
    playsinline: '1',
    rel: '0',
  });
  return `${YT_EMBED_HOST}/embed/live_stream?${params.toString()}`;
}

/**
 * Embed URL for a specific YouTube video id. Unlike the channel-live form,
 * these can be driven by the IFrame API's `loadVideoById`, which is how the
 * panel probes a list of candidates and lands on the first that actually plays.
 * @param {string} videoId 11-char YouTube video id.
 * @returns {string}
 */
export function youtubeVideoEmbed(videoId) {
  const params = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    playsinline: '1',
    rel: '0',
  });
  return `${YT_EMBED_HOST}/embed/${videoId}?${params.toString()}`;
}

// ISS live video ids, probed in order via the IFrame API (ids rotate when a
// channel restarts its stream and any one can be embed-blocked or offline at a
// given moment; OPEN LIVE STREAM is the escape hatch if the whole list fails).
//   NASA source  → NASA's own channel first (awQzjn72bI0 = "Official NASA
//                  Stream", 21X5lGlDOfg = NASA TV), then rebroadcasters.
//   24/7 Earth   → continuous third-party rebroadcasts first (afarTV, The
//                  Launch Pad) that stay on the external Earth camera rather
//                  than cutting to NASA TV studio programming.
const ISS_VIDEO_CANDIDATES_NASA = Object.freeze([
  'awQzjn72bI0', '21X5lGlDOfg', 'tj4knR4r1UU', 't8B3ACpcNfc',
]);
const ISS_VIDEO_CANDIDATES_EARTH = Object.freeze([
  'tj4knR4r1UU', 't8B3ACpcNfc', 'awQzjn72bI0',
]);

/**
 * NOAA STAR publishes a rolling `latest.jpg` GeoColor full disk per GOES
 * satellite (CORS-open, ~10 min behind real time). A 10-minute cache-bust
 * bucket keeps the CDN edge honest without hammering it.
 * @param {'GOES19'|'GOES18'|'GOES16'} cdnKey NOAA STAR path segment.
 * @returns {(nowMs: number) => string}
 */
function goesGeoColorLatest(cdnKey) {
  return (nowMs) => {
    const bucket = Math.floor((Number(nowMs) || 0) / TEN_MIN_MS);
    return `https://cdn.star.nesdis.noaa.gov/${cdnKey}/ABI/FD/GEOCOLOR/latest.jpg?_=${bucket}`;
  };
}

/**
 * NICT publishes a Himawari-9 full-disk frame every 10 min with ~10–15 min of
 * processing latency and sends NO CORS headers — so its `latest.json` cannot be
 * read from the browser. Compute the timestamp instead: now − 30 min, floored
 * to the 10-minute cadence, in UTC, seconds always `00`. The 30-minute lookback
 * clears the latency with margin so the frame reliably exists. This mirrors how
 * the GIBS basemap pins its own `TIME` dimension client-side.
 * @param {number} nowMs
 * @returns {string}
 */
export function himawariFullDiskUrl(nowMs) {
  const floored = Math.floor(((Number(nowMs) || 0) - 30 * 60 * 1000) / TEN_MIN_MS) * TEN_MIN_MS;
  const t = new Date(floored);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())}`;
  const hhmmss = `${p(t.getUTCHours())}${p(t.getUTCMinutes())}00`;
  return `https://himawari8-dl.nict.go.jp/himawari8/img/D531106/1d/550/${stamp}/${hhmmss}_0_0.png`;
}

/**
 * @param {number} noradId
 * @param {string} shortLabel
 * @param {string} name
 * @param {'GOES19'|'GOES18'} cdnKey
 * @param {string} note
 * @returns {object} Frozen imagery feed spec.
 */
function goesFeed(noradId, shortLabel, name, cdnKey, note) {
  return Object.freeze({
    noradId,
    name,
    shortLabel,
    kind: 'imagery',
    frameUrl: goesGeoColorLatest(cdnKey),
    refreshMs: TEN_MIN_MS,
    aspect: '1 / 1',
    attribution: 'NOAA STAR / NESDIS',
    watchUrl: `https://www.star.nesdis.noaa.gov/goes/fulldisk.php?sat=${cdnKey}&band=GEOCOLOR&length=12`,
    note,
  });
}

/** NORAD 25544 — International Space Station. */
const ISS_FEED = Object.freeze({
  noradId: 25544,
  name: 'ISS (ZARYA)',
  shortLabel: 'ISS',
  kind: 'video',
  aspect: '16 / 9',
  defaultSourceId: 'nasa',
  sources: Object.freeze([
    Object.freeze({
      id: 'nasa',
      label: 'NASA',
      // Inline: the first public ISS rebroadcast that actually plays (the panel
      // probes the list via the IFrame API). Escape hatch: NASA's own live page.
      videoIds: ISS_VIDEO_CANDIDATES_NASA,
      embedUrl: youtubeVideoEmbed(ISS_VIDEO_CANDIDATES_NASA[0]),
      channelLiveUrl: youtubeChannelLiveEmbed('UCLA_DiR1FfKNvjuUpBHmylQ'),
      watchUrl: 'https://plus.nasa.gov/scheduled-video/nasa-live/',
      attribution: 'ISS live (YouTube) · official stream at NASA Live',
      note: 'Live external ISS cameras. OPEN LIVE STREAM goes to NASA Live if the inline player cannot find a working stream.',
    }),
    Object.freeze({
      id: 'earth',
      label: '24/7 Earth',
      videoIds: ISS_VIDEO_CANDIDATES_EARTH,
      embedUrl: youtubeVideoEmbed(ISS_VIDEO_CANDIDATES_EARTH[0]),
      watchUrl: 'https://www.youtube.com/results?search_query=ISS+live+stream+earth+from+space',
      attribution: 'Public ISS HD rebroadcast (YouTube)',
      note: 'Continuous ISS external cameras. Goes dark on the orbital night side (~45 min per pass).',
    }),
  ]),
});

/**
 * The registry, in panel display order (ISS first, then geostationary sats
 * west-to-east-ish). Every entry is frozen.
 * @type {ReadonlyArray<object>}
 */
export const SATELLITE_FEEDS = Object.freeze([
  ISS_FEED,
  goesFeed(
    60133, 'GOES-19', 'GOES 19 (East)', 'GOES19',
    'GOES-19 · 75.2°W · the Americas and the Atlantic. GeoColor full disk, ~10 min old.',
  ),
  goesFeed(
    51850, 'GOES-18', 'GOES 18 (West)', 'GOES18',
    'GOES-18 · 137.0°W · the eastern Pacific and the US West. GeoColor full disk, ~10 min old.',
  ),
  Object.freeze({
    noradId: 41836,
    name: 'HIMAWARI-9',
    shortLabel: 'Himawari-9',
    kind: 'imagery',
    frameUrl: himawariFullDiskUrl,
    refreshMs: TEN_MIN_MS,
    aspect: '1 / 1',
    attribution: 'NICT',
    watchUrl: 'https://himawari8.nict.go.jp/',
    note: 'Himawari-9 · 140.7°E · East Asia, Australia and the western Pacific. Full disk, ~30 min old.',
  }),
]);

const _byNorad = new Map(SATELLITE_FEEDS.map((feed) => [feed.noradId, feed]));

/** Fast membership set for per-frame dot styling in the satellites layer. */
export const SATELLITE_FEED_IDS = Object.freeze(new Set(_byNorad.keys()));

/** NORAD ids in panel/cycle order (ISS, then the geostationary sats). */
export const SATELLITE_FEED_ORDER = Object.freeze(SATELLITE_FEEDS.map((feed) => feed.noradId));

/**
 * NORAD ids of feeds that are genuine live video (`kind: 'video'`) — the subset
 * the panel's LIVE FEEDS ONLY filter keeps, excluding the GOES / Himawari
 * full-disk imagery that only refreshes a still every ~10 min.
 */
export const SATELLITE_VIDEO_FEED_ORDER = Object.freeze(
  SATELLITE_FEEDS.filter((feed) => feed.kind === 'video').map((feed) => feed.noradId),
);

/**
 * @param {number|string} noradId
 * @returns {object|null} The frozen feed spec, or null.
 */
export function feedForNorad(noradId) {
  return _byNorad.get(Number(noradId)) || null;
}

/**
 * @param {number|string} noradId
 * @returns {boolean}
 */
export function hasSatelliteFeed(noradId) {
  return _byNorad.has(Number(noradId));
}

/**
 * Resolve a video feed's active source, falling back to its default then its
 * first entry. Returns null for non-video feeds.
 * @param {object|null} feed A spec from {@link SATELLITE_FEEDS}.
 * @param {string|null} [sourceId]
 * @returns {object|null}
 */
export function resolveFeedSource(feed, sourceId = null) {
  if (!feed || feed.kind !== 'video' || !Array.isArray(feed.sources) || !feed.sources.length) {
    return null;
  }
  return feed.sources.find((s) => s.id === sourceId)
    || feed.sources.find((s) => s.id === feed.defaultSourceId)
    || feed.sources[0];
}
