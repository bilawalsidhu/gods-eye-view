/**
 * Lightweight analytics endpoint.
 *
 * Accepts POST events (pageview, layer_enabled, layer_disabled, error) and stores
 * aggregated counts in KV. Serves as the backend for the analytics dashboard.
 *
 * Privacy: no PII, no per-user tracking. Only counts and aggregates.
 */
import type { Env } from '../lib/shared.js';
import { errorResponse } from '../lib/shared.js';
import { kvGet, kvSet } from '../lib/cacheKv.js';

interface AnalyticsEvent {
	type: 'pageview' | 'layer_enabled' | 'layer_disabled' | 'error';
	layerId?: string;
	message?: string;
	timestamp: number;
}

interface AnalyticsBucket {
	pageviews: number;
	layers: Record<string, { enabled: number; disabled: number }>;
	errors: number;
}

const BUCKET_TTL_MS = 24 * 3600_000; // reset bucket every 24h

function todayKey(): string {
	return `analytics:${new Date().toISOString().slice(0, 10)}`; // YYYY-MM-DD
}

async function getBucket(env: Env): Promise<AnalyticsBucket> {
	const cached = await kvGet<AnalyticsBucket>(env.CACHE, todayKey(), { maxAge: BUCKET_TTL_MS });
	if (cached.ok) return cached.data;
	return { pageviews: 0, layers: {}, errors: 0 };
}

async function saveBucket(env: Env, bucket: AnalyticsBucket): Promise<void> {
	await kvSet(env.CACHE, todayKey(), bucket, { ttl: BUCKET_TTL_MS });
}

export async function handleAnalytics(request: Request, env: Env): Promise<Response> {
	if (request.method === 'GET') {
		// Return aggregated stats for the dashboard
		const bucket = await getBucket(env);
		return Response.json({
			date: new Date().toISOString().slice(0, 10),
			pageviews: bucket.pageviews,
			layers: bucket.layers,
			errors: bucket.errors,
		}, {
			headers: {
				'Cache-Control': 'no-store',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Content-Type': 'application/json',
			'X-Anonymous': 'true', // no user tracking
		},
		});
	}

	if (request.method !== 'POST') {
		return errorResponse('Method Not Allowed', 405);
	}

	let event: AnalyticsEvent;
	try {
		event = await request.json() as AnalyticsEvent;
	} catch {
		return errorResponse('Invalid JSON body', 400);
	}

	if (!event.type) return errorResponse('Missing event.type', 400);

	const bucket = await getBucket(env);

	switch (event.type) {
		case 'pageview':
			bucket.pageviews++;
			break;
		case 'layer_enabled':
			if (event.layerId) {
				if (!bucket.layers[event.layerId]) {
					bucket.layers[event.layerId] = { enabled: 0, disabled: 0 };
				}
				bucket.layers[event.layerId].enabled++;
			}
			break;
		case 'layer_disabled':
			if (event.layerId) {
				if (!bucket.layers[event.layerId]) {
					bucket.layers[event.layerId] = { enabled: 0, disabled: 0 };
				}
				bucket.layers[event.layerId].disabled++;
			}
			break;
		case 'error':
			bucket.errors++;
			break;
		default:
			return errorResponse(`Unknown event type: ${event.type}`, 400);
	}

	await saveBucket(env, bucket);

	return Response.json({ ok: true }, {
		headers: { 'Access-Control-Allow-Origin': '*' },
	});
}
