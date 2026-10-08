import * as Cesium from 'cesium';
import { POSITION_PICK_ID, STREET_LEVEL_LAYER_ID } from './policy.js';
import { PICK_PREFIX } from './providers/mapillary/policy.js';
import { sequenceIdFromPick } from './providers/mapillary/coverage.js';

/** One click/hover handler for coverage lines, image cones and the marker. */
export function createSelection({ state, parts }) {
  const { picking, input } = state.services;

  /** Lines and cones (`mly:`) and the position marker are this layer's. */
  function ownsPick(id) {
    return (
      typeof id === 'string' &&
      (id === POSITION_PICK_ID || id.startsWith(PICK_PREFIX.root))
    );
  }

  /** A line selects its sequence; a cone opens its image. */
  function onClick(click) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled || !state.providerOn) return;
    if (input?.isPointerFree && !input.isPointerFree()) return;
    const picked = viewer.scene.pick(click.position);
    const id = picking?.resolvePickId
      ? picking.resolvePickId(picked)
      : picked?.id;
    if (typeof id !== 'string') return;
    const sequenceId = sequenceIdFromPick(id);
    if (sequenceId) parts.sequences.select(sequenceId);
    else if (id.startsWith(PICK_PREFIX.image))
      parts.openImage(id.slice(PICK_PREFIX.image.length));
  }

  /**
   * Esc clears the selected sequence, but only once nothing closer to the
   * user wants it: an expanded viewer, an open panel or a text field.
   */
  function onKeyDown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // A text field keeps its Esc, rich-text editors (contenteditable) included.
    const target = event.target;
    if (
      target?.isContentEditable === true ||
      target?.closest?.(
        '.panel-collapsible, [role="dialog"], input, textarea, select',
      )
    )
      return;
    if (!state.sequence.selectedId) return;
    event.preventDefault();
    parts.sequences.clearSelection();
  }

  /** Where the pointer is, until a frame picks it; a drag picks nothing. */
  let hoverPosition = null;
  let hoverCursor = false;
  let dragging = false;

  function setHoverCursor(canvas, hit) {
    if (hit === hoverCursor) return;
    canvas.style.cursor = hit ? 'pointer' : '';
    hoverCursor = hit;
  }

  function pickHover() {
    const position = hoverPosition;
    hoverPosition = null;
    const canvas = state.viewer?.scene?.canvas;
    // Switched off (or torn down) since the frame was queued.
    if (!canvas || !state.enabled || !state.clickHandler || dragging) return;
    let hit = false;
    try {
      const picked = state.viewer.scene.pick(position);
      hit = ownsPick(
        picking?.resolvePickId ? picking.resolvePickId(picked) : picked?.id,
      );
    } catch {
      hit = false;
    }
    setHoverCursor(canvas, hit);
  }

  /** Pointer cursor over anything this layer owns, picked at most once a frame. */
  function onMove(movement) {
    if (!state.enabled || dragging) return;
    if (!hoverPosition) requestAnimationFrame(pickHover);
    hoverPosition = Cesium.Cartesian2.clone(movement.endPosition);
  }

  function install(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state.clickHandler.setInputAction(
      onClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    state.clickHandler.setInputAction(
      onMove,
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );
    state.clickHandler.setInputAction(() => {
      dragging = true;
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    state.clickHandler.setInputAction(() => {
      dragging = false;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(STREET_LEVEL_LAYER_ID, ownsPick);
  }

  function uninstall() {
    // Nothing to undo for a layer that was never enabled.
    if (!state.clickHandler) return;
    hoverPosition = null;
    dragging = false;
    if (hoverCursor && state.viewer?.scene?.canvas) {
      state.viewer.scene.canvas.style.cursor = '';
      hoverCursor = false;
    }
    if (state.clickHandler && !state.clickHandler.isDestroyed())
      state.clickHandler.destroy();
    state.clickHandler = null;
    document.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner?.(STREET_LEVEL_LAYER_ID);
  }

  return { install, uninstall, ownsPick };
}
