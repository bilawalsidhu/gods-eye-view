/**
 * Military installations proxy via Overpass API.
 * Queries OSM for military landuse and facilities within a bounding box.
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter, parseBbox } from '../lib/shared.js';

const CACHE_TTL_MS = 30 * 24 * 3600_000; // 30-day cache (military data changes rarely)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleMilitaryInstallations(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	const bboxStr = url.searchParams.get('bbox');
	const bbox = parseBbox(bboxStr);
	if (!bbox) {
		return errorResponse('Invalid or missing bbox parameter (south,west,north,east)', 400);
	}

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const cacheKey = `military:${bboxStr}`;
	const cached = cache.get(cacheKey) as { features: unknown[] } | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	const [south, west, north, east] = bbox;
	const overpassQuery = `[out:json][timeout:20];(nwr["military"~"^(airfield|naval_base|range|barracks|base)$"](${south},${west},${north},${east});nwr["landuse"="military"](${south},${west},${north},${east}););out center tags geom 100;`;

	const mirror = 'https://overpass-api.de/api/interpreter';
	try {
		const res = await fetch(mirror, {
			method: 'POST',
			body: `data=${encodeURIComponent(overpassQuery)}`,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json() as { elements?: unknown[] };

		type OsmElement = { id: number; type: string; tags: Record<string, string>; center?: { lat: number; lon: number } };
		const features = ((data.elements ?? []) as OsmElement[]).map((el) => ({
			id: el.id,
			type: el.type,
			tags: el.tags,
			center: el.center,
		}));

		const payload = { features, count: features.length };
		cache.set(cacheKey, payload, CACHE_TTL_MS);

		return Response.json(payload, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[military-installations] fetch failed:', err);
		return errorResponse('Military installations upstream unavailable', 502);
	}
}
