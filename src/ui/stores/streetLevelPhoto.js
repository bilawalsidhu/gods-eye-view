import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

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
    const photo = shallowRef(null);

    /** @param {?object} next A fresh presentation; every publish re-renders. */
    function publish(next) {
      photo.value = next && markRaw(next);
    }

    return { photo, publish };
  },
);
