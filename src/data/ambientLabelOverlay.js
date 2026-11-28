/**
 * The world-overlay entry an ambient label layer publishes for one point,
 * and the cap that keeps the most important of them. Pure, no imports.
 */

/**
 * One ambient label: a non-interactive title above its anchor, keyhole-faded
 * and horizon-culled, competing for the shared ambient-label budget.
 * @param {{id: *, position: object, title: string, accent: string,
 *   priority: number, gapPx: number}} input
 * @returns {object}
 */
export function ambientLabelEntry({
  id,
  position,
  title,
  accent,
  priority,
  gapPx,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * The highest-priority entries, at most `limit` (itself capped at
 * `maxLimit`), with stable identity as the tie-break.
 * @param {Array<{id: *, priority: number}>} entries
 * @param {number} limit
 * @param {number} maxLimit
 * @returns {Array<object>}
 */
export function topByPriority(entries, limit, maxLimit) {
  const cap = Math.max(0, Math.min(maxLimit, Math.floor(Number(limit) || 0)));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}
