/**
 * TomTom traffic flow proxy.
 * Docs: https://developer.tomtom.com/traffic-api/documentation/traffic-flow-api/6.x
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 60_000; // 1-minute cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleTomTom(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (!env.TOMTOM_API_KEY) {
		return errorResponse('TOMTOM_API_KEY not configured', 500);
	}

	const zoom = parseInt(url.searchParams.get('zoom') ?? '14', 10);
	const lat = parseFloat(url.searchParams.get('lat') ?? '');
	const lon = parseFloat(url.searchParams.get('lon') ?? '');

	if (isNaN(lat) || isNaN(lon)) {
		return errorResponse('lat and lon are required', 400);
	}

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	// TomTom bounding box: lat,lon at zoom level
	const halfLat = 180 / Math.pow(2, zoom) / 2;
	const halfLon = 360 / Math.pow(2, zoom) / 2;
	const bbox = `${(lat - halfLat).toFixed(6)},${(lon - halfLon).toFixed(6)},${(lat + halfLat).toFixed(6)},${(lon + halfLon).toFixed(6)}`;

	const cacheKey = `tomtom:${zoom}:${bbox}`;
	const cached = cache.get(cacheKey) as unknown | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	const apiUrl = new URL('https://api.tomtom.com/traffic/services/flowsegmentdata');
	apiUrl.searchParams.set('key', env.TOMTOM_API_KEY);
	apiUrl.searchParams.set('bbox', bbox);
	apiUrl.searchParams.set('zoom', String(zoom));
	apiUrl.searchParams.set('format', 'json');

	try {
		const res = await fetch(apiUrl.toString(), { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json() as unknown;

		cache.set(cacheKey, data, CACHE_TTL_MS);
		return Response.json(data, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[tomtom] fetch failed:', err);
		return errorResponse('TomTom upstream unavailable', 502);
	}
}
