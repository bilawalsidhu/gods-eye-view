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

  /** The pointer over the globe, and whether a frame is queued to pick it. */
  let pointer = null;
  let hoverQueued = false;
  let hoverCursor = false;
  /** Buttons held: any of them, with any modifier, is a camera drag. */
  let pointerButtons = 0;
  let removeHoverWatchers = null;

  function setHoverCursor(canvas, hit) {
    if (hit === hoverCursor) return;
    canvas.style.cursor = hit ? 'pointer' : '';
    hoverCursor = hit;
  }

  function pickHover() {
    hoverQueued = false;
    const canvas = state.viewer?.scene?.canvas;
    // Switched off (or torn down) since the frame was queued, or dragging.
    if (!canvas || !state.enabled || !state.clickHandler || pointerButtons)
      return;
    let hit = false;
    try {
      const picked = state.viewer.scene.pick(pointer);
      hit = ownsPick(
        picking?.resolvePickId ? picking.resolvePickId(picked) : picked?.id,
      );
    } catch {
      hit = false;
    }
    setHoverCursor(canvas, hit);
  }

  /** Pick the pointer on the next frame; at most one pick a frame. */
  function queueHoverPick() {
    if (hoverQueued || !pointer || pointerButtons) return;
    hoverQueued = true;
    requestAnimationFrame(pickHover);
  }

  /** Pointer cursor over anything this layer owns. */
  function onMove(movement) {
    if (!state.enabled) return;
    pointer = Cesium.Cartesian2.clone(movement.endPosition, pointer);
    queueHoverPick();
  }

  /** Track held buttons, and pick again once the camera rests under a still pointer. */
  function watchHover(viewer) {
    const canvas = viewer.scene.canvas;
    const onButtons = (event) => {
      pointerButtons = event.buttons ?? 0;
    };
    const types = ['pointerdown', 'pointermove', 'pointerup'];
    for (const type of types) canvas.addEventListener?.(type, onButtons);
    const removeEnd = viewer.camera?.moveEnd?.addEventListener(queueHoverPick);
    removeHoverWatchers = () => {
      for (const type of types) canvas.removeEventListener?.(type, onButtons);
      removeEnd?.();
    };
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
    watchHover(viewer);
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(STREET_LEVEL_LAYER_ID, ownsPick);
  }

  function uninstall() {
    // Nothing to undo for a layer that was never enabled.
    if (!state.clickHandler) return;
    removeHoverWatchers?.();
    removeHoverWatchers = null;
    pointer = null;
    pointerButtons = 0;
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
