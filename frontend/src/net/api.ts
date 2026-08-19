/**
 * Typed REST client.
 *
 * Paths and shapes come from the generated contract, so a backend change that the
 * frontend has not caught up with fails `pnpm typecheck` rather than at runtime.
 * Same-origin: the dev server proxies `/api` to the backend, matching production where
 * one process serves both.
 */

import type { AircraftSnapshot, Capabilities, Health } from '../types/entities';

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
