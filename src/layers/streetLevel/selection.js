import * as Cesium from 'cesium';
import { CLICK_PICK_WINDOW_PX, STREET_LEVEL_LAYER_ID } from './policy.js';

/** One click handler for every provider's lines and cones, and the marker. */
export function createSelection({ state, parts }) {
  const { picking, input } = state.services;

  /** The id carries a provider's prefix: that provider handles the pick. */
  function onClick(click) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled) return;
    if (input?.isPointerFree && !input.isPointerFree()) return;
    const picked = viewer.scene.pick(
      click.position,
      CLICK_PICK_WINDOW_PX,
      CLICK_PICK_WINDOW_PX,
    );
    const id = picking?.resolvePickId
      ? picking.resolvePickId(picked)
      : picked?.id;
    const hit = parts.router.resolve(id);
    // The position marker is the core's own: nothing to select.
    if (hit?.instance) hit.instance.handlePick(hit.id);
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
    if (!parts.hasSelectedSequence()) return;
    event.preventDefault();
    parts.clearSequences();
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
    picking?.registerPickOwner?.(STREET_LEVEL_LAYER_ID, parts.router.ownsPick);
  }

  function uninstall() {
    // Nothing to undo for a layer that was never enabled.
    if (!state.clickHandler) return;
    if (!state.clickHandler.isDestroyed()) state.clickHandler.destroy();
    state.clickHandler = null;
    document.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner?.(STREET_LEVEL_LAYER_ID);
  }

  return { install, uninstall, ownsPick: parts.router.ownsPick };
}
