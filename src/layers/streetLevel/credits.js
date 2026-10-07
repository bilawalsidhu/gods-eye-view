import * as Cesium from 'cesium';

/**
 * A static Cesium credit shown while the layer draws: CC BY-SA imagery needs
 * visible attribution that goes away with the imagery.
 */
export function createCredit(html) {
  let shown = null;

  function show(viewer) {
    if (shown || !viewer?.creditDisplay) return;
    try {
      const credit = new Cesium.Credit(html, true);
      viewer.creditDisplay.addStaticCredit(credit);
      shown = credit;
    } catch {
      /* credit display unavailable */
    }
  }

  function hide(viewer) {
    if (!shown) return;
    try {
      viewer?.creditDisplay?.removeStaticCredit?.(shown);
    } catch {
      /* credit display already torn down */
    }
    shown = null;
  }

  return { show, hide };
}
