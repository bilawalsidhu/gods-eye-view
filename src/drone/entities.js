function provenance() {
  return Object.freeze({ simulated: true, source: 'synthetic-drone-mission' });
}

export function createDroneEntitySnapshot(telemetry, { id = 'simulated-drone' } = {}) {
  if (!Number.isFinite(telemetry?.latitude) || !Number.isFinite(telemetry?.longitude)) {
    throw new TypeError('complete telemetry is required');
  }
  return Object.freeze({
    id,
    type: 'drone',
    simulated: true,
    provenance: provenance(),
    position: Object.freeze({
      latitude: telemetry.latitude,
      longitude: telemetry.longitude,
      altitudeMsl: telemetry.altitudeMsl,
    }),
    orientation: Object.freeze({ headingDegrees: telemetry.headingDegrees }),
    properties: Object.freeze({
      altitudeAgl: telemetry.altitudeAgl,
      groundSpeedMps: telemetry.groundSpeedMps,
      distanceFlownMeters: telemetry.distanceFlownMeters,
      distanceRemainingMeters: telemetry.distanceRemainingMeters,
      etaSeconds: telemetry.etaSeconds,
      currentSegment: telemetry.currentSegment,
      missionState: telemetry.missionState,
    }),
  });
}

export function createMissionEntitySnapshots({
  route,
  profile,
  telemetry,
  missionId = 'synthetic-mission',
  droneId = 'simulated-drone',
}) {
  if (!route || !profile?.vertices) throw new TypeError('route and profile are required');
  const routeEntity = Object.freeze({
    id: `${missionId}-route`,
    type: 'polyline',
    simulated: true,
    provenance: provenance(),
    positions: Object.freeze(profile.vertices.map((vertex) => Object.freeze({
      latitude: vertex.latitude,
      longitude: vertex.longitude,
      altitudeMsl: vertex.altitudeMsl,
    }))),
    properties: Object.freeze({ missionId }),
  });
  const destinationPosition = route.destination.type === 'area'
    ? route.destination.center
    : route.destination.point;
  const destinationEntity = Object.freeze({
    id: `${missionId}-destination`,
    type: route.destination.type === 'area' ? 'area' : 'point',
    simulated: true,
    provenance: provenance(),
    position: Object.freeze({ ...destinationPosition }),
    ...(route.destination.type === 'area'
      ? { radiusMeters: route.destination.radiusMeters }
      : {}),
    properties: Object.freeze({ missionId }),
  });
  return Object.freeze([
    createDroneEntitySnapshot(telemetry, { id: droneId }),
    routeEntity,
    destinationEntity,
  ]);
}
