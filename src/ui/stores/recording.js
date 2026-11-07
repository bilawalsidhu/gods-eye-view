import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * Recording composition as the scene chrome renders it. RecordingControls
 * publishes the safe frame a recording composes in.
 */
export const useRecordingStore = defineStore('gev-recording', () => {
  /** The recording's safe frame, '16:9' or '9:16'; null while none records. */
  const safeFrame = ref(null);

  /** @param {'16:9' | '9:16' | null} next */
  function publishSafeFrame(next) {
    safeFrame.value = next == null ? null : next === '9:16' ? '9:16' : '16:9';
  }

  return { safeFrame, publishSafeFrame };
});
