import { storeToRefs } from 'pinia';
import { computed, nextTick, watch } from 'vue';
import { t } from '../i18n/index.js';
import { useLiveStore } from './stores/live.js';

/**
 * What the LIVE section in Context and the Cockpit briefing's LIVE page
 * share: the live store's view, its state read as words, and the rule that
 * starts the stream. Each view calls this from its setup and renders the
 * result; the controls call LiveControls through `act`.
 */
export function useLiveScreen() {
  const store = useLiveStore();
  const { act } = store;
  const { view } = storeToRefs(store);
  const playing = computed(() => view.value?.state === 'playing');
  const loading = computed(() => view.value?.state === 'loading');
  const offline = computed(() => view.value?.state === 'offline');
  const unavailable = computed(() => view.value?.state === 'unavailable');
  const badgeText = computed(() => (playing.value ? t('ON AIR') : t('OFF')));
  const statusText = computed(() => {
    switch (view.value?.state) {
      case 'playing':
        return t('Live');
      case 'offline':
        return t('Stream is offline');
      case 'unavailable':
        return t('This stream cannot play here');
      default:
        return t('Starting…');
    }
  });

  // Start the stream as soon as one is chosen and nothing plays, once the
  // screen is in the page (the player is built into it). Which screen is
  // LiveControls' choice, and asking from both views starts nothing twice.
  // A stream that went offline or cannot play stays as it is until Try again.
  watch(
    [() => view.value?.current?.id ?? null, () => view.value?.state ?? null],
    async ([streamId, state]) => {
      if (!streamId || state !== 'idle') return;
      await nextTick();
      act('playLive');
    },
    { immediate: true, flush: 'post' },
  );

  return {
    view,
    act,
    playing,
    loading,
    offline,
    unavailable,
    badgeText,
    statusText,
  };
}
