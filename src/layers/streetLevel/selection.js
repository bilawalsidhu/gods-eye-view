import * as geo from '../../geo/index.js';
import { CLICK_PICK_WINDOW_PX, STREET_LEVEL_LAYER_ID } from './policy.js';

/**
 * One click handler for every provider's lines and cones, and the marker,
 * on the display's engine, with a wider input pick window for thin lines.
 */
export function createSelection({ state, parts }) {
  const { picking, input } = state.services;

  /** The id carries a provider's prefix: that provider handles the pick. */
  function onClick(click) {
    const engine = state.map?.engine;
    if (!engine || !state.enabled || !click?.position) return;
    if (input?.isPointerFree && !input.isPointerFree()) return;
    const picked = click.picked;
    const id = picking?.resolvePickId
      ? picking.resolvePickId(picked)
      : picked?.id;
    const route = parts.router.resolve(id);
    // Not ours: the ground handler decides whether it is the map itself.
    if (!route) {
      parts.openAtGround?.(click.position, picked);
      return;
    }
    // The position marker is the core's own: nothing to select.
    if (!route.instance) return;
    route.instance.handlePick(route.id, {
      groundPoint: () => groundPointAt(engine, click.position),
    });
  }

  /** Lon/lat of the ground under a screen point, or null (sky, no picker). */
  function groundPointAt(engine, screenPosition) {
    const position = state.services.scenePick?.pickGroundPosition?.(
      engine,
      screenPosition,
    );
    const carto = position && geo.cartographic.fromCartesian(position);
    return carto
      ? {
          lon: geo.math.toDegrees(carto.longitude),
          lat: geo.math.toDegrees(carto.latitude),
        }
      : null;
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

  function install(map) {
    if (state.clickHandler || !map?.engine) return;
    state.clickHandler = map.engine.input.on('click', onClick, {
      pick: true,
      pickWindow: { width: CLICK_PICK_WINDOW_PX, height: CLICK_PICK_WINDOW_PX },
    });
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(
      STREET_LEVEL_LAYER_ID,
      parts.router.ownsPick,
      state.map?.engine,
    );
  }

  function uninstall() {
    // Nothing to undo for a layer that was never enabled.
    if (!state.clickHandler) return;
    state.clickHandler();
    state.clickHandler = null;
    document.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner?.(STREET_LEVEL_LAYER_ID, state.map?.engine);
  }

  return { install, uninstall, ownsPick: parts.router.ownsPick };
}
