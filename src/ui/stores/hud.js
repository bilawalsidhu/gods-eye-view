import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Intel HUD as its view renders it. IntelHUD presents its readouts,
 * visibility, layout variant and style colors and the application shell
 * publishes them here. The view reports whether it is on screen, and the
 * store passes that to the connected IntelHUD.
 */
export const useHudStore = defineStore('gev-hud', () => {
  /** The presented HUD, frozen by IntelHUD; null until it is built. */
  const hud = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    hud.value = next;
  }

  /**
   * Whether the view is on screen: false while a stylesheet gives
   * `#intel-hud` or a parent `display: none`, and once the view is
   * unmounted. True until a view first says.
   */
  const displayed = shallowRef(true);

  /** The IntelHUD told when `displayed` changes, or null. */
  const owner = shallowRef(null);

  /** @param {boolean} next Whether the view is on screen. */
  function setDisplayed(next) {
    if (displayed.value === next) return;
    displayed.value = next;
    owner.value?.setDisplayed?.(next);
  }

  /**
   * Tell `next` whether the view is on screen, now and on every change.
   * @param {?{setDisplayed?: (displayed: boolean) => void}} next IntelHUD, or
   *   null to disconnect.
   */
  function connect(next) {
    owner.value = next && markRaw(next);
    next?.setDisplayed?.(displayed.value);
  }

  return { hud, publish, displayed, setDisplayed, owner, connect };
});
