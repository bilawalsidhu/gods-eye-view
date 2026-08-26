/**
 * OpenSky aircraft state vectors proxy.
 * Fetches from OpenSky's REST API and caches responses.
 * Docs: https://openskynetwork.github.io/opensky-api/rest-api.html
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, fetchJson, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 30_000; // 30-second cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleOpenSky(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	// Optional bbox filter: lamax,lamin,lomin,romax
	const bbox = url.searchParams.get('bbox');

	// Client identity for rate limiting
	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const cacheKey = `opensky:${bbox ?? 'all'}`;
	const cached = cache.get(cacheKey) as { states: unknown[]; time: number } | null;
	if (cached) {
		return Response.json(cached, {
			headers: {
				'X-Cache': 'HIT',
				'Cache-Control': 'private, max-age=30',
			},
		});
	}

	// Build OpenSky API URL
	const apiUrl = new URL('https://opensky-network.org/api/states/all');
	if (bbox) {
		const [lamax, lamin, lomin, romax] = bbox.split(',');
		apiUrl.searchParams.set('lamax', lamax);
		apiUrl.searchParams.set('lamin', lamin);
		apiUrl.searchParams.set('lomin', lomin);
		apiUrl.searchParams.set('romax', romax);
	}

	const fetchOptions: RequestInit = {
		headers: {
			'User-Agent': 'gods-eye-view/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
		},
	};

	// Add auth if credentials are configured
	if (env.OPENSKY_USERNAME && env.OPENSKY_PASSWORD) {
		const credentials = btoa(`${env.OPENSKY_USERNAME}:${env.OPENSKY_PASSWORD}`);
		fetchOptions.headers = {
			...fetchOptions.headers,
			'Authorization': `Basic ${credentials}`,
		};
	}

	let data: { states?: unknown[]; time?: number };
	try {
		data = await fetchJson(apiUrl.toString(), { ...fetchOptions, timeoutMs: 15_000 });
	} catch (err) {
		console.error('[opensky] fetch failed:', err);
		return errorResponse('OpenSky upstream unavailable', 502);
	}

	if (!data?.states) {
		return errorResponse('Invalid OpenSky response', 502);
	}

	const payload = { states: data.states, time: data.time ?? Date.now() };
	cache.set(cacheKey, payload, CACHE_TTL_MS);

	return Response.json(payload, {
		headers: {
			'X-Cache': 'MISS',
			'Cache-Control': 'public, max-age=30',
		},
	});
}
