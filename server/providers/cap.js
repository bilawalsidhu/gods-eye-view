import { parseCap } from '../../src/data/cap.js';
import { readResponseTextCapped } from './common/http.js';

const e = (url, region, format, enabled = true) => ({
  url,
  region,
  format,
  enabled,
});
export const CAP_SOURCES = Object.freeze({
  inmet: e('https://apiprevmet3.inmet.gov.br/avisos/rss', 'Brazil', 'rss'),
  idap: e('https://idapfile.mi.gov.br/idap/api/rss/cap', 'Brazil', 'rss'),
  idapMdr: e(
    'https://idapfile.mdr.gov.br/idap/api/rss/cap',
    'Brazil',
    'rss',
    false,
  ),
  unb: e(
    'http://www.obsis.unb.br/integracao/public/feed/pt/rss.xml',
    'Brazil',
    'rss',
    false,
  ),
  smn: e('https://ssl.smn.gob.ar/CAP/AR.php', 'Argentina', 'cap'),
  dmc: e(
    'https://archivos.meteochile.gob.cl/portaldmc/rss/rss.php',
    'Chile',
    'rss',
  ),
  inumet: e(
    'https://www.inumet.gub.uy/reportes/riesgo/rss.xml',
    'Uruguay',
    'rss',
  ),
  inamhi: e(
    'https://cap-sources.s3.amazonaws.com/ec-inamhi-es/rss.xml',
    'Ecuador',
    'rss',
  ),
  ungrd: e(
    'https://www.gestiondelriesgo.gov.co/rss/AtomAlert.aspx',
    'Colombia',
    'atom',
  ),
  hms: e(
    'https://cap-sources.s3.amazonaws.com/gy-hms-en/rss.xml',
    'Guyana',
    'rss',
  ),
  nws: e('https://api.weather.gov/alerts/active.atom', 'US', 'atom'),
  eccc: e('https://weather.gc.ca/rss/warning/', 'Canada', 'catalog', false),
  dwd: e(
    'https://www.dwd.de/DWD/warnungen/cap-feed/en/rss.xml',
    'Germany',
    'rss',
  ),
  'met-norway': e(
    'https://api.met.no/weatherapi/metalerts/2.0/current.xml',
    'Norway',
    'cap',
  ),
  metservice: e('https://alerts.metservice.com/cap/rss', 'New Zealand', 'rss'),
  nema: e(
    'https://alerthub.civildefence.govt.nz/rss/pwp',
    'New Zealand',
    'rss',
  ),
  meteoalarm: e('https://feeds.meteoalarm.org/', 'Europe', 'catalog', false),
  ifrc: e('', 'global', 'catalog', false),
  wmo: e('', 'global', 'catalog', false),
  kde: e('', 'global', 'catalog', false),
});
export function allowedCapUrl(source, value) {
  try {
    const a = new URL(value),
      b = new URL(source.url);
    return (
      a.protocol === b.protocol &&
      a.host === b.host &&
      a.pathname.startsWith(b.pathname)
    );
  } catch {
    return false;
  }
}
export function extractCapLinks(body, source, max = 32) {
  const links = [];
  const re =
    /<(?:link|cap:resource)\b([^>]*)>([\s\S]*?)<\/(?:link|cap:resource)>|<(?:link|cap:resource)\b([^>]*)\/?>(?<!<\/)/gi;
  for (const m of body.matchAll(re)) {
    const attrs = `${m[1] || ''} ${m[3] || ''}`;
    const href = attrs.match(
      /(?:href|uri)=["']([^"']+)|(?:href|uri)\s*=\s*([^\s>]+)/i,
    );
    const value = href?.[1] || href?.[2] || m[2]?.trim();
    if (value && allowedCapUrl(source, value) && !links.includes(value))
      links.push(value);
  }
  return links.slice(0, max);
}
function optIn(sources) {
  const ids = String(process.env.CAP_OPT_IN_SOURCES || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return Object.entries(sources).filter(
    ([id, s]) => s.enabled || ids.includes(id),
  );
}
export function capProxy({
  fetchImpl = globalThis.fetch,
  sources = CAP_SOURCES,
  timeoutMs = 10000,
  maxBytes = 2 * 1024 * 1024,
  maxDocuments = 32,
  concurrency = 4,
  enabled = process.env.CAP_ENABLED !== 'false',
} = {}) {
  const handle = async (req, res, next) => {
    if (req.url !== '/api/cap' && req.url !== '/' && req.url !== '')
      return next();
    const out = [];
    if (enabled) {
      const queue = optIn(sources).slice(0, maxDocuments);
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          const [, source] = queue[cursor++];
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetchImpl(source.url, {
              redirect: 'error',
              signal: controller.signal,
              headers: {
                accept:
                  'application/xml, application/rss+xml, application/atom+xml, text/xml',
                'user-agent': `Gods-Eye-View CAP/${source.region}`,
              },
            });
            if (!response.ok) throw Error('http');
            const body = await readResponseTextCapped(
              response,
              maxBytes,
              controller.signal,
            );
            if (source.format === 'catalog') continue;
            const documents =
              source.format === 'cap'
                ? [body]
                : extractCapLinks(body, source, maxDocuments);
            for (const url of documents) {
              try {
                const xml =
                  url === body
                    ? body
                    : await fetchImpl(url, {
                        redirect: 'error',
                        signal: controller.signal,
                        headers: { accept: 'application/xml, text/xml' },
                      }).then((r) => {
                        if (!r.ok) throw Error('http');
                        return readResponseTextCapped(
                          r,
                          maxBytes,
                          controller.signal,
                        );
                      });
                out.push(
                  ...parseCap(xml).map((alert) => ({
                    ...alert,
                    source: source.url,
                    region: source.region,
                  })),
                );
              } catch {
                /* partial document failure */
              }
            }
          } catch {
            /* partial source failure */
          } finally {
            clearTimeout(timer);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, worker),
      );
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        source: 'cap',
        alerts: out,
        generatedAt: new Date().toISOString(),
      }),
    );
  };
  return {
    name: 'cap',
    configureServer({ middlewares }) {
      middlewares.use('/api/cap', handle);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/cap', handle);
    },
    handle,
  };
}
