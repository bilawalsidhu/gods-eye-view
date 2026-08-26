/**
 * NASA FIRMS fire detection proxy.
 * Fetches FIRMS CSV data and returns normalized JSON.
 * Docs: https://firms.modaps.eosdis.nasa.gov/api/
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter, parseBbox } from '../lib/shared.js';

const CACHE_TTL_MS = 15 * 60_000; // 15-minute cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleFirms(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	const bboxStr = url.searchParams.get('bbox');
	const source = url.searchParams.get('source') ?? 'VIIRS_SNPP_NRT';
	const days = parseInt(url.searchParams.get('days') ?? '1', 10);

	const bbox = parseBbox(bboxStr);
	if (!bbox) {
		return errorResponse('Invalid or missing bbox parameter (south,west,north,east)', 400);
	}

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const bboxQuery = bbox.join(',');
	const cacheKey = `firms:${source}:${days}:${bboxQuery}`;
	const cached = cache.get(cacheKey) as { fires: unknown[] } | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	if (!env.NASA_FIRMS_API_KEY) {
		return errorResponse('NASA_FIRMS_API_KEY not configured', 500);
	}

	const apiUrl = new URL(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.NASA_FIRMS_API_KEY}/${source}/${days}`);
	apiUrl.searchParams.set('bounding_box', bboxQuery);

	try {
		const res = await fetch(apiUrl.toString(), {
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();

		// Parse CSV: latitude,longitude,bright_ti4,bright_ti5,acq_date,acq_time,satellite,instrument,confidence,frp,type
		const lines = text.trim().split('\n');
		if (lines.length < 2) {
			return Response.json({ fires: [] });
		}

		const header = lines[0].split(',');
		const latIdx = header.indexOf('latitude');
		const lonIdx = header.indexOf('longitude');
		const frpIdx = header.indexOf('frp');
		const dateIdx = header.indexOf('acq_date');
		const timeIdx = header.indexOf('acq_time');
		const confIdx = header.indexOf('confidence');

		const fires = lines.slice(1).map((line) => {
			const cols = line.split(',');
			return {
				lat: parseFloat(cols[latIdx]),
				lon: parseFloat(cols[lonIdx]),
				frp: parseFloat(cols[frpIdx]),
				date: cols[dateIdx],
				time: cols[timeIdx],
				confidence: cols[confIdx],
			};
		}).filter((f) => !isNaN(f.lat) && !isNaN(f.lon));

		const payload = { fires, count: fires.length, source };
		cache.set(cacheKey, payload, CACHE_TTL_MS);

		return Response.json(payload, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[firms] fetch failed:', err);
		return errorResponse('FIRMS upstream unavailable', 502);
	}
}
