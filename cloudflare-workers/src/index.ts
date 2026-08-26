/**
 * God's Eye View — Cloudflare Workers API Proxy
 *
 * Unified worker that routes all data source requests to their respective handlers.
 * Keeps API keys server-side, adds caching, rate limiting, and CORS headers.
 */

import type { Env } from './lib/shared.js';
import { errorResponse } from './lib/shared.js';

import { handleOpenSky } from './handlers/opensky.js';
import { handleCelestrak } from './handlers/celestrak.js';
import { handleAis } from './handlers/ais.js';
import { handleFirms } from './handlers/firms.js';
import { handleTomTom } from './handlers/tomtom.js';
import { handleCctv } from './handlers/cctv.js';
import { handleOverpass } from './handlers/overpass.js';
import { handleGbfs } from './handlers/gbfs.js';
import { handleTerrain } from './handlers/terrain.js';
import { handleWeather } from './handlers/weather.js';
import { handleRadio } from './handlers/radio.js';
import { handleRocketLaunches } from './handlers/rocketLaunches.js';
import { handleMilitaryInstallations } from './handlers/military.js';
import { handleRegionalBrief } from './handlers/regional.js';

// Route table: pathname → handler
type Handler = (req: Request, env: Env) => Promise<Response>;

const ROUTES: Record<string, Handler> = {
	'/api/opensky': handleOpenSky,
	'/api/celestrak': handleCelestrak,
	'/api/ais-live': handleAis,
	'/api/firms': handleFirms,
	'/api/tomtom': handleTomTom,
	'/api/cctv': handleCctv,
	'/api/overpass': handleOverpass,
	'/api/gbfs': handleGbfs,
	'/api/terrain': handleTerrain,
	'/api/weather': handleWeather,
	'/api/rocket-launches': handleRocketLaunches,
	'/api/military-installations': handleMilitaryInstallations,
	'/api/regional-brief': handleRegionalBrief,
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		// Health check — always accessible
		if (pathname === '/api/health') {
			return Response.json({ status: 'ok', timestamp: Date.now() });
		}

		const handler = ROUTES[pathname];
		if (!handler) {
			return errorResponse(`Unknown route: ${pathname}`, 404);
		}

		// CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
					'Access-Control-Max-Age': '86400',
				},
			});
		}

		try {
			const response = await handler(request, env);

			const headers = new Headers(response.headers);
			headers.set('Access-Control-Allow-Origin', '*');
			headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

			return new Response(response.body, {
				status: response.status,
				headers,
			});
		} catch (err) {
			console.error(`[worker] unhandled error at ${pathname}:`, err);
			return errorResponse('Internal server error', 500);
		}
	},
} satisfies ExportedHandler<Env>;
