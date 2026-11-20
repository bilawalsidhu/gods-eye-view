<script setup>
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import RailPanel from '../../rail/RailPanel.vue';
import { vClassToggle } from '../../rail/classToggle.js';
import { useLiveScreen } from '../../liveScreen.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';

// The LIVE section inside Context: the live streams attached to the selected
// object (LiveControls publishes them), one at a time in the platform's own
// player. It is there only while the selection has a stream. The player is
// loaded only when the viewer presses Play, under the notice that YouTube
// sees their IP address; collapsing the section, collapsing Context, or the
// section leaving the page stops it. Its controls call LiveControls through
// the store.
const PANEL_ID = 'live-panel';
const {
  view,
  act,
  idle,
  playing,
  loading,
  offline,
  unavailable,
  badgeText,
  statusText,
} = useLiveScreen();
// Nothing plays unseen: a hidden section gives up its player.
const { panels } = storeToRefs(usePanelChromeStore());
const hidden = computed(
  () =>
    (panels.value[PANEL_ID]?.collapsed ?? true) ||
    panels.value['global-context-panel']?.collapsed === true,
);
watch(hidden, (now) => {
  if (now) act('hideLive', 'section');
});
onBeforeUnmount(() => act('hideLive', 'section'));
const liveWords = computed(() => ({
  expandLabel: t('Expand Live section'),
  collapseLabel: t('Collapse Live section'),
  expandTitle: t('Expand Live'),
  collapseTitle: t('Collapse Live'),
}));
</script>

<template>
<RailPanel :id="PANEL_ID" tag="section" start-collapsed :hidden="!view" v-class-toggle="{ 'live-on-air': playing }" :aria-label="t('Live streams for the selected object')" :title="t('LIVE')" :toggle-words="liveWords" :glow="false" scroll>
  <template #badge><span class="live-badge"><span class="live-dot" :class="{ 'on-air': playing, waiting: loading }" aria-hidden="true"></span><span id="live-badge-text">{{ badgeText }}</span></span></template>
  <template v-if="view">
    <div class="live-subject">{{ view.label }}</div>
    <div class="live-pick" role="group" :aria-label="t('Stream')">
      <UiButton v-if="view.count > 1" id="live-previous-btn" type="button" class="live-step" @click="act('cycleLive', -1)" :aria-label="t('Previous stream')" :title="t('Previous stream')"><UiIcon name="chevron_left" :size="null" /></UiButton>
      <span id="live-stream-title" class="live-stream-title" aria-live="polite">{{ t(view.current.title) }}<small v-if="view.count > 1"> · {{ view.index + 1 }}/{{ view.count }}</small></span>
      <UiButton v-if="view.count > 1" id="live-next-btn" type="button" class="live-step" @click="act('cycleLive', 1)" :aria-label="t('Next stream')" :title="t('Next stream')"><UiIcon name="chevron_right" :size="null" /></UiButton>
    </div>
    <p class="live-privacy">{{ t('Video plays from YouTube, which sees your IP address.') }}</p>
    <!-- The player's element stays put across re-renders: LiveControls mounts the player in it. -->
    <div class="live-screen" :class="{ active: playing || loading }">
      <div id="live-player-host" class="live-player-host"></div>
      <UiButton v-if="idle" id="live-play-btn" class="live-play" @click="act('playLive')"><UiIcon name="play_arrow" :size="null" />{{ t('Play') }}</UiButton>
      <div v-if="offline || unavailable" class="live-card" :class="{ offline, unavailable }">
        <span class="live-card-dot" aria-hidden="true"></span>
        <strong>{{ offline ? t('Stream is offline') : t('This stream cannot play here') }}</strong>
        <UiButton v-if="offline" id="live-retry-btn" @click="act('retryLive')">{{ t('Try again') }}</UiButton>
      </div>
    </div>
    <p id="live-status" class="live-status" role="status" aria-live="polite">{{ statusText }}</p>
    <p class="live-credit"><a :href="view.current.ownerUrl" target="_blank" rel="noopener noreferrer">{{ view.current.owner }}</a> · <a id="live-watch-link" :href="view.current.watchUrl" target="_blank" rel="noopener noreferrer">{{ t('Open on YouTube') }}</a></p>
  </template>
</RailPanel>
</template>
