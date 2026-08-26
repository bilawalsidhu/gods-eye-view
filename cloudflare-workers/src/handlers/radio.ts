/**
 * Radio Browser API proxy.
 * Docs: https://api.radio-browser.info/
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 60_000; // 1-minute cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

const RADIO_MIRRORS = [
	'https://de1.api.radio-browser.info',
	'https://de2.api.radio-browser.info',
	'https://nl1.api.radio-browser.info',
];

const RADIO_PATH_MAP: Record<string, string> = {
	'stations/by-country': '/json/stations/bycountry',
	'stations/by-tag': '/json/stations/bytag',
	'servers': '/json/servers',
	'search': '/json/stations/byname',
};

export async function handleRadio(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace(/^\/radio/, '').replace(/^\//, '') || 'servers';
	const query = url.search.slice(1); // pass through query params

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	// Validate path
	const basePath = Object.keys(RADIO_PATH_MAP).find((k) => path.startsWith(k)) ?? 'servers';
	const apiPath = RADIO_PATH_MAP[basePath] ?? '/json/servers';

	const cacheKey = `radio:${apiPath}:${query}`;
	const cached = cache.get(cacheKey) as unknown[] | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	const mirror = RADIO_MIRRORS[Math.floor(Math.random() * RADIO_MIRRORS.length)];
	const apiUrl = `${mirror}${apiPath}${query ? `?${query}` : ''}`;

	try {
		const res = await fetch(apiUrl, {
			signal: AbortSignal.timeout(15_000),
			headers: { 'User-Agent': 'gods-eye-view/1.0' },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json() as unknown[];

		cache.set(cacheKey, data, CACHE_TTL_MS);
		return Response.json(data, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[radio] fetch failed:', err);
		return errorResponse('Radio Browser upstream unavailable', 502);
	}
}
