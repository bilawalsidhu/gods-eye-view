import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * The visible map target list as its view renders it. The world overlay
 * (src/overlays/worldOverlay.js) presents the actionable cards it painted and
 * the last focus announcement; the application shell publishes them here and
 * connects the overlay's activation.
 */
export const useWorldOverlayActionsStore = defineStore(
  'gev-world-overlay-actions',
  () => {
    /**
     * `{owner, items: [{key, label, selected}], status}`, or null without an
     * overlay host. `owner` is passed back with each activation.
     */
    const [actions, publish] = presented();

    /** The controls whose `activate(owner, key)` a target button calls. */
    const [controls, connect] = presented();

    return { actions, publish, controls, connect };
  },
);
