import { distanceMeters, normalizeLongitude } from './geodesy.js';

export class RouteValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RouteValidationError';
  }
}

function immutablePoint(input, label, { waypoint = false } = {}) {
  if (!input || typeof input !== 'object') {
    throw new RouteValidationError(`${label} must be an object`);
  }
  const latitude = input.latitude ?? input.lat;
  const longitude = input.longitude ?? input.lon;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RouteValidationError(`${label}.latitude must be a finite number from -90 to 90`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RouteValidationError(`${label}.longitude must be a finite number from -180 to 180`);
  }
  const point = { latitude, longitude: normalizeLongitude(longitude) };
  if (waypoint) {
    if (typeof input.id !== 'string' || !input.id.trim()) {
      throw new RouteValidationError(`${label}.id must be a non-empty string`);
    }
    point.id = input.id;
  }
  return Object.freeze(point);
}

function immutableDestination(input) {
  if (!input || typeof input !== 'object') {
    throw new RouteValidationError('destination must be an object');
  }
  if (input.type === 'area') {
    const radiusMeters = input.radiusMeters;
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      throw new RouteValidationError('destination.radiusMeters must be greater than zero');
    }
    return Object.freeze({
      type: 'area',
      center: immutablePoint(input.center ?? input, 'destination.center'),
      radiusMeters,
    });
  }
  if (input.type != null && input.type !== 'point') {
    throw new RouteValidationError('destination.type must be "point" or "area"');
  }
  return Object.freeze({
    type: 'point',
    point: immutablePoint(input.point ?? input, 'destination.point'),
  });
}

function destinationAnchor(destination) {
  return destination.type === 'area' ? destination.center : destination.point;
}

function validateDistinctPoints(points) {
  for (let index = 1; index < points.length; index += 1) {
    if (distanceMeters(points[index - 1], points[index]) < 0.01) {
      throw new RouteValidationError(`route points ${index - 1} and ${index} must be distinct`);
    }
  }
}

function nextWaypointId(route) {
  const ids = new Set(route.waypoints.map(({ id }) => id));
  let suffix = 1;
  while (ids.has(`waypoint-${suffix}`)) suffix += 1;
  return `waypoint-${suffix}`;
}

export function createRoute({ launch, waypoints = [], destination } = {}) {
  if (!Array.isArray(waypoints)) {
    throw new RouteValidationError('waypoints must be an array');
  }
  const normalizedWaypoints = waypoints.map((point, index) => immutablePoint(
    { ...point, id: point?.id ?? `waypoint-${index + 1}` },
    `waypoints[${index}]`,
    { waypoint: true },
  ));
  const ids = new Set(normalizedWaypoints.map(({ id }) => id));
  if (ids.size !== normalizedWaypoints.length) {
    throw new RouteValidationError('waypoint ids must be unique');
  }

  const route = {
    launch: immutablePoint(launch, 'launch'),
    waypoints: Object.freeze(normalizedWaypoints),
    destination: immutableDestination(destination),
  };
  validateDistinctPoints([route.launch, ...route.waypoints, destinationAnchor(route.destination)]);
  return Object.freeze(route);
}

export function getRoutePoints(route) {
  assertRoute(route);
  return Object.freeze([
    route.launch,
    ...route.waypoints,
    destinationAnchor(route.destination),
  ]);
}

export function assertRoute(route) {
  if (!route || typeof route !== 'object') throw new RouteValidationError('route is required');
  createRoute(route);
  return route;
}

export function insertWaypoint(route, index, point) {
  assertRoute(route);
  if (!Number.isInteger(index) || index < 0 || index > route.waypoints.length) {
    throw new RangeError('waypoint insertion index is out of range');
  }
  const waypoint = { ...point, id: point?.id ?? nextWaypointId(route) };
  return createRoute({
    ...route,
    waypoints: [
      ...route.waypoints.slice(0, index),
      waypoint,
      ...route.waypoints.slice(index),
    ],
  });
}

export function moveWaypoint(route, index, position) {
  assertRoute(route);
  if (!Number.isInteger(index) || index < 0 || index >= route.waypoints.length) {
    throw new RangeError('waypoint index is out of range');
  }
  const waypoints = [...route.waypoints];
  waypoints[index] = {
    id: waypoints[index].id,
    latitude: position?.latitude ?? position?.lat ?? waypoints[index].latitude,
    longitude: position?.longitude ?? position?.lon ?? waypoints[index].longitude,
  };
  return createRoute({ ...route, waypoints });
}

export function reorderWaypoint(route, fromIndex, toIndex) {
  assertRoute(route);
  const length = route.waypoints.length;
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= length
    || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= length) {
    throw new RangeError('waypoint reorder index is out of range');
  }
  if (fromIndex === toIndex) return route;
  const waypoints = [...route.waypoints];
  const [waypoint] = waypoints.splice(fromIndex, 1);
  waypoints.splice(toIndex, 0, waypoint);
  return createRoute({ ...route, waypoints });
}

export function removeWaypoint(route, index) {
  assertRoute(route);
  if (!Number.isInteger(index) || index < 0 || index >= route.waypoints.length) {
    throw new RangeError('waypoint index is out of range');
  }
  return createRoute({
    ...route,
    waypoints: route.waypoints.filter((_, waypointIndex) => waypointIndex !== index),
  });
}
