/**
 * CelesTrak satellite TLE proxy.
 * Fetches NORAD element sets from celestrak.org and caches them.
 * Docs: https://celestrak.org/NORAD/documentation/gp-data-format.php
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 6 * 3600_000; // 6-hour cache for TLE data
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const cache = new MemoryCache<{ body: string; at: number }>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

const VALID_GROUPS = new Set([
	'stations', 'visual', 'active', ' brightest', 'iridium', 'iridium-NEXT',
	'oneweb', 'starlink', 'planet', 'swarm', 'orbcomm', 'globalstar',
	'gonets', 'sky Perfect', 'intelsat', 'ses', 'telesat', 'amazon',
	'comment', 'intelsat-35e', 'intelsat-37e', 'ses-17', 'astron',
]);

export async function handleCelestrak(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const group = url.searchParams.get('group') ?? 'stations';

	// Validate group name
	if (!/^[a-z0-9-]+$/i.test(group)) {
		return errorResponse('Invalid group parameter', 400);
	}

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const cacheKey = `celestrak:${group}`;
	const cached = cache.get(cacheKey) as { body: string; at: number } | null;
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return new Response(cached.body, {
			headers: {
				'Content-Type': 'text/plain',
				'X-Cache': 'HIT',
				'Cache-Control': 'public, max-age=21600',
			},
		});
	}

	const apiUrl = new URL('https://celstrak.org/NORAD/elements/gp.php');
	apiUrl.searchParams.set('GROUP', group);
	apiUrl.searchParams.set('FORMAT', 'tle');

	try {
		const res = await fetch(apiUrl.toString(), {
			signal: AbortSignal.timeout(20_000),
			headers: {
				'User-Agent': 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
			},
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.text();
		// CelesTrak returns an error HTML page when a group doesn't exist
		if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');

		const entry = { body, at: Date.now() };
		cache.set(cacheKey, entry, CACHE_TTL_MS);

		return new Response(body, {
			headers: {
				'Content-Type': 'text/plain',
				'X-Cache': 'MISS',
				'Cache-Control': 'public, max-age=21600',
			},
		});
	} catch (err) {
		console.error('[celestrak] fetch failed:', err);
		return errorResponse('CelesTrak upstream unavailable', 502);
	}
}
