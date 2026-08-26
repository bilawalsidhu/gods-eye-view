/**
 * GBFS (General Bikeshare Feed Specification) proxy.
 * Aggregates bikeshare station status from multiple cities.
 * Docs: https://github.com/MobilityData/gbfs
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 60_000; // 1-minute cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

interface GbfsFeed {
	system_id: string;
	name: string;
	stations: unknown[];
}

const KNOWN_GBFS_SYSTEMS: Record<string, string> = {
	'nyc': 'https://gbfs.lyft.com/bikenyc/stations_information.json',
	'sf': 'https://s3.amazonaws.com/ridership.io/sf-gbfs/member-id-data.json',
	'chicago': 'https://gbfs.divvybikes.com/gbfs/gbfs.json',
	'austin': 'https://data.makeaitx.io/mobility/ausbike/gbfs.json',
	'miami': 'https://www.miamidade.gov/ai/gbfs/miami/gbfs.json',
};

export async function handleGbfs(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const city = url.searchParams.get('city') ?? 'nyc';

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const cacheKey = `gbfs:${city}`;
	const cached = cache.get(cacheKey) as GbfsFeed | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	const feedUrl = KNOWN_GBFS_SYSTEMS[city.toLowerCase()];
	if (!feedUrl) {
		return errorResponse(`Unknown GBFS city: ${city}. Known: ${Object.keys(KNOWN_GBFS_SYSTEMS).join(', ')}`, 400);
	}

	try {
		// Fetch the GBFS discovery file first
		const discoveryRes = await fetch(feedUrl, { signal: AbortSignal.timeout(10_000) });
		if (!discoveryRes.ok) throw new Error(`HTTP ${discoveryRes.status}`);

		const discovery = await discoveryRes.json() as { data?: { en?: { feeds?: { name: string; url: string }[] } } };

		// Find the stations information feed
		const feeds = discovery?.data?.en?.feeds ?? [];
		const stationFeed = feeds.find((f: { name: string }) => f.name === 'station_information');
		const statusFeed = feeds.find((f: { name: string }) => f.name === 'station_status');

		if (!stationFeed?.url) {
			return errorResponse('Station information feed not found in GBFS', 502);
		}

		// Fetch both in parallel
		const [infoRes, statusRes] = await Promise.all([
			fetch(stationFeed.url, { signal: AbortSignal.timeout(10_000) }),
			statusFeed?.url
				? fetch(statusFeed.url, { signal: AbortSignal.timeout(10_000) })
				: Promise.resolve(null),
		]);

		if (!infoRes.ok) throw new Error(`Station info HTTP ${infoRes.status}`);
		const infoData = await infoRes.json() as { stations?: unknown[] };

		let statusData: { stations?: unknown[] } = {};
		if (statusRes?.ok) {
			statusData = await statusRes.json() as { stations?: unknown[] };
		}

		// Merge station info with status
		type Station = { station_id: string; [key: string]: unknown };
		const statusStations = (statusData.stations ?? []) as Station[];
		const stations = ((infoData.stations ?? []) as Station[]).map((station) => {
			const s = statusStations.find((st) => st.station_id === station.station_id);
			return { ...station, ...s };
		});

		const payload: GbfsFeed = {
			system_id: city,
			name: city,
			stations,
		};
		cache.set(cacheKey, payload, CACHE_TTL_MS);

		return Response.json(payload, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[gbfs] fetch failed:', err);
		return errorResponse('GBFS upstream unavailable', 502);
	}
}
