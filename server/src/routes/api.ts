import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChatMessage, ServiceAdapters } from '../adapters/index.js';
import { MAP_TILESETS } from '../adapters/azure-maps.js';
import { HttpProblem } from '../errors.js';

interface MapsQuery {
  readonly query?: string;
  readonly q?: string;
  readonly limit?: string;
  readonly language?: string;
  readonly countrySet?: string;
  readonly lat?: string;
  readonly lon?: string;
}

interface TileQuery {
  readonly tilesetId?: string;
  readonly zoom?: string;
  readonly x?: string;
  readonly y?: string;
  readonly tileSize?: string;
}

interface AttributionQuery {
  readonly tilesetId?: string;
  readonly style?: string;
  readonly zoom?: string;
  readonly bounds?: string;
}

interface RouteBody {
  readonly coordinates?: readonly { readonly latitude?: number; readonly longitude?: number }[];
  readonly travelMode?: string;
  readonly traffic?: boolean;
  readonly routeType?: string;
  readonly language?: string;
}

interface RealtimeBody {
  readonly deployment?: string;
  readonly voice?: string;
  readonly instructions?: string;
  readonly modalities?: readonly string[];
}

interface HudBody {
  readonly prompt?: string;
  readonly context?: unknown;
  readonly maxCharacters?: number;
}

interface ChatBody {
  readonly messages?: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

const ALLOWED_TILESETS = new Map(Object.values(MAP_TILESETS).map((item) => [item.id, item]));

function context(request: FastifyRequest) {
  const controller = new AbortController();
  request.raw.once('aborted', () => controller.abort());
  return { correlationId: request.id, signal: controller.signal };
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new HttpProblem(400, 'Bad Request', `${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function boundedNumber(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpProblem(400, 'Bad Request', `${field} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = boundedNumber(value, field, min, max);
  if (!Number.isInteger(parsed)) throw new HttpProblem(400, 'Bad Request', `${field} must be an integer.`);
  return parsed;
}

export function fiveWordHudSummary(value: string, maxCharacters = 160): string {
  const words = value
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (words.length !== 5) {
    throw new HttpProblem(502, 'Bad Gateway', 'Foundry did not return an exact five-word HUD summary.');
  }
  const summary = words.join(' ');
  if (summary.length > Math.max(20, Math.min(maxCharacters, 240))) {
    throw new HttpProblem(502, 'Bad Gateway', 'Foundry HUD summary exceeded the character limit.');
  }
  return summary;
}

export async function registerApiRoutes(app: FastifyInstance, adapters: ServiceAdapters): Promise<void> {
  app.get('/api/status', async () => ({
    service: 'satview-bff',
    capabilities: {
      maps: Boolean(adapters.maps),
      foundry: Boolean(adapters.foundry),
      ais: Boolean(adapters.ais),
    },
  }));

  app.get<{ Querystring: MapsQuery }>('/api/azure/maps/search', async (request) => {
    if (!adapters.maps) throw new HttpProblem(503, 'Service Unavailable', 'Azure Maps is not configured.');
    const query = requireText(request.query.query ?? request.query.q, 'query', 256);
    const latitude = request.query.lat === undefined ? undefined : boundedNumber(request.query.lat, 'lat', -90, 90);
    const longitude = request.query.lon === undefined ? undefined : boundedNumber(request.query.lon, 'lon', -180, 180);
    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new HttpProblem(400, 'Bad Request', 'lat and lon must be supplied together.');
    }
    return adapters.maps.searchAddress(query, {
      limit: request.query.limit === undefined ? undefined : integer(request.query.limit, 'limit', 1, 100),
      language: request.query.language,
      countrySet: request.query.countrySet,
      latitude,
      longitude,
    }, context(request));
  });

  app.get<{ Querystring: MapsQuery }>('/api/azure/maps/reverse-geocode', async (request) => {
    if (!adapters.maps) throw new HttpProblem(503, 'Service Unavailable', 'Azure Maps is not configured.');
    return adapters.maps.reverseGeocode({
      latitude: boundedNumber(request.query.lat, 'lat', -90, 90),
      longitude: boundedNumber(request.query.lon, 'lon', -180, 180),
    }, request.query.language, context(request));
  });

  app.post<{ Body: RouteBody }>('/api/azure/maps/route', async (request) => {
    if (!adapters.maps) throw new HttpProblem(503, 'Service Unavailable', 'Azure Maps is not configured.');
    if (!Array.isArray(request.body?.coordinates) || request.body.coordinates.length < 2 || request.body.coordinates.length > 25) {
      throw new HttpProblem(400, 'Bad Request', 'coordinates must contain between 2 and 25 points.');
    }
    const coordinates = request.body.coordinates.map((point, index) => ({
      latitude: boundedNumber(point?.latitude, `coordinates[${index}].latitude`, -90, 90),
      longitude: boundedNumber(point?.longitude, `coordinates[${index}].longitude`, -180, 180),
    }));
    return adapters.maps.route({
      coordinates,
      travelMode: request.body.travelMode,
      traffic: request.body.traffic,
      routeType: request.body.routeType,
      language: request.body.language,
    }, context(request));
  });

  app.get('/api/azure/maps/traffic/status', async () => (
    adapters.maps?.trafficStatus() ?? {
      configured: false,
      available: false,
      reason: 'Azure Maps is not configured.',
    }
  ));

  const rejectTokenExport = async () => {
    throw new HttpProblem(
      410,
      'Gone',
      'Managed-identity tokens are not exported. Use the same-origin tile and attribution proxy.',
    );
  };
  app.get('/api/azure/maps/token', rejectTokenExport);
  app.get('/api/azure/maps/traffic/token', rejectTokenExport);

  app.get<{ Querystring: TileQuery }>('/api/azure/maps/tile', async (request, reply) => {
    if (!adapters.maps) throw new HttpProblem(503, 'Service Unavailable', 'Azure Maps is not configured.');
    const tilesetId = requireText(request.query.tilesetId, 'tilesetId', 64);
    const tileset = ALLOWED_TILESETS.get(tilesetId);
    if (!tileset) throw new HttpProblem(400, 'Bad Request', 'Unsupported Azure Maps tileset.');
    const zoom = integer(request.query.zoom, 'zoom', tileset.minimumZoom, tileset.maximumZoom);
    const maxCoordinate = (2 ** zoom) - 1;
    const x = integer(request.query.x, 'x', 0, maxCoordinate);
    const y = integer(request.query.y, 'y', 0, maxCoordinate);
    if (request.query.tileSize !== undefined && request.query.tileSize !== '256') {
      throw new HttpProblem(400, 'Bad Request', 'tileSize must be 256.');
    }
    const tile = await adapters.maps.tile(tilesetId, zoom, x, y, context(request));
    return reply
      .type(tile.contentType)
      .header('cache-control', tile.cacheControl ?? 'public, max-age=3600')
      .send(tile.body);
  });

  app.get<{ Querystring: AttributionQuery }>('/api/azure/maps/attribution', async (request) => {
    if (!adapters.maps) throw new HttpProblem(503, 'Service Unavailable', 'Azure Maps is not configured.');
    const bounds = requireText(request.query.bounds, 'bounds', 128);
    const coordinates = bounds.split(',').map(Number);
    if (
      coordinates.length !== 4
      || coordinates.some((value) => !Number.isFinite(value))
      || coordinates[0]! < -180 || coordinates[0]! > 180
      || coordinates[2]! < -180 || coordinates[2]! > 180
      || coordinates[1]! < -90 || coordinates[1]! > 90
      || coordinates[3]! < -90 || coordinates[3]! > 90
    ) {
      throw new HttpProblem(400, 'Bad Request', 'bounds must be west,south,east,north.');
    }
    const zoom = integer(request.query.zoom, 'zoom', 0, 22);
    const requested = request.query.tilesetId?.split(',').filter(Boolean)
      ?? (request.query.style === 'hybrid'
        ? [MAP_TILESETS.imagery.id, MAP_TILESETS.hybrid.id]
        : [request.query.style === 'streets' ? MAP_TILESETS.road.id : MAP_TILESETS.imagery.id]);
    if (requested.some((id) => !ALLOWED_TILESETS.has(id))) {
      throw new HttpProblem(400, 'Bad Request', 'Unsupported Azure Maps tileset.');
    }
    return { attributions: await adapters.maps.attribution(requested, bounds, zoom, context(request)) };
  });

  app.post<{ Body: RealtimeBody }>('/api/azure/foundry/realtime/client-secret', async (request, reply) => {
    if (!adapters.foundry) throw new HttpProblem(503, 'Service Unavailable', 'Microsoft Foundry is not configured.');
    const secret = await adapters.foundry.createRealtimeClientSecret({
      voice: request.body?.voice,
      instructions: request.body?.instructions
        ? requireText(request.body.instructions, 'instructions', 32_000)
        : undefined,
      modalities: request.body?.modalities,
    }, context(request));
    reply.header('cache-control', 'no-store');
    return {
      clientSecret: { value: secret.value, expiresAt: secret.expiresAt },
      endpoint: secret.endpoint,
      deployment: secret.deployment,
      model: secret.model,
    };
  });

  const hudHandler = async (request: FastifyRequest<{ Body: HudBody }>, reply: any) => {
    if (!adapters.foundry) {
      return reply.code(503).send({
        configured: false,
        summary: null,
        code: 'FOUNDRY_NOT_CONFIGURED',
        error: null,
      });
    }
    const prompt = requireText(request.body?.prompt ?? 'Summarize this scene', 'prompt', 8_000);
    const maxCharacters = request.body?.maxCharacters === undefined
      ? 160
      : integer(request.body.maxCharacters, 'maxCharacters', 20, 240);
    const output = await adapters.foundry.createHudSummary({
      prompt,
      context: request.body?.context ?? request.body,
      maxCharacters,
    }, context(request));
    reply.header('cache-control', 'no-store');
    return { configured: true, summary: fiveWordHudSummary(output, maxCharacters), error: null };
  };
  app.post('/api/azure/foundry/hud-summary', hudHandler);
  app.post('/api/openai/hud-summary', hudHandler);

  app.route({
    method: ['GET', 'POST'],
    url: '/api/realtime/token',
    handler: async (request, reply) => {
      if (!adapters.foundry) throw new HttpProblem(503, 'Service Unavailable', 'Microsoft Foundry is not configured.');
      const secret = await adapters.foundry.createRealtimeClientSecret({}, context(request));
      reply.header('cache-control', 'no-store');
      return { value: secret.value, expires_at: secret.expiresAt };
    },
  });

  app.get<{ Querystring: { maxRows?: string } }>('/api/ais-live', async (request, reply) => {
    adapters.ais?.start();
    const snapshot = adapters.ais?.snapshot(
      request.query.maxRows === undefined ? 50_000 : integer(request.query.maxRows, 'maxRows', 1, 50_000),
    );
    if (!snapshot) throw new HttpProblem(503, 'Service Unavailable', 'AISStream is not configured.');
    if (snapshot.status === 'missing-key') reply.code(503);
    reply.header('cache-control', 'no-store');
    return snapshot;
  });

  app.get<{ Querystring: { mmsi?: string } }>('/api/ais-live/track', async (request, reply) => {
    const mmsi = String(request.query.mmsi ?? '').trim();
    if (!/^\d{5,10}$/.test(mmsi)) {
      throw new HttpProblem(400, 'Bad Request', 'mmsi query param must contain 5 to 10 digits.');
    }
    reply.header('cache-control', 'no-store');
    return {
      mmsi,
      samples: adapters.ais?.track(mmsi) ?? [],
      source: 'AISStream (accumulated since server start)',
      provenance: 'Best-effort AISStream track; not authoritative navigation data.',
      retainedSec: 1800,
    };
  });

  app.get<{ Querystring: { maxRows?: string } }>('/api/ais/vessels', async (request) => {
    adapters.ais?.start();
    return adapters.ais?.snapshot(
      request.query.maxRows === undefined ? 50_000 : integer(request.query.maxRows, 'maxRows', 1, 50_000),
    ) ?? { rows: [] };
  });

  app.post<{ Body: ChatBody }>('/api/foundry/chat', async (request) => {
    if (!adapters.foundry) throw new HttpProblem(503, 'Service Unavailable', 'Microsoft Foundry is not configured.');
    if (!Array.isArray(request.body?.messages) || request.body.messages.length < 1 || request.body.messages.length > 50) {
      throw new HttpProblem(400, 'Bad Request', 'messages must contain between 1 and 50 chat messages.');
    }
    return adapters.foundry.complete({
      messages: request.body.messages.map((message, index) => ({
        role: message.role,
        content: requireText(message.content, `messages[${index}].content`, 16_000),
      })),
      maxTokens: request.body.maxTokens,
      temperature: request.body.temperature,
    }, context(request));
  });
}
