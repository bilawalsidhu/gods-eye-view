import { createRoute, distanceMeters } from './drone/index.js';

export const MAX_DRONE_ROUTE_POINTS = 64;
export const MAX_DRONE_ROUTE_DISTANCE_METERS = 500_000;
export const DEFAULT_DRONE_SETTINGS = Object.freeze({
  minimumAglMeters: 60,
  groundSpeedMps: 15,
  maxClimbRateMps: 5,
  maxDescentRateMps: 4,
  destinationRadiusMeters: 250,
});

function positive(value, label, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new RangeError(`${label} must be ${allowZero ? 'zero or greater' : 'greater than zero'}`);
  }
  return number;
}

export function normalizeDroneSettings(input = {}) {
  return Object.freeze({
    minimumAglMeters: positive(
      input.minimumAglMeters ?? DEFAULT_DRONE_SETTINGS.minimumAglMeters,
      'Minimum terrain clearance',
      { allowZero: true },
    ),
    groundSpeedMps: positive(
      input.groundSpeedMps ?? DEFAULT_DRONE_SETTINGS.groundSpeedMps,
      'Ground speed',
    ),
    maxClimbRateMps: positive(
      input.maxClimbRateMps ?? DEFAULT_DRONE_SETTINGS.maxClimbRateMps,
      'Maximum climb rate',
    ),
    maxDescentRateMps: positive(
      input.maxDescentRateMps ?? DEFAULT_DRONE_SETTINGS.maxDescentRateMps,
      'Maximum descent rate',
    ),
    destinationRadiusMeters: positive(
      input.destinationRadiusMeters ?? DEFAULT_DRONE_SETTINGS.destinationRadiusMeters,
      'Destination radius',
    ),
  });
}

export function createDroneRouteFromDraft(draft, settings = DEFAULT_DRONE_SETTINGS) {
  const destination = draft?.destination?.type === 'area'
    ? {
      type: 'area',
      center: draft.destination.center,
      radiusMeters: normalizeDroneSettings(settings).destinationRadiusMeters,
    }
    : draft?.destination;
  const route = createRoute({
    launch: draft?.launch,
    waypoints: draft?.waypoints || [],
    destination,
  });
  const points = [
    route.launch,
    ...route.waypoints,
    route.destination.type === 'area' ? route.destination.center : route.destination.point,
  ];
  if (points.length > MAX_DRONE_ROUTE_POINTS) {
    throw new RangeError(`Drone routes support at most ${MAX_DRONE_ROUTE_POINTS} points`);
  }
  const totalDistance = points.slice(1).reduce(
    (sum, point, index) => sum + distanceMeters(points[index], point),
    0,
  );
  if (totalDistance > MAX_DRONE_ROUTE_DISTANCE_METERS) {
    throw new RangeError('Drone route exceeds the 500 km demo limit');
  }
  return route;
}

export function missionConfirmationSummary(route, settings) {
  const normalized = normalizeDroneSettings(settings);
  return Object.freeze({
    routePointCount: route.waypoints.length + 2,
    waypointCount: route.waypoints.length,
    destinationType: route.destination.type,
    minimumAglMeters: normalized.minimumAglMeters,
    groundSpeedMps: normalized.groundSpeedMps,
    provenance: 'SIMULATED / DEMO',
  });
}
