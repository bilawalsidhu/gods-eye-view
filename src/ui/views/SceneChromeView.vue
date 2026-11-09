<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import { useDisplayStore } from '../stores/display.js';
import { useLocationStore } from '../stores/location.js';
import { useRecordingStore } from '../stores/recording.js';
import { useStatusStore } from '../stores/status.js';
import { useWorldOverlayActionsStore } from '../stores/worldOverlayActions.js';
import { vClassToggle } from '../rail/classToggle.js';
import ImagerySplitView from './panels/ImagerySplitView.vue';
import MissionReplayOverlay from './panels/MissionReplayOverlay.vue';
import DataPacks from './panels/DataPacks.vue';
import SceneInteractions from './panels/SceneInteractions.vue';
import SplitFlapText from './panels/SplitFlapText.vue';
import WindInspectionMarker from './panels/WindInspectionMarker.vue';
import CelestialRing from './panels/CelestialRing.vue';
import ScreenAnnotations from './panels/ScreenAnnotations.vue';
import AwarenessDirection from './panels/AwarenessDirection.vue';
import UiButton from '../kit/UiButton.vue';
import GlobeActions from './panels/GlobeActions.vue';
import WorldTimeline from './panels/WorldTimeline.vue';

// The ACTIVE STYLE corner shows the style VisualSettings publishes.
const { style } = storeToRefs(useDisplayStore());
// The status chips, toast and FPS readout show what ShellFeedback,
// CctvControls, createToast() and createFrameRateMonitor() publish.
const { loading, traffic, cctv, toast, fps } = storeToRefs(useStatusStore());
// The safe frame a recording composes in, as RecordingControls publishes it.
const { safeFrame } = storeToRefs(useRecordingStore());
// The ORBIT indicator LocationControls offers with the location tray.
const { view: location } = storeToRefs(useLocationStore());
// The focusable mirror of the overlay cards the world overlay painted.
const { actions: targets, controls: overlayControls } = storeToRefs(
  useWorldOverlayActionsStore(),
);
// Each button activates the target of the list it was rendered for.
const onOverlayAction = (owner, key) => () =>
  overlayControls.value?.activate(owner, key);
// Every accepted focus rewrites the status, so the live region announces a
// repeated focus again.
const vOverlayStatus = {
  mounted(el, { value }) {
    el.textContent = value?.status ?? '';
  },
  updated(el, { value, oldValue }) {
    if (value?.announced !== oldValue?.announced || !value)
      el.textContent = value?.status ?? '';
  },
};
// Every show rewrites the toast's text, so the live region announces a
// repeated message again; hiding leaves it as it fades.
const vToastText = {
  mounted(el, { value }) {
    el.textContent = value?.text ?? '';
  },
  updated(el, { value, oldValue }) {
    if (value?.shown !== oldValue?.shown) el.textContent = value?.text ?? '';
  },
};
</script>

<template>
  <div id="cesiumContainer"></div>
  <div id="world-overlay-root" aria-hidden="true">
    <canvas id="world-overlay-canvas"></canvas>
  </div>
  <div id="world-overlay-actions" class="world-overlay-accessibility" role="region" :aria-label="t('Visible map targets')">
    <div id="world-overlay-action-list"><UiButton v-for="item in targets?.items ?? []" :key="item.key" :aria-label="item.label" :pressed="Boolean(item.selected)" :data-overlay-action-key="item.key" :onClick="onOverlayAction(targets.owner, item.key)">{{ item.label }}</UiButton></div>
    <div id="world-overlay-status" v-overlay-status="targets" role="status" aria-live="polite" aria-atomic="true"></div>
  </div>

  <!-- Title -->
  <div id="title-bar">
    <div class="title-glow"></div>
    <h1><span class="title-logo brand-logo" data-logo-gaze data-logo-src="/logo.svg" aria-hidden="true"><img src="/logo.svg" alt="" /></span> <span translate="no">GOD'S EYE <span class="title-accent">VIEW</span></span></h1>
    <p class="subtitle scene-text-holdout">{{ t('NO PLACE LEFT BEHIND') }}</p>
    <div v-if="fps" class="frame-rate-readout scene-text-holdout" :hidden="!fps.visible" :title="t('Rendered globe frames per second · toggle with `')">{{ fps.text }}</div>
  </div>

  <!-- Style indicator -->
  <div id="style-indicator">
    <span class="indicator-label scene-text-holdout">{{ t('ACTIVE STYLE') }}</span>
    <span class="indicator-value scene-text-holdout" id="active-style-name">{{ style ? style.label : t('NORMAL') }}</span>
  </div>

  <!-- Top-center camera and share actions -->
  <GlobeActions />
  <div id="global-loading-status" role="status" aria-live="polite" aria-atomic="true" :hidden="loading ? loading.hidden : true" :data-state="loading?.state ?? undefined">
    <SplitFlapText id="global-loading-label" :text="loading ? loading.label : t('LOADING LIVE DATA')" :stopped="!!loading?.stopped" />
    <span id="global-loading-detail">{{ loading ? loading.detail : '' }}</span>
  </div>
  <div id="traffic-sync-chip" aria-live="polite" v-class-toggle="{ visible: !!traffic?.visible }">
    <SplitFlapText id="traffic-sync-label" :text="traffic ? traffic.label : t('syncing road network')" :immediate="!!traffic?.immediate" :stopped="!!traffic?.stopped" />
    <span id="traffic-sync-progress">{{ traffic ? traffic.progress : '0%' }}</span>
  </div>
  <div id="cctv-sync-chip" aria-live="polite" v-class-toggle="{ visible: !!cctv?.visible }">
    <SplitFlapText id="cctv-sync-label" :text="cctv ? cctv.label : t('loading frames')" :immediate="!!cctv?.immediate" :stopped="!!cctv?.stopped" />
    <span id="cctv-sync-progress">{{ cctv ? cctv.progress : '0/0' }}</span>
  </div>

  <!-- Toast notification -->
  <div id="toast" v-toast-text="toast" role="status" aria-live="polite" aria-atomic="true" v-class-toggle="{ visible: !!toast?.visible }"></div>

  <!-- Safe frame guides for recording composition -->
  <div id="safe-frame-overlay" v-class-toggle="{ active: !!safeFrame, 'ratio-16-9': safeFrame === '16:9', 'ratio-9-16': safeFrame === '9:16' }">
    <div id="safe-frame-box"></div>
  </div>

  <Teleport to="body">
    <div v-if="location?.orbit" id="orbit-indicator" v-class-toggle="{ active: location.orbit.active }"><span class="orbit-icon">↻</span> {{ t('ORBIT') }}</div>
  </Teleport>

  <ImagerySplitView />
  <DataPacks />
  <CelestialRing />
  <SceneInteractions />
  <WindInspectionMarker />
  <MissionReplayOverlay />
  <ScreenAnnotations />
  <AwarenessDirection />
  <WorldTimeline />
</template>
