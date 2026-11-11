import {
  DEFAULT_CAPACITY,
  POINT_SIZE_MIN,
  POINT_SIZE_MAX,
  COLOR_NEUTRAL,
  COLOR_MUTED,
  COLOR_GREEN,
  COLOR_YELLOW,
  COLOR_RED,
} from './policy.js';

export function resolveCapacity(model, capacityFromInfo, status) {
  const fromInfo = model.toNonNegativeInteger(capacityFromInfo);
  if (fromInfo && fromInfo > 0) return fromInfo;
  const bikes = model.toNonNegativeInteger(status?.bikesAvailable, 0);
  const docks = model.toNonNegativeInteger(status?.docksAvailable, 0);
  return bikes + docks || DEFAULT_CAPACITY;
}

export function capacityToPixelSize(capacity) {
  const value = Math.max(1, Math.min(80, Number(capacity) || DEFAULT_CAPACITY));
  const normalized = Math.sqrt(value) / Math.sqrt(80);
  const size = POINT_SIZE_MIN + normalized * (POINT_SIZE_MAX - POINT_SIZE_MIN);
  return Math.max(POINT_SIZE_MIN, Math.min(POINT_SIZE_MAX, size));
}

export function statusToColor(model, status, capacity) {
  if (!status) return COLOR_NEUTRAL;
  if (!status.isInstalled || !status.isRenting || !status.isReturning)
    return COLOR_MUTED;
  const bikes = model.toNonNegativeInteger(status.bikesAvailable);
  if (!Number.isFinite(bikes)) return COLOR_NEUTRAL;
  const resolvedCapacity = Math.max(1, Number(capacity) || DEFAULT_CAPACITY);
  const ratio = bikes / resolvedCapacity;
  if (ratio > 0.6) return COLOR_GREEN;
  if (ratio >= 0.3) return COLOR_YELLOW;
  return COLOR_RED;
}
