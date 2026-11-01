import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The voice control as the command dock renders it. The voice control
 * presenter (src/voice/control.js) holds the control's state for the session
 * owners and publishes it here; the view sends clicks, keys and form changes
 * back to the connected presenter.
 */
export const useVoiceStore = defineStore('gev-voice', () => {
  /** The presented control; null while no voice session owns one. */
  const view = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  /** The presenter the view calls, or null while none is wired. */
  const controls = shallowRef(null);

  /** @param {?object} next The presenter, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  /**
   * The waveform's bars, apart from the view: they change every animation
   * frame while voice is live, and only the visualizer renders them.
   */
  const bars = shallowRef(null);

  /** @param {?Array<{level: string, opacity: string}>} next */
  function publishBars(next) {
    bars.value = next && markRaw(next);
  }

  return { view, publish, controls, connect, bars, publishBars };
});
