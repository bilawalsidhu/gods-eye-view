import {
  joinMessageSigns,
  MESSAGE_NAME_RE,
} from '../../src/layers/messageSigns/records.js';
import { GIF_MAX_BYTES, gifSize } from '../../src/layers/messageSigns/gif.js';
import {
  coalesceProxyRequest,
  readResponseBytesCapped,
  readResponseJsonCapped,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSiteKeyless } from './common/same-site.js';

// MnDOT's IRIS public resources (keyless; listed under "Public Resources" in
// the IRIS REST API docs). Three feeds join into the lit-sign list, and
// iris/img holds MnDOT's own GIF of each active message.
const IRIS = 'https://data.dot.state.mn.us/iris';
const FEEDS = {
  signs: `${IRIS}/dms_pub`,
  states: `${IRIS}/dms_message`,
  messages: `${IRIS}/sign_message`,
};
/** The feeds regenerate about every 30 s. Upstream sends max-age=5 and
 * no-store, so its cache headers are ignored. */
const CACHE_MS = 30_000;
/** Data this old reads as stale: a frozen feed or a failed refresh. */
const STALE_AFTER_MS = 2 * 60_000;
/** Data this old is not served at all. */
const MAX_AGE_MS = 10 * 60_000;
const FAILURE_COOLDOWN_MS = 15_000;
const FEED_MAX_BYTES = 512 * 1024; // Each feed is 40-110 KB today.
const TIMEOUT_MS = 10_000;
const GIF_CACHE_MAX = 300;
/** MnDOT deletes a message's image a few minutes after replacing it. */
const GIF_MISS_MS = 60_000;
const GIF_ROUTE_RE = /^\/img\/([A-Za-z0-9_]+)\.gif$/;

/** A feed's age when MnDOT sent it, on MnDOT's own clock (its Date header)
 * so a skewed clock here cannot age or freshen the data. */
function feedAge(response, now) {
  const modified = Date.parse(response.headers.get('last-modified') ?? '');
  if (!Number.isFinite(modified)) return null;
  const sent = Date.parse(response.headers.get('date') ?? '');
  // Without a Date, our clock; one ahead of ours cannot make data newer.
  return Math.max(0, (Number.isFinite(sent) ? sent : now) - modified);
}

/** Fixed-origin, bounded MnDOT message-sign routes for dev and preview. */
export function messageSignsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
} = {}) {
  let entry = null;
  let cooldownUntil = -Infinity;
  let currentNames = new Set();
  let previousNames = new Set();
  const inFlight = new Map();
  const gifs = new Map();
  const gifMisses = new Map();
  const gifsInFlight = new Map();
  const allowList = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 600,
  });
  // One face-budget burst (about 40 images) plus moveEnd re-selections.
  const allowGif = makeRateLimiter({
    windowMs: 60_000,
    max: 240,
    globalMax: 2400,
  });

  async function loadSigns() {
    if (monotonicNow() < cooldownUntil) throw new Error('cooling_down');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(TIMEOUT_MS),
    ]);
    try {
      const reads = Object.entries(FEEDS).map(async ([key, url]) => {
        const response = await fetchImpl(url, {
          signal,
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('upstream_unavailable');
        }
        const age = feedAge(response, now());
        const body = await readResponseJsonCapped(
          response,
          FEED_MAX_BYTES,
          signal,
        );
        return [key, { body, age }];
      });
      let feeds;
      try {
        feeds = Object.fromEntries(await Promise.all(reads));
      } catch (error) {
        controller.abort(); // One feed failed: stop reading the others.
        throw error;
      }
      // The older of the two fast feeds, so a frozen dms_message cannot hide
      // behind a sign_message that keeps regenerating.
      const ages = [feeds.states.age, feeds.messages.age].filter(
        (age) => age !== null,
      );
      if (!ages.length) throw new Error('undated_snapshot');
      const { signs, joinMisses } = joinMessageSigns({
        signs: feeds.signs.body,
        states: feeds.states.body,
        messages: feeds.messages.body,
      });
      return {
        value: { provider: 'mndot', signs, joinMisses },
        savedAt: monotonicNow(),
        ageAtReceipt: Math.max(...ages),
      };
    } catch (error) {
      cooldownUntil = monotonicNow() + FAILURE_COOLDOWN_MS;
      throw error;
    }
  }

  function sinceSaved(saved) {
    const elapsed = monotonicNow() - saved.savedAt;
    // A backwards injected clock cannot rejuvenate a snapshot.
    return elapsed < 0 ? Infinity : elapsed;
  }

  const ageOf = (saved) =>
    saved ? saved.ageAtReceipt + sinceSaved(saved) : Infinity;

  async function acquireSigns() {
    const previous = entry;
    if (previous && sinceSaved(previous) < CACHE_MS) return previous;
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'signs', loadSigns);
      const loaded = await promise;
      if (entry !== loaded) {
        entry = loaded;
        previousNames = currentNames;
        currentNames = new Set(loaded.value.signs.map((sign) => sign.message));
      }
      return loaded;
    } catch (error) {
      if (ageOf(previous) <= MAX_AGE_MS) return previous;
      throw error;
    }
  }

  async function loadGif(name) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(`${IRIS}/img/${name}.gif`, {
      signal,
      redirect: 'error',
      headers: { Accept: 'image/gif' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error('upstream_unavailable'), {
        status: response.status === 404 ? 404 : 502,
      });
    }
    if (!/^image\/gif\b/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new Error('not_a_gif');
    }
    const bytes = await readResponseBytesCapped(
      response,
      GIF_MAX_BYTES,
      signal,
    );
    if (!gifSize(bytes)) throw new Error('invalid_gif');
    return bytes;
  }

  async function acquireGif(name) {
    const cached = gifs.get(name);
    if (cached) {
      gifs.delete(name);
      gifs.set(name, cached);
      return cached;
    }
    const miss = gifMisses.get(name);
    if (miss && monotonicNow() < miss.until) {
      throw Object.assign(new Error('gif_unavailable'), {
        status: miss.status,
      });
    }
    const { promise } = coalesceProxyRequest(gifsInFlight, name, async () => {
      try {
        const bytes = await loadGif(name);
        gifs.set(name, bytes);
        while (gifs.size > GIF_CACHE_MAX) gifs.delete(gifs.keys().next().value);
        return bytes;
      } catch (error) {
        // Every failure is remembered, so an outage costs one upstream fetch
        // per message per cooldown rather than one per camera move.
        const missing = error.status === 404;
        gifMisses.delete(name);
        gifMisses.set(name, {
          until: monotonicNow() + (missing ? GIF_MISS_MS : FAILURE_COOLDOWN_MS),
          status: missing ? 404 : 502,
        });
        while (gifMisses.size > GIF_CACHE_MAX)
          gifMisses.delete(gifMisses.keys().next().value);
        throw error;
      }
    });
    return promise;
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...([429, 502].includes(status) ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    // Refuse cross-site browser requests (an <img> or fetch from another
    // site) before the limiters or upstream see them. Same-origin app
    // requests, non-browser loopback callers and the app served behind a
    // reverse proxy pass.
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    const peer = clientKey(req);

    if (path === '/' || path === '') {
      if (!allowList(peer)) return json(429, { error: 'rate_limited' });
      try {
        const saved = await acquireSigns();
        const ageMs = Math.round(ageOf(saved));
        if (ageMs > MAX_AGE_MS) throw new Error('expired_snapshot');
        const stale = ageMs > STALE_AFTER_MS;
        // ageMs is measured on this server's clock, so the browser can date
        // the list without comparing its clock to ours.
        return json(200, { ...saved.value, ageMs, stale }, stale);
      } catch {
        return json(502, { error: 'message_signs_unavailable' });
      }
    }

    const name = GIF_ROUTE_RE.exec(path)?.[1];
    if (!name || !MESSAGE_NAME_RE.test(name)) {
      return json(404, { error: 'unknown_route' });
    }
    if (!allowGif(peer)) return json(429, { error: 'rate_limited' });
    // Only messages a recent list named, so this route cannot be used to
    // walk MnDOT's image store.
    if (!currentNames.has(name) && !previousNames.has(name)) {
      return json(404, { error: 'unknown_message' });
    }
    try {
      const bytes = await acquireGif(name);
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, max-age=300',
      });
      res.end(bytes);
    } catch (error) {
      json(error.status === 404 ? 404 : 502, {
        error:
          error.status === 404 ? 'unknown_message' : 'message_sign_unavailable',
      });
    }
  }

  return {
    name: 'message-signs',
    configureServer({ middlewares }) {
      middlewares.use('/api/message-signs', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/message-signs', handler);
    },
  };
}
