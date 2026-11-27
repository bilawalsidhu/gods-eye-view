import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * The Street Level photo viewer (KartaView, Panoramax) as its view renders
 * it. The street-level layer presents it through `subscribePhotoViewer()`
 * and the application shell publishes each presentation here.
 */
export const useStreetLevelPhotoStore = defineStore(
  'gev-street-level-photo',
  () => {
    /**
     * `{host, mountKey, providerId, label, alt, kind, src, fit, canvasKey,
     * dragging, prevLabel, prevDisabled, nextLabel, nextDisabled, actions}`,
     * or null while no photo viewer is mounted. Of the viewers mounting in
     * the host, only the one mounted last (the largest `mountKey`) is
     * published; `actions.supersede()` tells the others they are not drawn
     * (see `ViewerAdapter.subscribeView` in src/layers/streetLevel/registry.js).
     */
    const [photo, publish] = presented();

    return { photo, publish };
  },
);
