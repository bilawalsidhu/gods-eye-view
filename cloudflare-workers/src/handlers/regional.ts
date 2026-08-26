/**
 * Regional briefing proxy — aggregates place search, weather, and GDELT news.
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 5 * 60_000; // 5-minute cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleRegionalBrief(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const lat = parseFloat(url.searchParams.get('lat') ?? '');
	const lon = parseFloat(url.searchParams.get('lon') ?? '');
	const query = url.searchParams.get('q') ?? '';

	if ((isNaN(lat) || isNaN(lon)) && !query) {
		return errorResponse('Either lat/lon or q (search query) is required', 400);
	}

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const cacheKey = `regional:${lat.toFixed(3)},${lon.toFixed(3)}:${query}`;
	const cached = cache.get(cacheKey) as { place: unknown; weather: unknown; news: unknown } | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	try {
		// Fetch place, weather, news in parallel
		const [placeResult, weatherResult, newsResult] = await Promise.allSettled([
			query ? fetchPlaceSearch(query) : Promise.resolve(null),
			!isNaN(lat) && !isNaN(lon) ? fetchWeather(lat, lon) : Promise.resolve(null),
			!isNaN(lat) && !isNaN(lon) ? fetchNews(lat, lon) : Promise.resolve(null),
		]);

		const place = placeResult.status === 'fulfilled' ? placeResult.value : null;
		const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
		const news = newsResult.status === 'fulfilled' ? newsResult.value : null;

		const payload = {
			place,
			weather,
			news,
			status: place && weather ? 'ready' : 'partial',
			generatedAt: Date.now(),
		};

		cache.set(cacheKey, payload, CACHE_TTL_MS);
		return Response.json(payload, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[regional] fetch failed:', err);
		return errorResponse('Regional briefing unavailable', 502);
	}
}

async function fetchPlaceSearch(query: string): Promise<unknown> {
	const url = new URL('https://nominatim.openstreetmap.org/search');
	url.searchParams.set('q', query);
	url.searchParams.set('format', 'json');
	url.searchParams.set('limit', '1');
	const res = await fetch(url.toString(), {
		signal: AbortSignal.timeout(10_000),
		headers: { 'User-Agent': 'gods-eye-view/1.0' },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json() as unknown[];
	return data[0] ?? null;
}

async function fetchWeather(lat: number, lon: number): Promise<unknown> {
	const url = new URL('https://api.open-meteo.com/v1/forecast');
	url.searchParams.set('latitude', String(lat));
	url.searchParams.set('longitude', String(lon));
	url.searchParams.set('current', 'temperature_2m,weather_code,cloud_cover,wind_speed_10m');
	url.searchParams.set('timezone', 'auto');
	const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function fetchNews(lat: number, lon: number): Promise<unknown> {
	// GDELT_doc API — free, no key required
	const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
	url.searchParams.set('format', 'json');
	url.searchParams.set('lang', 'english');
	url.searchParams.set('sort', 'DateDesc');
	url.searchParams.set('maxrows', '5');
	url.searchParams.set('mode', 'artlist');
	url.searchParams.set('d11', '1');
	// Query for area around coordinates
	url.searchParams.set('clat', String(lat));
	url.searchParams.set('clon', String(lon));
	url.searchParams.set('radius', '100');

	try {
		const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json() as unknown;
	} catch {
		// News is non-critical — return unavailable sentinel
		return { status: 'unavailable' };
	}
}
