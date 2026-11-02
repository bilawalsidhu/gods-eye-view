import { defineStore } from 'pinia';
import { onScopeDispose, shallowRef } from 'vue';
import { worldClock } from '../../time/worldClock.js';

/**
 * The world clock as the timeline shows it: `{live, playing, timeMs}`. It
 * follows the page's world clock, which tells it of every move, and of the
 * time a few times a second while it plays on its own.
 */
export const useWorldTimeStore = defineStore('gev-world-time', () => {
  const read = (state = worldClock.getState()) =>
    Object.freeze({
      live: state.live,
      playing: state.playing,
      timeMs: state.timeMs,
    });
  const time = shallowRef(read());
  onScopeDispose(
    worldClock.subscribe((state) => {
      time.value = read(state);
    }),
  );

  return {
    time,
    togglePlay: () => worldClock.togglePlay(),
    goLive: () => worldClock.goLive(),
  };
});
