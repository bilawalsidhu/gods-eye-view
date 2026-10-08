import * as Cesium from 'cesium';
import {
  PICK_PREFIX,
  POSITION_PICK_ID,
  STREET_LEVEL_LAYER_ID,
} from './policy.js';
import { sequenceIdFromPick } from './coverage.js';

/** One click handler for coverage lines, image cones and the marker. */
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

  function install(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state.clickHandler.setInputAction(
      onClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(STREET_LEVEL_LAYER_ID, ownsPick);
  }

  function uninstall() {
    // Nothing to undo for a layer that was never enabled.
    if (!state.clickHandler) return;
    if (!state.clickHandler.isDestroyed()) state.clickHandler.destroy();
    state.clickHandler = null;
    document.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner?.(STREET_LEVEL_LAYER_ID);
  }

  return { install, uninstall, ownsPick };
}
