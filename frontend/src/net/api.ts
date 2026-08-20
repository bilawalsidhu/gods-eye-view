/**
 * Typed REST client.
 *
 * Paths and shapes come from the generated contract, so a backend change that the
 * frontend has not caught up with fails `pnpm typecheck` rather than at runtime.
 * Same-origin: the dev server proxies `/api` to the backend, matching production where
 * one process serves both.
 */

import type {
  AircraftSnapshot,
  Capabilities,
  Health,
  LayerSummary,
  SatelliteElements,
  VesselSnapshot,
} from '../types/entities';

export class ApiError extends Error {
  // Written out rather than declared as constructor parameter properties: that syntax
  // emits runtime code, which `erasableSyntaxOnly` forbids because Vite strips types
  // without a TypeScript compiler and cannot produce it.
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`${path} returned HTTP ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new ApiError(response.status, path);
  }
  return (await response.json()) as T;
}

/** Which layers this deployment can serve, and the credits the UI must display. */
export function fetchCapabilities(): Promise<Capabilities> {
  return getJson<Capabilities>('/api/capabilities');
}

/** Liveness plus per-feed health, for the status banner before the socket is up. */
export function fetchHealth(): Promise<Health> {
  return getJson<Health>('/api/health');
}

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * The current aircraft picture.
 *
 * Used for the first paint, so the globe is populated before the socket has delivered
 * anything. This reads the server's store and never triggers an upstream request.
 */
export function fetchAircraft(options: { box?: BoundingBox; militaryOnly?: boolean } = {}) {
  const query = new URLSearchParams();
  if (options.box !== undefined) {
    query.set('west', String(options.box.west));
    query.set('south', String(options.box.south));
    query.set('east', String(options.box.east));
    query.set('north', String(options.box.north));
  }
  if (options.militaryOnly === true) {
    query.set('military_only', 'true');
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return getJson<AircraftSnapshot>(`/api/aircraft${suffix}`);
}

/**
 * The current vessel picture, for the first paint before the socket has said anything.
 *
 * One merged layer: ADR 010's providers are unioned server side and arrive already resolved
 * to one record per MMSI. This reads the server's store and never triggers an upstream
 * request.
 */
export function fetchVessels(): Promise<VesselSnapshot> {
  return getJson<VesselSnapshot>('/api/vessels');
}

/**
 * How often the per-provider coverage is re-read, in milliseconds.
 *
 * Sixty seconds, matching the vessel union's cadence floor, which is the slowest layer in
 * the build. A provider that drops out therefore shows on the rail within about one cycle
 * of it happening. Feed health arrives on the socket and does not need this; the
 * per-provider errors and exclusive counts of ADR 010 are only on `/api/layers`.
 */
export const LAYER_SUMMARY_POLL_MS = 60_000;

/**
 * Per-layer counts, feed health and per-provider coverage.
 *
 * The provider rows are why this is fetched at all. ADR 010 requires a layer whose
 * provider has dropped out to report itself degraded and name the provider, and requires
 * the provider-attributable count to be on screen. Neither is derivable from
 * `/api/capabilities`, which answers whether a provider is configured rather than whether
 * it answered.
 */
export function fetchLayers(): Promise<LayerSummary> {
  return getJson<LayerSummary>('/api/layers');
}

/**
 * Cached CelesTrak orbital element sets.
 *
 * Elements rather than positions: the browser runs SGP4 itself, in a worker, so the server
 * is never asked to propagate ten thousand objects per request. This reads the server's
 * element cache and never touches CelesTrak, whose own policy is one fetch per group per
 * two hours.
 */
export function fetchSatelliteElements(): Promise<SatelliteElements> {
  return getJson<SatelliteElements>('/api/satellites/elements');
}
