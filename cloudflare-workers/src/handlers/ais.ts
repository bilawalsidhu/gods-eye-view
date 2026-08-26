/**
 * AIS (Automatic Identification System) vessel tracking proxy.
 * Uses Cloudflare Durable Objects to maintain persistent WebSocket sessions.
 * Docs: https://aisstream.io/
 */
import type { Env } from '../lib/shared.js';
import { errorResponse, RateLimiter } from '../lib/shared.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function handleAis(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	const clientKey = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	if (!rateLimiter.allow(clientKey)) {
		return errorResponse('Rate limit exceeded', 429);
	}

	if (!env.AISSTREAM_API_KEY) {
		return errorResponse('AISSTREAM_API_KEY not configured', 500);
	}

	// Handle WebSocket upgrade for AIS stream
	if (request.headers.get('Upgrade') === 'websocket') {
		return handleAisWebSocket(request, env);
	}

	// GET returns status
	const bboxParam = url.searchParams.get('bbox');
	return Response.json({
		status: 'ok',
		message: 'AIS proxy active. Use WebSocket at /api/ais-live for vessel stream.',
		bbox: bboxParam,
	});
}

interface AisStreamMessage {
	Metas?: Array<{
		MMSI?: number;
		ShipName?: string;
		ShipType?: string;
		Destination?: string;
		IMO?: number;
	}>;
	Positions?: Array<{
		Latitude?: number;
		Longitude?: number;
		SOG?: number;
		COG?: number;
		TrueHeading?: number;
	}>;
}

async function handleAisWebSocket(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const bboxParam = url.searchParams.get('bbox') ?? '-90,-180,90,180';

	const bboxParts = bboxParam.split(',').map(Number);
	if (bboxParts.length !== 4 || bboxParts.some(isNaN)) {
		return errorResponse('Invalid bbox format', 400);
	}
	const [south, west, north, east] = bboxParts;

	const filterMessageTypes = ['PositionReport', 'ShipStaticData', 'StaticDataReport'];
	const body = JSON.stringify({
		APIKey: env.AISSTREAM_API_KEY,
		BoundingBoxes: [[[south, west], [north, east]]],
		FilterMessageTypes: filterMessageTypes,
	});

	try {
		// Establish upstream WebSocket to AISStream
		const upstream = new WebSocket('wss://aisstream.io/v3/stream');

		// Send subscription after connecting
		await new Promise<void>((resolve, reject) => {
			upstream.addEventListener('open', () => {
				try { upstream.send(body); } catch (e) { console.error(e); }
				resolve();
			});
			upstream.addEventListener('error', reject);
		});

		// Create browser-facing WebSocket pair
		const pair = new WebSocketPair();
		const browserWs = pair[0];
		const serverWs = pair[1];

		serverWs.addEventListener('message', (event) => {
			// Client heartbeat — AISStream doesn't need client messages
		});

		browserWs.addEventListener('close', () => {
			upstream.close();
		});

		upstream.addEventListener('message', (event) => {
			try {
				const msg = JSON.parse(event.data as string) as AisStreamMessage;
				serverWs.send(JSON.stringify(normalizeAisMessage(msg)));
			} catch {
				// passthrough non-parseable messages
			}
		});

		upstream.addEventListener('close', () => {
			serverWs.close();
		});

		return new Response(null, {
			status: 101,
			webSocket: serverWs,
		});
	} catch (err) {
		console.error('[ais] WebSocket setup failed:', err);
		return errorResponse('AIS WebSocket unavailable', 502);
	}
}

function normalizeAisMessage(msg: AisStreamMessage): Record<string, unknown> {
	const meta = msg.Metas?.[0];
	const pos = msg.Positions?.[0];

	return {
		mmsi: meta?.MMSI,
		lat: pos?.Latitude,
		lon: pos?.Longitude,
		sog: pos?.SOG,
		cog: pos?.COG,
		heading: pos?.TrueHeading,
		shipname: meta?.ShipName,
		shiptype: meta?.ShipType,
		destination: meta?.Destination,
		imo: meta?.IMO,
	};
}
