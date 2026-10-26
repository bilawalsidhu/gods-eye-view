/**
 * Format a compass direction for the awareness overlay.
 * @param {number} degrees
 * @returns {string}
 */
export function formatAwarenessDirection(degrees) {
  if (!Number.isFinite(degrees)) return '—';
  const normalized = ((degrees % 360) + 360) % 360;
  return String(Math.round(normalized) % 360).padStart(3, '0');
}
