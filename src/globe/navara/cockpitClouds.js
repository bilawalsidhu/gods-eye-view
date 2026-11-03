// The cloud cover port createNavaraEngine takes (render.setCloudCover): the
// cockpit's weather clouds drawn by Navara's own volumetric clouds, the
// look's cloud effect (look.js), instead of a second WebGL canvas. Only a
// look that draws clouds has it (the cinematic look; not on a
// mobile-optimized view). Destroying it gives the look its own cover back.

/**
 * @param {{ hasClouds: boolean, setCloudCoverage: (coverage: number | null) => boolean }} look
 * @returns {{ set: (state: { coverage: number | null }) => void, destroy: () => void } | null}
 */
export function createNavaraCloudCover(look) {
  if (!look?.hasClouds) return null;
  return {
    set({ coverage }) {
      look.setCloudCoverage(coverage);
    },
    destroy() {
      look.setCloudCoverage(null);
    },
  };
}
