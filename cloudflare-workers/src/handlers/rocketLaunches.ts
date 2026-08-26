/**
 * Rocket launches proxy for Launch Library 2.
 * Docs: https://launchlibrary.net/docs
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 5 * 60_000; // 5-minute cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleRocketLaunches(request: Request, env: Env): Promise<Response> {
	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const cached = cache.get('rocket-launches') as { launches: unknown[] } | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	const token = env.LAUNCH_LIBRARY_2_TOKEN;
	const headers: Record<string, string> = {
		'User-Agent': 'gods-eye-view/1.0',
	};
	if (token) headers['Authorization'] = `Token ${token}`;

	try {
		const url = new URL('https://ll.thespacedevs.com/2.2.0/launch/upcoming/');
		url.searchParams.set('limit', '20');
		url.searchParams.set('mode', 'detailed');

		const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json() as { results: unknown[] };

		const payload = { launches: data.results ?? [] };
		cache.set('rocket-launches', payload, CACHE_TTL_MS);

		return Response.json(payload, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[rocket-launches] fetch failed:', err);
		return errorResponse('Rocket launches upstream unavailable', 502);
	}
}
