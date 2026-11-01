<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import { useDisplayStore } from '../stores/display.js';
import { useLocationStore } from '../stores/location.js';
import { useStatusStore } from '../stores/status.js';
import { vClassToggle } from '../rail/classToggle.js';
import ImagerySplitView from './panels/ImagerySplitView.vue';
import MissionReplayOverlay from './panels/MissionReplayOverlay.vue';
import DataPacks from './panels/DataPacks.vue';
import SceneInteractions from './panels/SceneInteractions.vue';
import SplitFlapText from './panels/SplitFlapText.vue';
import WindInspectionMarker from './panels/WindInspectionMarker.vue';

// The ACTIVE STYLE corner shows the style VisualSettings publishes.
const { style } = storeToRefs(useDisplayStore());
// The status chips, toast and FPS readout show what ShellFeedback,
// CctvControls, createToast() and createFrameRateMonitor() publish.
const { loading, traffic, cctv, toast, fps } = storeToRefs(useStatusStore());
// The ORBIT indicator LocationControls offers with the location tray.
const { view: location } = storeToRefs(useLocationStore());
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
  <div id="world-overlay-actions" class="world-overlay-accessibility" role="region" aria-label="Visible map targets" data-i18n-aria-label>
    <div id="world-overlay-action-list"></div>
    <div id="world-overlay-status" role="status" aria-live="polite" aria-atomic="true"></div>
  </div>

  <!-- Title -->
  <div id="title-bar">
    <div class="title-glow"></div>
    <h1><span class="title-logo brand-logo" data-logo-gaze data-logo-src="/logo.svg" aria-hidden="true"><img src="/logo.svg" alt="" /></span> <span translate="no">GOD'S EYE <span class="title-accent">VIEW</span></span></h1>
    <p class="subtitle scene-text-holdout" data-i18n>NO PLACE LEFT BEHIND</p>
    <div v-if="fps" class="frame-rate-readout scene-text-holdout" :hidden="!fps.visible" :title="t('Rendered globe frames per second · toggle with `')">{{ fps.text }}</div>
  </div>

  <!-- Style indicator -->
  <div id="style-indicator">
    <span class="indicator-label scene-text-holdout" data-i18n>ACTIVE STYLE</span>
    <span class="indicator-value scene-text-holdout" id="active-style-name">{{ style ? style.label : t('NORMAL') }}</span>
  </div>

  <!-- Top-center camera and share actions -->
  <nav id="top-center-actions" aria-label="Globe actions" data-i18n-aria-label>
    <button id="clear-selected-layers" type="button" aria-label="Clear selected data layers" title="Turn off all selected data layers" data-i18n-aria-label data-i18n-title>
      <span class="material-symbols-outlined" aria-hidden="true">layers_clear</span>
    </button>
    <button id="share-btn" type="button" aria-label="Copy share link" title="Copy share link" data-i18n-aria-label data-i18n-title>
      <span class="share-icon" aria-hidden="true">&#x1F517;</span>
    </button>
    <button id="tilt-map-view" type="button" aria-label="Tilt map to oblique view" aria-pressed="false" title="Toggle straight-down and tilted map views" data-i18n-aria-label data-i18n-title>
      <span class="material-symbols-outlined" aria-hidden="true">view_in_ar</span>
    </button>
    <button id="north-up-view" type="button" aria-label="Reset map to north up" title="Reset map bearing to north" data-i18n-aria-label data-i18n-title>
      <span class="camera-compass-n" aria-hidden="true">N</span>
      <span class="camera-compass-needle material-symbols-outlined" aria-hidden="true">navigation</span>
    </button>
    <button id="reset-globe-view" type="button" aria-label="Reset to full globe view" title="Reset camera and return to full globe view" data-i18n-aria-label data-i18n-title>
      <span class="material-symbols-outlined" aria-hidden="true">public</span>
    </button>
  </nav>
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
  <div id="safe-frame-overlay">
    <div id="safe-frame-box"></div>
  </div>

  <Teleport to="body">
    <div v-if="location?.orbit" id="orbit-indicator" v-class-toggle="{ active: location.orbit.active }"><span class="orbit-icon">↻</span> {{ t('ORBIT') }}</div>
  </Teleport>

  <ImagerySplitView />
  <DataPacks />
  <SceneInteractions />
  <WindInspectionMarker />
  <MissionReplayOverlay />
</template>
