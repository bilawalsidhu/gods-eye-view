/**
 * CCTV camera proxy — aggregates public traffic camera streams.
 * Cities: Austin TX, Caltrans (CA), TfL (London).
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 5 * 60_000; // 5-minute cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

// CCTV sources by region
const CCTV_SOURCES: Record<string, string> = {
	'austin': 'https://data.austintexas.gov/resource/qum2-6g7y.json?$limit=100',
	'caltrans': 'https://pfae.dot.ca.gov/api/cctv',
	'london': 'https://api.tfl.gov.uk/Place/Search?type=Camera',
};

export async function handleCctv(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const region = url.searchParams.get('region') ?? 'austin';

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const cacheKey = `cctv:${region}`;
	const cached = cache.get(cacheKey) as { cameras: unknown[] } | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	const sourceUrl = CCTV_SOURCES[region.toLowerCase()];
	if (!sourceUrl) {
		return errorResponse(`Unknown region: ${region}. Known: ${Object.keys(CCTV_SOURCES).join(', ')}`, 400);
	}

	try {
		const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json() as unknown[];

		// Normalize different camera API formats to a common shape
		const cameras = normalizeCameras(region, data);
		const payload = { cameras, count: cameras.length, region };

		cache.set(cacheKey, payload, CACHE_TTL_MS);
		return Response.json(payload, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[cctv] fetch failed:', err);
		return errorResponse('CCTV upstream unavailable', 502);
	}
}

function normalizeCameras(region: string, data: unknown[]): unknown[] {
	switch (region) {
		case 'austin':
			return (data as { location?: { latitude?: number; longitude?: number }; camera_id?: string; image_url?: string }[]).map((cam) => ({
				id: cam.camera_id,
				lat: cam.location?.latitude,
				lon: cam.location?.longitude,
				streamUrl: cam.image_url,
				region: 'austin',
			}));
		case 'caltrans':
			return (data as { ID?: string; Lat?: number; Lon?: number; URL?: string }[]).map((cam) => ({
				id: cam.ID,
				lat: cam.Lat,
				lon: cam.Lon,
				streamUrl: cam.URL,
				region: 'caltrans',
			}));
		case 'london':
			return (data as { id?: string; lat?: number; lon?: number; url?: string }[]).map((cam) => ({
				id: cam.id,
				lat: cam.lat,
				lon: cam.lon,
				streamUrl: cam.url,
				region: 'london',
			}));
		default:
			return data as unknown[];
	}
}
