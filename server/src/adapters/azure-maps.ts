import type { TokenCredential } from '@azure/identity';
import type { RuntimeConfig } from '../config.js';
import { HttpProblem } from '../errors.js';
import { fetchBinary, fetchJson } from '../http.js';
import type {
  AdapterContext,
  AzureMaps,
  AzureMapsCoordinate,
  AzureMapsRouteRequest,
  AzureMapsSearchOptions,
  AzureMapsSearchResult,
  BinaryPayload,
} from './contracts.js';

interface MapsResponse {
  readonly results?: readonly unknown[];
  readonly features?: readonly unknown[];
  readonly summary?: unknown;
  readonly addresses?: readonly unknown[];
  readonly routes?: readonly unknown[];
  readonly copyrights?: readonly (string | { readonly copyright?: string; readonly text?: string })[];
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function featurePosition(feature: Record<string, any>): { latitude: number; longitude: number } {
  const coordinates = Array.isArray(feature.geometry?.coordinates)
    ? feature.geometry.coordinates
    : [];
  return {
    latitude: Number(coordinates[1]),
    longitude: Number(coordinates[0]),
  };
}

function normalizedAddress(properties: Record<string, any>): Record<string, any> {
  const address = record(properties.address);
  const countryRegion = record(address.countryRegion);
  return {
    freeformAddress: String(address.formattedAddress ?? address.addressLine ?? ''),
    municipality: address.locality,
    countryCode: countryRegion.iso ?? countryRegion.name,
    entityType: properties.type,
  };
}

export const MAP_TILESETS = Object.freeze({
  imagery: { id: 'microsoft.imagery', minimumZoom: 1, maximumZoom: 19 },
  hybrid: { id: 'microsoft.base.hybrid.road', minimumZoom: 0, maximumZoom: 22 },
  road: { id: 'microsoft.base.road', minimumZoom: 0, maximumZoom: 22 },
});

export class AzureMapsRestAdapter implements AzureMaps {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly credential: TokenCredential,
  ) {}

  private async headers(context: AdapterContext): Promise<Record<string, string>> {
    const token = await this.credential.getToken('https://atlas.microsoft.com/.default');
    if (!token) throw new HttpProblem(503, 'Service Unavailable', 'Azure identity did not issue a Maps token.');
    return {
      accept: 'application/json',
      authorization: `Bearer ${token.token}`,
      'x-correlation-id': context.correlationId,
      ...(this.config.azureMapsClientId ? { 'x-ms-client-id': this.config.azureMapsClientId } : {}),
    };
  }

  private options(context: AdapterContext) {
    return {
      timeoutMs: this.config.upstreamTimeoutMs,
      maxResponseBytes: this.config.responseLimitBytes,
      signal: context.signal,
    };
  }

  async searchAddress(
    query: string,
    options: AzureMapsSearchOptions,
    context: AdapterContext,
  ): Promise<AzureMapsSearchResult> {
    const url = new URL('/geocode', this.config.azureMapsEndpoint);
    url.searchParams.set('api-version', '2026-01-01');
    url.searchParams.set('query', query);
    url.searchParams.set('top', String(Math.min(options.limit ?? 10, 20)));
    if (options.latitude !== undefined && options.longitude !== undefined) {
      url.searchParams.set('coordinates', `${options.longitude},${options.latitude}`);
    }
    const response = await fetchJson<MapsResponse>(url, { headers: await this.headers(context) }, this.options(context));
    return {
      results: (response.features ?? []).map((value, index) => {
        const item = record(value);
        const properties = record(item.properties);
        const address = normalizedAddress(properties);
        const position = featurePosition(item);
        return {
          id: String(item.id ?? `${position.longitude},${position.latitude}:${index}`),
          type: properties.type,
          name: String(address.freeformAddress || properties.name || item.id || ''),
          position,
          address,
          score: properties.confidence,
        };
      }),
      summary: { count: response.features?.length ?? 0 },
    };
  }

  async reverseGeocode(
    coordinate: AzureMapsCoordinate,
    language: string | undefined,
    context: AdapterContext,
  ): Promise<unknown> {
    const url = new URL('/reverseGeocode', this.config.azureMapsEndpoint);
    url.searchParams.set('api-version', '2026-01-01');
    url.searchParams.set('coordinates', `${coordinate.longitude},${coordinate.latitude}`);
    void language;
    const response = await fetchJson<MapsResponse>(url, { headers: await this.headers(context) }, this.options(context));
    return {
      addresses: (response.features ?? []).map((value) => {
        const item = record(value);
        const properties = record(item.properties);
        const address = normalizedAddress(properties);
        return {
          formattedAddress: address.freeformAddress,
          position: featurePosition(item),
          municipality: address.municipality,
          countryCode: address.countryCode,
        };
      }),
      summary: { count: response.features?.length ?? 0 },
    };
  }

  async route(request: AzureMapsRouteRequest, context: AdapterContext): Promise<unknown> {
    const url = new URL('/route/directions/json', this.config.azureMapsEndpoint);
    url.searchParams.set('api-version', '1.0');
    url.searchParams.set('query', request.coordinates.map((point) => `${point.latitude},${point.longitude}`).join(':'));
    url.searchParams.set('travelMode', request.travelMode ?? 'car');
    url.searchParams.set('traffic', String(request.traffic ?? true));
    if (request.routeType) url.searchParams.set('routeType', request.routeType);
    if (request.language) url.searchParams.set('language', request.language);
    const response = await fetchJson<MapsResponse>(url, { headers: await this.headers(context) }, this.options(context));
    return { routes: response.routes ?? [] };
  }

  trafficStatus() {
    return { configured: true, available: true, reason: null } as const;
  }

  async tile(
    tilesetId: string,
    zoom: number,
    x: number,
    y: number,
    context: AdapterContext,
  ): Promise<BinaryPayload> {
    const url = new URL('/map/tile', this.config.azureMapsEndpoint);
    url.searchParams.set('api-version', '2024-04-01');
    url.searchParams.set('tilesetId', tilesetId);
    url.searchParams.set('zoom', String(zoom));
    url.searchParams.set('x', String(x));
    url.searchParams.set('y', String(y));
    url.searchParams.set('tileSize', '256');
    return fetchBinary(url, { headers: await this.headers(context) }, this.options(context));
  }

  async attribution(
    tilesetIds: readonly string[],
    bounds: string,
    zoom: number,
    context: AdapterContext,
  ): Promise<readonly string[]> {
    const values = await Promise.all(tilesetIds.map(async (tilesetId) => {
      const url = new URL('/map/attribution', this.config.azureMapsEndpoint);
      url.searchParams.set('api-version', '2024-04-01');
      url.searchParams.set('tilesetId', tilesetId);
      url.searchParams.set('zoom', String(zoom));
      url.searchParams.set('bounds', bounds);
      const response = await fetchJson<MapsResponse>(url, { headers: await this.headers(context) }, this.options(context));
      return (response.copyrights ?? []).map((item) => (
        typeof item === 'string' ? item : item.copyright ?? item.text ?? ''
      )).filter(Boolean);
    }));
    const unique = [...new Set(values.flat())];
    return unique.length ? unique : ['© Microsoft Azure Maps and data suppliers'];
  }
}
