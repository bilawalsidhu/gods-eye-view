/** The selected train's kind in the shared world-focus framing. */
export const RAIL_FOCUS_KIND = 'train';

/**
 * The selected train's camera.
 *
 * A train the user picks is centred once, as every clicked moving thing is
 * (src/data/clickSelect.js): one fly-to through the shared world-focus
 * request that keeps the camera's distance and angle, the train sliding to
 * the centre. The camera does not follow it, moving or not: a drag, pan or
 * zoom afterwards moves the map and the train stays selected. Inside the
 * Cockpit that request is refused with its toast. Without a view to keep (no
 * camera pose), the shared world-focus framing for a train frames it.
 *
 * Services (optional; without them a selection has no camera):
 *   services.camera = {
 *     requestWorldFocus(detail) → boolean,  // src/worldFocus.js
 *   }
 *
 * @param {object} context
 * @returns {object}
 */
export function createFocus({ state, services }) {
  const camera = services.camera ?? null;

  function markerPosition(entry) {
    const p = entry?.marker?.position;
    return p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Number.isFinite(p.z) &&
      p.x * p.x + p.y * p.y + p.z * p.z > 0
      ? p
      : null;
  }

  /**
   * Centre a train the user selected, once.
   * @param {object} entry
   * @returns {boolean} Whether the camera was sent.
   */
  function focus(entry) {
    if (!camera || !entry) return false;
    const position = markerPosition(entry);
    if (!state._viewer || !position) return false;
    const label = String(entry.record?.label || entry.record?.id || '').trim();
    return (
      camera.requestWorldFocus?.({
        kind: RAIL_FOCUS_KIND,
        id: entry.key,
        label: label || entry.key,
        position: { x: position.x, y: position.y, z: position.z },
        keepView: true,
      }) === true
    );
  }

  return { focus };
}
