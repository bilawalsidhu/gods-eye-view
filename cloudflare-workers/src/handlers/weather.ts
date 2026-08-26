/**
 * Weather proxy — Open-Meteo API (free, no key required).
 * Docs: https://open-meteo.com/en/docs
 */
import type { Env } from '../lib/shared.js';
import { MemoryCache, errorResponse, RateLimiter } from '../lib/shared.js';

const CACHE_TTL_MS = 10 * 60_000; // 10-minute cache
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const cache = new MemoryCache<unknown>();
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleWeather(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	const lat = parseFloat(url.searchParams.get('lat') ?? '');
	const lon = parseFloat(url.searchParams.get('lon') ?? '');

	if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		return errorResponse('Invalid lat/lon parameters', 400);
	}

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	const cacheKey = `weather:${lat.toFixed(3)},${lon.toFixed(3)}`;
	const cached = cache.get(cacheKey) as { current: unknown } | null;
	if (cached) {
		return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });
	}

	const apiUrl = new URL('https://api.open-meteo.com/v1/forecast');
	apiUrl.searchParams.set('latitude', String(lat));
	apiUrl.searchParams.set('longitude', String(lon));
	apiUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility');
	apiUrl.searchParams.set('timezone', 'auto');

	try {
		const res = await fetch(apiUrl.toString(), { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json() as unknown;

		cache.set(cacheKey, data, CACHE_TTL_MS);
		return Response.json(data, { headers: { 'X-Cache': 'MISS' } });
	} catch (err) {
		console.error('[weather] fetch failed:', err);
		return errorResponse('Weather upstream unavailable', 502);
	}
}
