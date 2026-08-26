/**
 * Overpass API proxy for OpenStreetMap data.
 * Docs: https://wiki.openstreetmap.org/wiki/Overpass_API
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 24 * 3600_000; // 24-hour cache for OSM data
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

// Use Cloudflare Durable Objects for shared state if available
const OVERPASS_MIRRORS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.kumi.systems/api/interpreter',
	'https://lz4.overpass-api.de/api/interpreter',
];
let mirrorIndex = 0;

export async function handleOverpass(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (request.method !== 'POST') {
		return errorResponse('Only POST is supported', 405);
	}

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	let body: string;
	try {
		body = await request.text();
	} catch {
		return errorResponse('Invalid request body', 400);
	}

	// Basic Overpass QL validation — just check it starts with expected patterns
	const trimmed = body.trim();
	if (!/^\[\s*out:/i.test(trimmed) && !/^<[\w\s="]+overpass/i.test(trimmed)) {
		return errorResponse('Invalid Overpass QL or XML query', 400);
	}

	// Don't cache obviously dynamic queries (e.g. [date:"..."])
	const cacheKey = trimmed.includes('[date:') || trimmed.includes('now()')
		? `overpass:dynamic:${trimmed.slice(0, 64)}`
		: `overpass:${trimmed.slice(0, 128)}`;

	const cached = cache.get(cacheKey) as { data: unknown } | null;
	if (cached) {
		return Response.json(cached.data, { headers: { 'X-Cache': 'HIT' } });
	}

	// Rotate through mirrors
	const mirror = OVERPASS_MIRRORS[mirrorIndex % OVERPASS_MIRRORS.length];
	mirrorIndex++;

	try {
		const res = await fetch(mirror, {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`Overpass ${res.status}: ${text.slice(0, 200)}`);
		}
		const data = await res.json() as unknown;
		cache.set(cacheKey, { data }, CACHE_TTL_MS);
		return Response.json(data, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[overpass] fetch failed:', err);
		return errorResponse('Overpass API unavailable', 502);
	}
}
