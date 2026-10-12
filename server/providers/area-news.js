import { newsRequest, normalizeNews } from '../../src/analysis/areaNews.js';
import { readCappedResponseText } from './common/http.js';
import { sameSiteGated } from './common/same-site.js';

/** Explicit user searches only; fixed public endpoint, no keys or article scraping. */
export function createAreaNewsHandler({
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
} = {}) {
  let nextRequestAt = 0;
  return async (req, res) => {
    const reply = (status, value) => {
      if (res.destroyed) return;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST') {
      req.resume?.();
      return reply(405, { error: 'Use explicit Search news.' });
    }
    if (now() < nextRequestAt) {
      req.resume?.();
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((nextRequestAt - now()) / 1000),
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return reply(429, {
        error: `Wait ${retryAfterSeconds} seconds before another search. No automatic retry.`,
        retryAfterSeconds,
      });
    }
    let validated = false;
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 25000);
    const cancel = () => {
      if (!res.writableEnded) abort.abort();
    };
    req.on('aborted', cancel);
    res.on('close', cancel);
    try {
      if (
        !String(req.headers['content-type'] || '').startsWith(
          'application/json',
        )
      )
        return reply(415, { error: 'JSON required.' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192)
          return reply(413, { error: 'Search input too large.' });
        chunks.push(chunk);
      }
      const request = newsRequest(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        now(),
      );
      validated = true;
      const stamp = (value) => value.replace(/[-:TZ.]/g, '').slice(0, 14);
      const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      url.search = new URLSearchParams({
        query: request.query,
        mode: 'artlist',
        format: 'json',
        maxrecords: '25',
        sort: 'datedesc',
        startdatetime: stamp(request.start),
        enddatetime: stamp(request.end),
      }).toString();
      // Only text and UTC dates leave the PC. The selected rectangle stays local.
      nextRequestAt = now() + 6000;
      const upstream = await fetchImpl(url.href, {
        signal: abort.signal,
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      const body = await readCappedResponseText(upstream, 1024 * 1024);
      if (upstream.status === 429) {
        const raw = upstream.headers.get('retry-after'),
          number = Number(raw);
        const seconds =
          raw && Number.isFinite(number)
            ? number
            : raw && Number.isFinite(Date.parse(raw))
              ? (Date.parse(raw) - now()) / 1000
              : 60;
        const retryAfterSeconds = Math.min(
          86400,
          Math.max(6, Math.ceil(seconds)),
        );
        nextRequestAt = now() + retryAfterSeconds * 1000;
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return reply(429, {
          error: `GDELT rate limit reached. Wait at least ${retryAfterSeconds} seconds, then search again. No automatic retry.`,
          retryAfterSeconds,
          upstreamStatus: 429,
        });
      }
      if (!upstream.ok || body.tooLarge)
        return reply(upstream.status === 429 ? 429 : 502, {
          error:
            upstream.status === 429
              ? 'GDELT rate limit reached. Wait and search again; no automatic retry.'
              : 'GDELT is unavailable. No fresh results were returned.',
          upstreamStatus: upstream.status,
        });
      let payload;
      try {
        payload = JSON.parse(body.text);
      } catch {
        return reply(502, {
          error:
            'GDELT returned an unexpected response. No verified empty result.',
        });
      }
      const articles = normalizeNews(payload, request);
      return reply(200, {
        articles,
        request,
        queriedAt: new Date(now()).toISOString(),
        source: 'GDELT DOC2',
        geography:
          'Text matches a place name. This is not verified spatial filtering. The rectangle is area-of-interest context only; no article or event pins are drawn.',
        dateBasis:
          'GDELT seen/indexed time; publisher publication date is not independently verified.',
        limited: payload.articles.length >= 25,
      });
    } catch (error) {
      return reply(abort.signal.aborted ? 504 : validated ? 502 : 400, {
        error: abort.signal.aborted
          ? 'News search timed out or was canceled. No fresh results.'
          : validated
            ? 'News provider returned an unavailable or unsupported response. No fresh results.'
            : error.message || 'News search failed.',
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  };
}
export function areaNewsProxy() {
  const handler = sameSiteGated(createAreaNewsHandler());
  const install = (server) => {
    server.middlewares.use('/api/area-news', handler);
  };
  return {
    name: 'area-news',
    configureServer: install,
    configurePreviewServer: install,
  };
}
