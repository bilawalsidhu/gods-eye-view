// Static credits on the viewer's credit display.

import * as Cesium from 'cesium';

/**
 * @param {Cesium.Viewer} viewer
 * @returns {{ credits: { addStatic: (html: string, options?: { onScreen?: boolean }) => () => void }, destroy: () => void }}
 */
export function createCesiumCredits(viewer) {
  const added = new Set();
  // Viewer.creditDisplay is the scene frame state's display.
  const display = () =>
    viewer.creditDisplay ?? viewer.scene?.frameState?.creditDisplay;
  const remove = (credit) => {
    if (!added.delete(credit)) return;
    display()?.removeStaticCredit(credit);
  };
  return {
    credits: {
      addStatic(html, { onScreen = false } = {}) {
        const credit = new Cesium.Credit(html, Boolean(onScreen));
        display().addStaticCredit(credit);
        added.add(credit);
        return () => remove(credit);
      },
    },
    destroy() {
      for (const credit of [...added]) remove(credit);
    },
  };
}
