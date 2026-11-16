<script setup>
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import RailPanel from '../../rail/RailPanel.vue';
import { vClassToggle } from '../../rail/classToggle.js';
import { useLiveScreen } from '../../liveScreen.js';

// The LIVE section inside Context: the live streams attached to the selected
// object (LiveControls publishes them), one at a time in the platform's own
// player. It is there only while the selection has a stream, and the stream
// starts as soon as one is chosen (useLiveScreen). The section starts
// collapsed; its +/- hides and shows the body, and the player plays on,
// muted, underneath. Its controls call LiveControls through the store.
const PANEL_ID = 'live-panel';
const {
  view,
  act,
  playing,
  loading,
  offline,
  unavailable,
  badgeText,
  statusText,
} = useLiveScreen();
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
      <button v-if="view.count > 1" id="live-previous-btn" type="button" class="live-step" @click="act('cycleLive', -1)" :aria-label="t('Previous stream')" :title="t('Previous stream')"><span class="material-symbols-outlined" aria-hidden="true">chevron_left</span></button>
      <span id="live-stream-title" class="live-stream-title" aria-live="polite">{{ t(view.current.title) }}<small v-if="view.count > 1"> · {{ view.index + 1 }}/{{ view.count }}</small></span>
      <button v-if="view.count > 1" id="live-next-btn" type="button" class="live-step" @click="act('cycleLive', 1)" :aria-label="t('Next stream')" :title="t('Next stream')"><span class="material-symbols-outlined" aria-hidden="true">chevron_right</span></button>
    </div>
    <!-- The player's element stays put across re-renders: LiveControls mounts the player in it. -->
    <div class="live-screen" :class="{ active: playing || loading }">
      <div id="live-player-host" class="live-player-host"></div>
      <div v-if="offline || unavailable" class="live-card" :class="{ offline, unavailable }">
        <span class="live-card-dot" aria-hidden="true"></span>
        <strong>{{ offline ? t('Stream is offline') : t('This stream cannot play here') }}</strong>
        <button v-if="offline" id="live-retry-btn" type="button" @click="act('retryLive')">{{ t('Try again') }}</button>
      </div>
    </div>
    <p id="live-status" class="live-status" role="status" aria-live="polite">{{ statusText }}</p>
    <p class="live-credit"><a :href="view.current.ownerUrl" target="_blank" rel="noopener noreferrer">{{ view.current.owner }}</a> · <a id="live-watch-link" :href="view.current.watchUrl" target="_blank" rel="noopener noreferrer">{{ t('Open on YouTube') }}</a></p>
    <p class="live-privacy">{{ t('Video plays from YouTube, which sees your IP address.') }}</p>
  </template>
</RailPanel>
</template>
