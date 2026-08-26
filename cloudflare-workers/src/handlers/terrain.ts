/**
 * Terrain heights proxy — fetches terrain elevation from Open-Elevation API.
 * Docs: https://github.com/Jorl17/open-elevation
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 30 * 24 * 3600_000; // 30-day cache (terrain doesn't change)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleTerrain(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (request.method !== 'POST') {
		return errorResponse('Only POST is supported', 405);
	}

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return errorResponse('Invalid JSON body', 400);
	}

	if (!Array.isArray(body) || body.length === 0) {
		return errorResponse('Expected array of {lat, lon} points', 400);
	}

	// Validate points
	for (const pt of body as { lat?: number; lon?: number }[]) {
		if (typeof pt.lat !== 'number' || typeof pt.lon !== 'number') {
			return errorResponse('Invalid point format', 400);
		}
	}

	const cacheKey = `terrain:${JSON.stringify(body).slice(0, 100)}`;
	const cached = cache.get(cacheKey) as { results: { lat: number; lon: number; elevation: number }[] } | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	try {
		const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ locations: body }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json() as { results?: { lat: number; lon: number; elevation: number }[] };

		const payload = { results: data.results ?? [] };
		cache.set(cacheKey, payload, CACHE_TTL_MS);
		return Response.json(payload, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[terrain] fetch failed:', err);
		return errorResponse('Terrain API unavailable', 502);
	}
}
