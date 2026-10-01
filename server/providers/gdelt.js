import path from 'node:path';
import { promises as fsp } from 'node:fs';

const TTL_MS = 15 * 60_000; // 15-minute cache
const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
const CACHE_PATH = path.join(CACHE_DIR, 'gdelt.json');

function decodeXml(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGoogleRss(xml) {
  const articles = [];
  for (const match of String(xml || '').matchAll(
    /<item>([\s\S]*?)<\/item>/gi,
  )) {
    const item = match[1];
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(item);
    const linkMatch = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(item);
    const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(item);
    const dateMatch = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(item);

    const title = decodeXml(titleMatch?.[1] || '');
    const url = decodeXml(linkMatch?.[1] || '');
    const domain = decodeXml(sourceMatch?.[1] || 'Google News');
    const seendate = dateMatch?.[1]
      ? new Date(dateMatch[1]).toISOString()
      : new Date().toISOString();

    if (title && url) {
      articles.push({ title, url, domain, seendate, sourcecountry: '' });
    }
  }
  return articles;
}

/**
 * GDELT 15-minute server cache proxy with memory + disk persistence.
 * Falls back to Google News World RSS if GDELT 429s on first launch.
 */
export function gdeltProxy() {
  let mem = null;
  let diskChecked = false;
  let inflight = null;

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.articles) &&
        parsed.articles.length
      ) {
        mem = parsed;
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[gdelt-proxy] cache write failed:', err?.message || err);
    }
  }

  async function fetchUpstream() {
    // 1. Try GDELT DOC API
    const params = new URLSearchParams({
      query: 'crisis OR conflict OR military OR summit OR diplomacy OR protest',
      mode: 'artlist',
      format: 'json',
      maxrecords: '75',
      sort: 'datedesc',
      timespan: '24h',
    });

    try {
      const res = await fetch(
        `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
        {
          headers: { 'User-Agent': 'GodsEyeView/0.1' },
          signal: AbortSignal.timeout(12_000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const articles = Array.isArray(data?.articles) ? data.articles : [];
        if (articles.length)
          return { at: Date.now(), articles, source: 'GDELT' };
      }
    } catch (err) {
      console.warn('[gdelt-proxy] GDELT API notice:', err?.message || err);
    }

    // 2. Fallback to Google News World RSS if GDELT rate-limits on empty cache
    console.log('[gdelt-proxy] falling back to World News RSS index...');
    const rssRes = await fetch(
      'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!rssRes.ok) throw new Error(`RSS HTTP ${rssRes.status}`);
    const xml = await rssRes.text();
    const articles = parseGoogleRss(xml);
    return { at: Date.now(), articles, source: 'Google News RSS' };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/gdelt', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        });
        res.end(JSON.stringify(obj));
      };

      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'Method Not Allowed' });
          return;
        }

        await readDiskOnce();
        const now = Date.now();
        const entry = mem;

        if (entry && now - entry.at < TTL_MS && entry.articles.length) {
          sendJson(200, {
            fetchedAt: entry.at,
            stale: false,
            status: 'ready',
            count: entry.articles.length,
            articles: entry.articles,
          });
          return;
        }

        if (!inflight) {
          inflight = fetchUpstream()
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[gdelt-proxy] fetch notice (${err?.message || err})`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }

        const fresh = await inflight;
        if (fresh && fresh.articles.length) {
          sendJson(200, {
            fetchedAt: fresh.at,
            stale: false,
            status: 'ready',
            count: fresh.articles.length,
            articles: fresh.articles,
          });
        } else if (entry && entry.articles.length) {
          sendJson(200, {
            fetchedAt: entry.at,
            stale: true,
            status: 'rate-limited',
            count: entry.articles.length,
            articles: entry.articles,
          });
        } else {
          sendJson(200, {
            status: 'empty',
            articles: [],
          });
        }
      } catch (err) {
        console.warn('[gdelt-proxy] error:', err?.message || err);
        sendJson(500, { error: 'gdelt proxy error' });
      }
    });
  };

  return {
    name: 'gdelt-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
