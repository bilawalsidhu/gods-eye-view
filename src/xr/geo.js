import * as THREE from 'three';

export const EARTH_RADIUS_M = 6371000;
export const GLOBE_RADIUS = 0.6;
export const MAX_CONTACTS = 1500;

export function validCoordinates(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 180
  );
}

/** Three's sphere UV convention: Greenwich is +X; west faces +Z. */
export function geoPosition(
  lat,
  lon,
  radius = GLOBE_RADIUS,
  target = new THREE.Vector3(),
) {
  const phi = (lat * Math.PI) / 180,
    theta = (lon * Math.PI) / 180;
  return target.set(
    radius * Math.cos(phi) * Math.cos(theta),
    radius * Math.sin(phi),
    -radius * Math.cos(phi) * Math.sin(theta),
  );
}

export function positionGeo(point) {
  const radius = point.length();
  if (!radius) return null;
  return {
    lat:
      (Math.asin(THREE.MathUtils.clamp(point.y / radius, -1, 1)) * 180) /
      Math.PI,
    lon: (Math.atan2(-point.z, point.x) * 180) / Math.PI,
  };
}

export function focusQuaternion(lat, lon) {
  return new THREE.Quaternion().setFromUnitVectors(
    geoPosition(lat, lon, 1),
    new THREE.Vector3(0, 0, 1),
  );
}

/** Stable spatial sampling retains coverage instead of taking the first N rows. */
export function sampleContacts(records, limit = MAX_CONTACTS) {
  const rows = records.filter((r) => validCoordinates(r.lat, r.lon));
  if (rows.length <= limit) return rows;
  return Array.from(
    { length: limit },
    (_, i) => rows[Math.floor((i * rows.length) / limit)],
  );
}

export function markerRadius(record) {
  // Aircraft get a readable lift; orbital heights retain their physical ratio.
  return record.layer === 'satellites'
    ? GLOBE_RADIUS * (1 + Math.max(0, record.altitudeM || 0) / EARTH_RADIUS_M)
    : GLOBE_RADIUS + (record.layer === 'flights' ? 0.018 : 0.006);
}

export const REGIONS = [
  { name: 'Americas', lat: 20, lon: -85 },
  { name: 'Europe', lat: 48, lon: 15 },
  { name: 'Asia Pacific', lat: 20, lon: 120 },
  { name: 'Middle East', lat: 27, lon: 45 },
  { name: 'Africa', lat: 3, lon: 20 },
];
