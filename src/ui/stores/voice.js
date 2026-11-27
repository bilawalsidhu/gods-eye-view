import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';
import { presented } from './presented.js';

/**
 * The voice control as the command dock renders it. The voice control
 * presenter (src/voice/control.js) holds the control's state for the session
 * owners and publishes it here; the view sends clicks, keys and form changes
 * back to the connected presenter.
 */
export const useVoiceStore = defineStore('gev-voice', () => {
  /** The presented control; null while no voice session owns one. */
  const [view, publish] = presented();

  /** The presenter the view calls, or null while none is wired. */
  const [controls, connect] = presented();

  /**
   * The waveform's bars, apart from the view: they change every animation
   * frame while voice is live, and only the visualizer renders them.
   */
  const [bars, publishBars] = presented();

  /**
   * The chat conversation, apart from the view: a typed reply reveals frame
   * by frame, and only the message list renders it.
   */
  const chat = shallowRef([]);

  /** @param {Array<{id: number, role: string, text: string}>} next */
  function publishChat(next) {
    chat.value = markRaw(next ?? []);
  }

  return {
    view,
    publish,
    controls,
    connect,
    bars,
    publishBars,
    chat,
    publishChat,
  };
});
