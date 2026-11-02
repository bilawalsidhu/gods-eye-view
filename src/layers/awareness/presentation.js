import { roundHeadingDegrees } from '../../data/headingDegrees.js';

/**
 * Format a compass direction for the awareness overlay.
 * @param {number} degrees
 * @returns {string}
 */
export function formatAwarenessDirection(degrees) {
  if (!Number.isFinite(degrees)) return '—';
  return String(roundHeadingDegrees(degrees)).padStart(3, '0');
}
