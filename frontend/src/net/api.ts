/**
 * Typed REST client.
 *
 * Paths and shapes come from the generated contract, so a backend change that the
 * frontend has not caught up with fails `pnpm typecheck` rather than at runtime.
 * Same-origin: the dev server proxies `/api` to the backend, matching production where
 * one process serves both.
 */

import type {
  AircraftDetail,
  AircraftSnapshot,
  Capabilities,
  CitySnapshot,
  Health,
  LayerSummary,
  SatelliteElements,
  SearchResponse,
  SocialSnapshot,
  TransitSnapshot,
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

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    // Null rather than undefined: `exactOptionalPropertyTypes` will not let an explicitly
    // undefined property stand in for an absent one, and `RequestInit.signal` accepts null.
    signal: signal ?? null,
  });
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
 * One aircraft with its registry join, for the card.
 *
 * The only call in the frontend that makes the server touch an upstream, and it is
 * demand-driven for that reason: the registry allows 512 requests a minute per IP and a live
 * layer is thousands of aircraft, so the owner is fetched for the one aircraft somebody
 * clicked. The server caches per address, so re-opening a card costs nothing.
 *
 * `null` means the server is not currently holding that aircraft, which is a normal answer
 * rather than an error: it may simply have left the viewport.
 */
export function fetchAircraftDetail(icao24: string): Promise<AircraftDetail | null> {
  return getJson<AircraftDetail | null>(`/api/aircraft/${encodeURIComponent(icao24)}`);
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
 * How much of the viewport a social search covers, as a fraction, and the default limit.
 *
 * 200 rather than the route's 500 ceiling, matching the server's own default. The provider is the
 * constraint rather than the transport: Commons answers with the files nearest the box centre and
 * caps its geosearch radius at 10km, so asking for more than it will return costs a bigger
 * response for the same posts.
 */
export const SOCIAL_LIMIT = 200;

/**
 * Social posts inside a box, which is the one route here where the box is not optional.
 *
 * The mover routes hold a world set and filter it, so a request with no box is the same query
 * unnarrowed. This one asks a provider about a place, so a request with no box is a different
 * question and the route refuses it. That is why this takes the box as an argument rather than as
 * an option, and why it is driven by the camera coming to rest rather than by a timer.
 */
export function fetchSocial(box: BoundingBox, limit: number = SOCIAL_LIMIT) {
  const query = new URLSearchParams({
    west: String(box.west),
    south: String(box.south),
    east: String(box.east),
    north: String(box.north),
    limit: String(limit),
  });
  return getJson<SocialSnapshot>(`/api/social?${query.toString()}`);
}

/**
 * How far the camera has to move before the social layer asks again, as a fraction of the box.
 *
 * A quarter. `moveEnd` fires on every camera rest, and social is the one layer whose fetch reaches
 * a third party rather than our own store, so a nudge must not become a request. Commons answers
 * with the files nearest the box centre, so a small pan returns the same posts and the only thing
 * spent is somebody else's rate limit.
 */
export const SOCIAL_REFETCH_FRACTION = 0.25;

/**
 * Whether the camera has moved far enough to be asking a different question.
 *
 * Here rather than in `main.ts`, and the move was the point. This is a decision, and `main.ts` is
 * the one module excluded from coverage because it builds a real Cesium viewer, so a decision left
 * there is a decision no test can reach. Its own docstring says as much: anything in there that
 * starts deciding belongs in the module that owns the decision. This one owns when to call the
 * route above.
 *
 * A zoom counts as movement even with no pan, because the box radius is what decides whether the
 * provider's 10km cap bites: standing still and zooming out turns a covered view into a sampled
 * one, and the notice has to change with it.
 */
export function boxMovedEnough(previous: BoundingBox | null, next: BoundingBox): boolean {
  if (previous === null) {
    return true;
  }
  const width = Math.abs(next.east - next.west);
  const height = Math.abs(next.north - next.south);
  const grew = (a: number, b: number, span: number): boolean =>
    Math.abs(a - b) > span * SOCIAL_REFETCH_FRACTION;
  const zoomed =
    grew(width, Math.abs(previous.east - previous.west), width) ||
    grew(height, Math.abs(previous.north - previous.south), height);
  const panned =
    grew((next.west + next.east) / 2, (previous.west + previous.east) / 2, width) ||
    grew((next.north + next.south) / 2, (previous.north + previous.south) / 2, height);
  return zoomed || panned;
}

/**
 * The transit snapshot, read once at startup like the vessel one.
 *
 * No parameters. The backend serves what its seventeen countries of feeds report, and there is
 * no viewport query to narrow it: unlike aircraft, coverage here is decided by which agencies
 * publish a keyless GTFS-realtime feed rather than by where the camera is, so asking for a box
 * would filter a set that is already geographically fixed.
 */
export function fetchTransit(): Promise<TransitSnapshot> {
  return getJson<TransitSnapshot>('/api/transit');
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

/**
 * Resolve one query against everything the server holds.
 *
 * One call for every identity in the system: a callsign, a registration, an ICAO address, an
 * MMSI, an IMO number, a satellite name, a NORAD catalogue number, a city or an address. The
 * server scans the same stores the socket serves and answers cities out of its in-process
 * GeoNames index, so the ordinary case costs no upstream request at all. It consults
 * Nominatim only when every local group came back empty, which is what keeps a typeahead
 * inside a usage policy whose absolute cap is one request per second.
 *
 * The signal is not decoration. A typeahead abandons queries constantly, and an aborted
 * request is one the server stops working on rather than one whose answer is thrown away.
 */
export function searchAll(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const parameters = new URLSearchParams({ q: query, limit: String(limit) });
  return getJson<SearchResponse>(`/api/search?${parameters.toString()}`, signal);
}

/**
 * The ceiling on one city read, matching the route's own maximum.
 *
 * Above the current row count on purpose, exactly as the backend's `CITY_READ_LIMIT_MAX` is:
 * a limit tracking today's 34,072 rows would silently truncate the layer the week GeoNames
 * adds a city.
 *
 * Named for the backend constant it mirrors. It used to be called `CITY_READ_LIMIT`, which is
 * the name of a different backend constant holding 2,000: same name, different meaning, across
 * a boundary, which is the trap AGENTS.md keeps a whole section about.
 */
export const CITY_READ_LIMIT_MAX = 40_000;

/**
 * The whole gazetteer, once.
 *
 * Cities do not move, so this is a single read at start-up rather than a poll, and it never
 * runs again. It reads the server's in-process GeoNames index and touches no upstream: the
 * weekly conditional download is the backend's job and happens whether a browser is open or
 * not.
 *
 * The whole file rather than a page of it, because the layer is what decides which cities are
 * worth labelling from where the camera is, and it cannot decide that over records it does
 * not hold. Asking for a box instead would put a fetch on every camera move, which is the
 * one thing a static file should never need.
 */
export function fetchCities(limit: number = CITY_READ_LIMIT_MAX): Promise<CitySnapshot> {
  return getJson<CitySnapshot>(`/api/cities?limit=${String(limit)}`);
}
