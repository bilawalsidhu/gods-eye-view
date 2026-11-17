import {
  CLICK_PICK_WINDOW_PX,
  STREET_LEVEL_LAYER_ID,
  STREET_LEVEL_SET_PREFIX,
} from './policy.js';
import { inputFor } from '../../input/dispatcher.js';
import { toLonLatH } from '../../geo/index.js';

/** One click handler for every provider's lines and cones, and the marker. */
export function createSelection({ state, parts }) {
  const { picking } = state.services;

  /**
   * The pick id a click hit: a line part of ours answers for its sequence
   * (`meta.pick`); anything else by its own id.
   */
  function pickIdOf({ drawHit, id }) {
    if (drawHit?.set.startsWith(STREET_LEVEL_SET_PREFIX))
      return drawHit.meta?.pick ?? drawHit.id;
    return id;
  }

  /** The id carries a provider's prefix: that provider handles the pick. */
  function onClick(event) {
    if (!state.viewer || !state.enabled) return;
    const hit = event.windowHit(CLICK_PICK_WINDOW_PX, CLICK_PICK_WINDOW_PX);
    const windowId = pickIdOf(hit);
    // A coarse tap's touch contact (event.hit) reaches farther than this
    // window; a card or label over it yields to our item there, so it is ours.
    const contact = event.hit;
    const contactId =
      contact && !contact.surface
        ? pickIdOf({ drawHit: contact.set ? contact : null, id: event.id })
        : null;
    let route = parts.router.resolve(windowId);
    // Found only through our window, not as the contact (which is the exact
    // hit whenever there is one): another layer's card or label painted here
    // is that layer's click, since its handler never sees this window.
    // An item of ours that is the contact is still ours: that card yields
    // to it.
    if (route && windowId !== contactId) {
      const at = event.screenPosition;
      if (state.services.overlayHit?.(at?.x, at?.y)) {
        route = contactId ? parts.router.resolve(contactId) : null;
        if (!route) return;
      }
    }
    if (!route && contactId) route = parts.router.resolve(contactId);
    // Not ours: the ground handler decides whether it is the map itself.
    if (!route) {
      parts.openAtGround?.({ surface: hit.surface, ground: groundOf(event) });
      return;
    }
    // The position marker is the core's own: nothing to select.
    if (!route.instance) return;
    route.instance.handlePick(route.id, {
      groundPoint: () => groundPointOf(event),
    });
  }

  /** The world position under a click, measured when first asked; null over the sky. */
  const groundOf = (event) => () => event.ground();

  /** Lon/lat of the ground under a click, or null (sky). */
  function groundPointOf(event) {
    const position = event.ground();
    const ground = position && toLonLatH(position);
    return ground ? { lon: ground.lon, lat: ground.lat } : null;
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
    if (state.clickSubscription) return;
    state.clickSubscription = inputFor(viewer).onClick(onClick);
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(STREET_LEVEL_LAYER_ID, parts.router.ownsPick, {
      expanded: true,
      // The core's position marker is ours but selects nothing: a card over
      // it keeps the tap.
      passive: (id) => !parts.router.resolve(id)?.instance,
    });
  }

  function uninstall() {
    // Nothing to undo for a layer that was never enabled.
    if (!state.clickSubscription) return;
    state.clickSubscription();
    state.clickSubscription = null;
    document.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner?.(STREET_LEVEL_LAYER_ID);
  }

  return { install, uninstall, ownsPick: parts.router.ownsPick };
}
