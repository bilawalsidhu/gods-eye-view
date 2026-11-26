import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../i18n/index.js';
import { useLiveStore } from './stores/live.js';

/**
 * What the LIVE section in Context and the Cockpit briefing's LIVE page
 * share: the live store's view and its state read as words. Each view calls
 * this from its setup and renders the result; the controls call LiveControls
 * through `act`. Nothing here starts the stream: the views show Play while
 * it is `idle`, and the player is loaded only when the viewer presses it.
 */
export function useLiveScreen() {
  const store = useLiveStore();
  const { act } = store;
  const { view } = storeToRefs(store);
  const playing = computed(() => view.value?.state === 'playing');
  const loading = computed(() => view.value?.state === 'loading');
  const offline = computed(() => view.value?.state === 'offline');
  const unavailable = computed(() => view.value?.state === 'unavailable');
  const idle = computed(
    () => Boolean(view.value) && view.value.state === 'idle',
  );
  const badgeText = computed(() =>
    playing.value ? t('ON AIR') : loading.value ? t('LOADING') : t('OFF'),
  );
  const statusText = computed(() => {
    switch (view.value?.state) {
      case 'playing':
        return t('Live');
      case 'offline':
        return t('Stream is offline');
      case 'unavailable':
        return t('This stream cannot play here');
      case 'loading':
        return t('Starting…');
      default:
        return t('Click to play');
    }
  });

  return {
    view,
    act,
    idle,
    playing,
    loading,
    offline,
    unavailable,
    badgeText,
    statusText,
  };
}
