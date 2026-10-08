/**
 * A subtle reticle at the point "this" resolved to, shown while the turn is
 * live so the user sees what was understood before the answer.
 *
 * It is a fixed-position overlay (pointer-events: none) placed from the
 * snapshot's canvas pixels, so it never touches the Cesium scene. The reticle
 * marks where the user pointed, not a tracked world position: it leaves as
 * soon as a tool moves the camera, when the reply completes, when the session
 * ends, and after {@link RETICLE_MAX_MS} at most. Clean-UI and recording mode
 * hide it through CSS.
 */

export const RETICLE_MAX_MS = 10000;
export const RETICLE_LINGER_MS = 1500;

/** Tools that move the camera away from the pointed spot. */
export const CAMERA_TOOLS = new Set([
  'fly_to_location',
  'track_entity',
  'zoom_to_globe',
  'adjust_camera_zoom',
  'move_camera',
  'fly_route',
  'frame_overhead',
  'select_nearest_aircraft',
  'control_cockpit',
]);

export class PointerReticle {
  /**
   * @param {object} options
   * @param {Document} options.doc Document that owns the overlay.
   * @param {() => {left: number, top: number}|null} options.rectOf Canvas
   *   client rect, read at show time.
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor({
    doc,
    rectOf,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  }) {
    Object.assign(this, { doc, rectOf, setTimer, clearTimer });
    this.node = null;
    this.timer = null;
    // Tools running in this turn, keyed by call id (name when absent).
    this.running = new Set();
    this.visible = false;
    this.destroyed = false;
  }

  ensureNode() {
    if (this.node || !this.doc?.createElement) return this.node;
    const node = this.doc.createElement('div');
    node.className = 'gev-pointer-reticle';
    node.setAttribute?.('aria-hidden', 'true');
    node.hidden = true;
    this.doc.body?.appendChild?.(node);
    this.node = node;
    return node;
  }

  schedule(ms) {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.hide();
    }, ms);
  }

  cancelTimer() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Show at a snapshot's canvas pixels. */
  show(pointer) {
    if (this.destroyed || !pointer?.screenPx) return;
    const rect = this.rectOf?.();
    const node = this.ensureNode();
    if (!rect || !node) return;
    node.style.left = `${Math.round(rect.left + pointer.screenPx.x)}px`;
    node.style.top = `${Math.round(rect.top + pointer.screenPx.y)}px`;
    node.dataset.target = pointer.kind === 'this' ? 'entity' : 'ground';
    node.hidden = false;
    this.visible = true;
    this.running.clear();
    this.schedule(RETICLE_MAX_MS);
  }

  hide() {
    this.cancelTimer();
    this.running.clear();
    if (!this.visible) return;
    this.visible = false;
    if (this.node) this.node.hidden = true;
  }

  /** Follow provider-neutral session events. */
  handle(event) {
    if (this.destroyed || !event?.type) return;
    switch (event.type) {
      case 'pointer':
        if (event.pointer) this.show(event.pointer);
        else this.hide();
        return;
      case 'state':
        if (['idle', 'error'].includes(event.state)) this.hide();
        return;
      case 'action-call':
        if (!this.visible) return;
        if (CAMERA_TOOLS.has(event.name)) this.hide();
        else this.running.add(event.callId || event.name);
        return;
      case 'action-result':
        this.running.delete(event.callId || event.name);
        return;
      case 'completion':
        if (this.visible && this.running.size === 0)
          this.schedule(RETICLE_LINGER_MS);
        return;
      default:
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.hide();
    this.destroyed = true;
    this.node?.remove?.();
    this.node = null;
  }
}
