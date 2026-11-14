import { fetchHlsBytes } from './stream.js';

/** Only the published, anonymous HLS endpoint; never private access tokens. */
export function isPublicIvideonStream(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://openapi-alpha.ivideon.com' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /^\/cameras\/[A-Za-z0-9_-]+:\d+\/live_stream$/.test(url.pathname) &&
      url.searchParams.get('access_token') === 'public' &&
      url.searchParams.get('format') === 'hls' &&
      [...url.searchParams.keys()].length === 2
    );
  } catch {
    return false;
  }
}

/** A configured RTSP public player, never its private or paid-access routes. */
export function isPublicRtspPlayer(value) {
  try {
    const url = new URL(value);
    return (
      ['https://rtsp.ru', 'https://rtsp.me'].includes(url.origin) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/embed\/[A-Za-z0-9]+\/$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Resolve configured public streams while pinning camera identity and hosts. */
export function createPlayerResolver({
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  const keyFor = (source) => `${source.streamPageUrl}\n${source.url}`;
  const remember = (key, entry) => {
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > 256) cache.delete(cache.keys().next().value);
  };
  const resolve = async (source) => {
    const ivideon = isPublicIvideonStream(source.url);
    const rtsp = isPublicRtspPlayer(source.url);
    if (!source.streamPageUrl && !ivideon && !rtsp) return source.url;
    const page = new URL(ivideon || rtsp ? source.url : source.streamPageUrl);
    const media = new URL(source.url);
    if (
      !ivideon &&
      !rtsp &&
      (page.origin !== 'https://webcam.exdesign.ru' ||
        page.username ||
        page.password ||
        !/^\/[a-z0-9-]+\/$/.test(page.pathname) ||
        page.search ||
        page.hash ||
        ![
          'https://stream2.exdesign.ru',
          'https://stream3.exdesign.ru',
        ].includes(media.origin) ||
        media.username ||
        media.password ||
        !/^\/hls\/[a-z0-9-]+\/index\.m3u8$/.test(media.pathname) ||
        media.pathname.split('/')[2] !== page.pathname.split('/')[1])
    )
      throw new Error('Unsupported public player configuration');
    const key = keyFor(source);
    const cached = cache.get(key);
    if (cached && cached.until > now()) {
      if (cached.error) throw cached.error;
      return cached.url;
    }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 8)
      throw new Error('Player resolution capacity reached');
    const request = (async () => {
      try {
        if (rtsp) {
          const id = page.pathname.split('/')[2];
          const readJson = async (url, headers = {}) =>
            JSON.parse(
              (
                await fetchHlsBytes(url, {
                  fetchImpl,
                  maxBytes: 64 * 1024,
                  timeoutMs: 10000,
                  headers,
                })
              ).toString('utf8'),
            );
          const session = await readJson(
            `${page.origin}/api/embed/${id}/token/`,
            {
              Origin: page.origin,
              Referer: page.href,
            },
          );
          // Respect all operator access decisions. Never retry with an allowed
          // embedding domain, a password or an authenticated account.
          if (
            session.status !== 'ok' ||
            session.cam?.uniqId !== id ||
            session.cam?.domain
          )
            throw new Error('Public camera unavailable');
          const upstream = new URL(session.url);
          if (
            !['https://ms.rtsp.me', 'https://sp.rtsp.me'].includes(
              upstream.origin,
            ) ||
            upstream.username ||
            upstream.password ||
            upstream.pathname !== '/' ||
            upstream.search ||
            upstream.hash ||
            typeof session.token !== 'string' ||
            session.token.length > 4096
          )
            throw new Error('Unsupported public media server');
          const info = await readJson(
            `${upstream.origin}/token/${encodeURIComponent(session.token)}`,
          );
          const target = new URL(info.hls);
          if (
            target.origin !== upstream.origin ||
            target.username ||
            target.password ||
            target.hash ||
            !target.pathname.endsWith(`/hls/${id}.m3u8`)
          )
            throw new Error('Unsupported public HLS target');
          remember(key, { url: target.href, until: now() + 60000 });
          return target.href;
        }
        if (ivideon) {
          const requestUrl = new URL(page.href);
          // Public API options used by the operator's own HLS player: shorter
          // initial segments avoid timing out a cold live session.
          requestUrl.searchParams.set('wait_segments', '2');
          requestUrl.searchParams.set('segment_duration', '2');
          const response = await fetchImpl(requestUrl.href, {
            redirect: 'manual',
            signal: AbortSignal.timeout(10000),
          });
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (response.status !== 302 || !location)
            throw new Error('Public camera has no live HLS stream');
          const target = new URL(location);
          const identity = page.pathname.split('/')[2];
          const [server, camera] = identity.split(':');
          if (
            target.protocol !== 'https:' ||
            !/^[a-z]{2}\d+\.extcam\.com$/.test(target.hostname) ||
            target.port ||
            target.username ||
            target.password ||
            target.hash ||
            target.pathname !== '/hls/live' ||
            target.searchParams.get('server') !== server ||
            target.searchParams.get('camera') !== camera ||
            target.searchParams.get('access_token') !== 'public'
          )
            throw new Error('Unsupported public HLS redirect');
          remember(key, { url: target.href, until: now() + 60000 });
          return target.href;
        }
        const html = (
          await fetchHlsBytes(page.href, {
            fetchImpl,
            maxBytes: 256 * 1024,
            timeoutMs: 10000,
          })
        )
          .toString('utf8')
          .replace(/\\\//g, '/')
          .replace(/\\"/g, '"');
        // Parse quoted literals only; never evaluate provider JavaScript.
        for (const match of html.matchAll(
          /["']((?:https?:)?\/\/[^"'<>\s]+\.m3u8(?:\?[^"'<>\s]*)?)["']/g,
        )) {
          const candidate = new URL(match[1].replace(/&amp;/g, '&'), page);
          if (
            candidate.origin !== media.origin ||
            candidate.pathname !== media.pathname ||
            candidate.username ||
            candidate.password ||
            candidate.hash
          )
            continue;
          remember(key, { url: candidate.href, until: now() + 5 * 60 * 1000 });
          return candidate.href;
        }
        throw new Error('No matching HLS URL on public player');
      } catch (error) {
        remember(key, { error, until: now() + 30000 });
        throw error;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, request);
    return request;
  };
  return {
    resolve,
    invalidate(source) {
      const key = keyFor(source);
      // Keep the failure backoff so repeated viewers cannot flood the operator.
      if (!cache.get(key)?.error) cache.delete(key);
    },
  };
}
