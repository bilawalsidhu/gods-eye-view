<script setup>
import { t } from '../../../i18n/index.js';
import { useLiveScreen } from '../../liveScreen.js';

// The Cockpit briefing's LIVE page: the LIVE section of Context, in the
// card's measure, for the ridden subject's streams. The briefing renders it
// only while a stream is on offer. LiveControls builds the player into
// `#cockpit-live-player-host` while the Cockpit is on (the right rail, and
// the section's screen with it, is hidden there), and the page's controls
// call LiveControls through the live store, as the section's do.
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
</script>

<template>
  <template v-if="view">
    <div class="cockpit-live-subject">
      <strong>{{ view.label }}</strong>
      <span class="live-badge"><span class="live-dot" :class="{ 'on-air': playing, waiting: loading }" aria-hidden="true"></span><span id="cockpit-live-badge-text">{{ badgeText }}</span></span>
    </div>
    <div class="cockpit-live-pick" role="group" :aria-label="t('Stream')">
      <button v-if="view.count > 1" id="cockpit-live-previous" type="button" class="live-step" @click="act('cycleLive', -1)" :aria-label="t('Previous stream')" :title="t('Previous stream')"><span class="material-symbols-outlined" aria-hidden="true">chevron_left</span></button>
      <span id="cockpit-live-stream-title" class="live-stream-title" aria-live="polite">{{ t(view.current.title) }}<small v-if="view.count > 1"> · {{ view.index + 1 }}/{{ view.count }}</small></span>
      <button v-if="view.count > 1" id="cockpit-live-next" type="button" class="live-step" @click="act('cycleLive', 1)" :aria-label="t('Next stream')" :title="t('Next stream')"><span class="material-symbols-outlined" aria-hidden="true">chevron_right</span></button>
    </div>
    <!-- The player's element stays put across re-renders: LiveControls mounts the player in it. -->
    <div class="live-screen" :class="{ active: playing || loading }">
      <div id="cockpit-live-player-host" class="live-player-host"></div>
      <div v-if="offline || unavailable" class="live-card" :class="{ offline, unavailable }">
        <span class="live-card-dot" aria-hidden="true"></span>
        <strong>{{ offline ? t('Stream is offline') : t('This stream cannot play here') }}</strong>
        <button v-if="offline" id="cockpit-live-retry" type="button" @click="act('retryLive')">{{ t('Try again') }}</button>
      </div>
    </div>
    <p id="cockpit-live-status" class="cockpit-live-status" role="status" aria-live="polite">{{ statusText }}</p>
    <p class="cockpit-live-credit"><a :href="view.current.ownerUrl" target="_blank" rel="noopener noreferrer">{{ view.current.owner }}</a> · <a id="cockpit-live-watch-link" :href="view.current.watchUrl" target="_blank" rel="noopener noreferrer">{{ t('Open on YouTube') }}</a></p>
  </template>
</template>
