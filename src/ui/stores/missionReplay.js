import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * The Space Missions replay vehicle overlay as its view renders it. The
 * launches layer presents it through `subscribeReplayOverlay()` and the
 * application shell publishes each presentation here.
 */
export const useMissionReplayStore = defineStore('gev-mission-replay', () => {
  /**
   * `{visible, mode, thrusting, paused, transform, rotation, iconOpacity,
   * labelOpacity, title, detail}`, or null while the layer has no overlay.
   */
  const [overlay, publish] = presented();

  return { overlay, publish };
});
