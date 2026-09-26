import * as Cesium from 'cesium';
import { STREET_LEVEL_LAYER_ID } from './policy.js';

/** One click/hover handler for every provider's coverage and image cones. */
export function createSelection({ state, parts }) {
  const { picking, input } = state.services;

  function ownsPick(pickedId) {
    return parts.router.ownsPick(pickedId);
  }

  function onClick(click) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled) return;
    if (input?.isPointerFree && !input.isPointerFree()) return;
    const picked = viewer.scene.pick(click.position);
    const id = picking?.resolvePickId
      ? picking.resolvePickId(picked)
      : picked?.id;
    const route = parts.router.resolve(id);
    if (!route?.instance) return;
    const entry = state.providers.get(route.providerId);
    if (!entry?.on) return;
    route.instance.handlePick(route.id);
  }

  /**
   * Esc clears the selected sequence, but only once nothing closer to the
   * user wants it: an expanded viewer, an open panel or a text field.
   */
  function onKeyDown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (
      event.target?.closest?.(
        '.panel-collapsible, [role="dialog"], input, textarea, select',
      )
    )
      return;
    if (!parts.hasSelectedSequence()) return;
    event.preventDefault();
    parts.clearSequences();
  }

  let hoverQueued = false;
  let hoverCursor = false;
  /** Pointer cursor over anything this layer owns, so lines read as clickable. */
  function onMove(movement) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled || hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const canvas = viewer.scene?.canvas;
      if (!canvas || viewer.isDestroyed?.()) return;
      let hit = false;
      try {
        const picked = viewer.scene.pick(movement.endPosition);
        const id = picking?.resolvePickId
          ? picking.resolvePickId(picked)
          : picked?.id;
        hit = ownsPick(id);
      } catch {
        hit = false;
      }
      if (hit && !hoverCursor) {
        canvas.style.cursor = 'pointer';
        hoverCursor = true;
      } else if (!hit && hoverCursor) {
        canvas.style.cursor = '';
        hoverCursor = false;
      }
    });
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
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(STREET_LEVEL_LAYER_ID, ownsPick);
  }

  function uninstall() {
    // Nothing to undo for a layer that was never enabled.
    if (!state.clickHandler) return;
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
