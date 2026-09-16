/**
 * Panel viewport clamping (docs/PLAN.md Phase 7, PR #215) — the pure math
 * shared by the drag handler and the localStorage position restore in ui.js.
 * Both callers must clamp or a position saved at one window size lands
 * off-screen at another (audit U2: a panel restored at x:-192 was
 * unreachable until the panel store was cleared).
 *
 * A panel larger than the viewport cannot fit inside the inset; the inset
 * floor wins (Math.max), so the panel's top-left corner is always at least
 * `inset` px on-screen and its drag handle stays reachable.
 */

/** Keep-out distance from every viewport edge, in px (matches the drag clamp). */
export const PANEL_VIEWPORT_INSET_PX = 6;

/**
 * Clamp a desired left/top so the panel stays on-screen.
 * @param {{left: number, top: number, width: number, height: number}} panel
 *   Desired position plus the panel's current box size.
 * @param {{width: number, height: number}} viewport Window inner size.
 * @param {number} [inset] Edge keep-out, defaults to PANEL_VIEWPORT_INSET_PX.
 * @returns {{left: number, top: number}} Clamped position; when the panel is
 *   larger than the viewport the `inset` floor wins, so its top-left corner
 *   is still `inset` px on-screen.
 */
export function clampPanelToViewport({ left, top, width, height }, { width: viewportWidth, height: viewportHeight }, inset = PANEL_VIEWPORT_INSET_PX) {
  const maxLeft = Math.max(inset, viewportWidth - width - inset);
  const maxTop = Math.max(inset, viewportHeight - height - inset);
  return {
    left: Math.max(inset, Math.min(maxLeft, left)),
    top: Math.max(inset, Math.min(maxTop, top)),
  };
}
