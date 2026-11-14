import { test } from 'node:test';
import assert from 'node:assert/strict';
import createViteConfig, {
  adsbLolFallbackAnchor,
  coalesceProxyRequest,
  launchLibraryRequestHeaders,
  keylessGooglePlacesResponse,
  LL2_CACHE_TTL_MS,
  readResponseJsonCapped,
  regionalBriefHasAnySource,
  validMilitaryInstallationBox,
  validRegionalPoint,
} from '../../vite.config.js';
import { fetchRegionalNews } from '../../server/providers/regional/news.js';

test('missing Google place context is a quiet keyless capability, not a 503', () => {
  assert.deepEqual(keylessGooglePlacesResponse(undefined), {
    statusCode: 200,
    payload: { configured: false, error: null, places: [] },
  });
  assert.deepEqual(keylessGooglePlacesResponse('   '), {
    statusCode: 200,
    payload: { configured: false, error: null, places: [] },
  });
  assert.equal(keylessGooglePlacesResponse('configured-key'), null);
});

test('regional proxy rejects absent and blank coordinates instead of coercing them to zero', () => {
  assert.equal(validRegionalPoint(new URLSearchParams('longitude=12.5')), null);
  assert.equal(validRegionalPoint(new URLSearchParams('latitude=12.5')), null);
  assert.equal(validRegionalPoint(new URLSearchParams('latitude=&longitude=12.5')), null);
  assert.deepEqual(
    validRegionalPoint(new URLSearchParams('latitude=0&longitude=0')),
    { latitude: 0, longitude: 0 },
  );
});

test('adjacent proxy validators also require every coordinate explicitly', () => {
  assert.equal(
    validMilitaryInstallationBox(new URLSearchParams('west=-1&north=1&east=1')),
    null,
  );
  assert.equal(adsbLolFallbackAnchor({ url: '?lat=12.5' }), null);
  assert.equal(adsbLolFallbackAnchor({ url: '?lon=12.5' }), null);
});

test('new data proxies install the same routes in dev and preview servers', () => {
  const config = createViteConfig({ mode: 'test' });
  const byName = new Map(config.plugins.map((plugin) => [plugin.name, plugin]));
  for (const name of [
    'rocket-launches-proxy',
    'military-installations-proxy',
    'regional-brief-proxy',
    'weather-effects-proxy',
  ]) {
    assert.equal(typeof byName.get(name)?.configureServer, 'function', `${name} dev hook`);
    assert.equal(typeof byName.get(name)?.configurePreviewServer, 'function', `${name} preview hook`);
  }
});

test('Launch Library uses a 15-minute cache and optional server-side token header', () => {
  assert.equal(LL2_CACHE_TTL_MS, 15 * 60_000);
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'gods-eye-view-launch-library-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
  };
  assert.deepEqual(launchLibraryRequestHeaders(''), headers);
  assert.deepEqual(launchLibraryRequestHeaders(' secret '), {
    ...headers,
    Authorization: 'Token secret',
  });
});

test('proxy request coalescing shares one per-key refresh and clears it after settlement', async () => {
  const inFlight = new Map();
  let refreshCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = coalesceProxyRequest(inFlight, 'cell', async () => {
    refreshCount += 1;
    await gate;
    return 'fresh';
  });
  const second = coalesceProxyRequest(inFlight, 'cell', () => {
    refreshCount += 1;
    return 'duplicate';
  });
  assert.equal(first.shared, false);
  assert.equal(second.shared, true);
  assert.equal(first.promise, second.promise);
  release();
  assert.equal(await second.promise, 'fresh');
  assert.equal(refreshCount, 1);
  assert.equal(inFlight.size, 0);
});

test('bounded JSON reader rejects oversized upstream bodies', async () => {
  assert.deepEqual(await readResponseJsonCapped(new Response('{"ok":true}'), 32), { ok: true });
  await assert.rejects(
    readResponseJsonCapped(new Response(JSON.stringify({ value: 'x'.repeat(64) })), 32),
    (error) => error?.code === 'RESPONSE_TOO_LARGE',
  );
});

test('regional brief treats an all-source outage as total failure', () => {
  assert.equal(regionalBriefHasAnySource({
    place: null,
    weather: null,
    news: { status: 'unavailable' },
  }), false);
  assert.equal(regionalBriefHasAnySource({
    place: { country: 'United States' },
    weather: null,
    news: { status: 'unavailable' },
  }), true);
});

test('local regional news asks for the last day, drops old and undated items, newest first', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const urls = [];
  let rss;
  let gdelt;
  globalThis.fetch = async (url) => {
    urls.push(new URL(String(url)));
    const answer = String(url).includes('news.google') ? rss : gdelt;
    return typeof answer === 'function' ? answer() : answer.clone();
  };
  const at = (hours) => new Date(Date.now() - hours * 3_600_000).toUTCString();
  const item = (title, date) =>
    `<item><title>${title}</title><link>https://news.example/${title}</link>${date ? `<pubDate>${date}</pubDate>` : ''}</item>`;
  rss = new Response(`<rss><channel>${[
    item('old', at(4 * 24)),
    item('undated', null),
    item('day', at(20)),
    item('hour', at(1)),
  ].join('')}</channel></rss>`);
  const place = { locality: 'Austin' };
  const ready = await fetchRegionalNews(place);
  assert.equal(urls[0].searchParams.get('q'), 'Austin when:1d');
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.articles.map((row) => row.title), ['hour', 'day']);

  // Nothing recent in RSS: GDELT is asked for the same 24 h window.
  rss = new Response(`<rss><channel>${item('old', at(30))}</channel></rss>`);
  gdelt = Response.json({ articles: [] });
  urls.length = 0;
  const empty = await fetchRegionalNews(place);
  assert.equal(urls[1].searchParams.get('timespan'), '24h');
  assert.deepEqual(empty, { status: 'empty', query: 'Austin', articles: [], source: 'GDELT fallback' });

  // RSS answered with nothing recent and GDELT failed: still a true empty.
  rss = new Response('<rss><channel></channel></rss>');
  gdelt = () => Promise.reject(new TypeError('network'));
  assert.equal((await fetchRegionalNews(place)).status, 'empty');

  // Neither source answered, or no place: unavailable.
  rss = () => Promise.resolve(new Response('busy', { status: 503 }));
  const failed = await fetchRegionalNews(place);
  assert.equal(failed.status, 'unavailable');
  assert.deepEqual(failed.articles, []);
  assert.equal((await fetchRegionalNews(null)).status, 'unavailable');
});
