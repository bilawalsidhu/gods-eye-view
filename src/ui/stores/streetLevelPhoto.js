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
     * `{host, providerId, label, alt, kind, src, fit, canvasKey, dragging,
     * prevLabel, prevDisabled, nextLabel, nextDisabled, actions}`, or null
     * while no photo viewer is mounted.
     */
    const photo = shallowRef(null);

    /** @param {?object} next A fresh presentation; every publish re-renders. */
    function publish(next) {
      photo.value = next && markRaw(next);
    }

    return { photo, publish };
  },
);
