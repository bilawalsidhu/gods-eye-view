<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import CctvCalValue from '../../cctv/CctvCalValue.vue';
import { useCctvStore } from '../../stores/cctv.js';

// The CCTV panel, rendered from what CctvControls presents and publishes;
// until it renders, the panel shows its initial markup. The controls fill
// the picker's options, and draw the live video into its canvas.
const { view, frame, live, sourceBadge, summary } = storeToRefs(useCctvStore());
// The frame's request state, as data attributes that read "true" or are
// empty; none until the controls first publish.
const flag = (on) => (on ? 'true' : '');
const frameData = computed(() =>
  frame.value
    ? {
        'data-camera-id': frame.value.cameraId,
        'data-current-src': frame.value.currentSrc,
        'data-loading': flag(frame.value.loading),
        'data-error': flag(frame.value.error),
      }
    : {},
);
</script>

<template>
<div id="cctv-panel" class="panel-collapsible collapsed" data-panel-id="cctv-panel">
  <div class="panel-glow"></div>
  <div class="cctv-panel-inner" data-rail-scroller>
    <div class="panel-header">
      <span class="panel-title" data-i18n>CCTV</span>
      <span class="panel-divider"></span>
      <button class="panel-collapse-btn" data-collapse-target="cctv-panel" title="Collapse panel" data-i18n-title>+</button>
    </div>
    <div class="cyber-panel-body" data-rail-scroller>
    <div id="cctv-frame-wrap" :class="['cctv-frame-wrap', { loading: frame?.wrapLoading, 'has-frame': frame?.hasFrame }]">
      <span class="cctv-frame-caption" aria-hidden="true" data-i18n>ACQUIRING FRAME</span>
      <img id="cctv-frame" alt="CCTV feed frame" :class="{ active: frame?.hasFrame }" :src="frame?.src || undefined" :hidden="live" v-bind="frameData" />
      <canvas id="cctv-video" class="cctv-frame" :hidden="!live"></canvas>
    </div>
    <div id="cctv-source-badge" class="gev-status-badge" role="status" aria-live="polite" :data-frame-state="sourceBadge?.state">{{ sourceBadge?.label ?? t('SOURCE · UNKNOWN') }}</div>
    <div id="cctv-meta">{{ view?.meta ?? t('Enable CCTV to load camera intersections') }}</div>
    <div class="cctv-controls">
      <button id="cctv-enable-btn" :class="['scene-btn', { active: view?.enabled }]">{{ view?.enabled ? t('CCTV ON') : t('CCTV OFF') }}</button>
      <button id="cctv-nearest-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.navDisabled" data-i18n>NEAREST</button>
    </div>
    <div class="cctv-controls">
      <button id="cctv-prev-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.navDisabled" data-i18n>PREV</button>
      <select class="gev-field" id="cctv-camera-select" aria-label="CCTV camera" data-i18n-aria-label></select>
      <button id="cctv-next-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.navDisabled" data-i18n>NEXT</button>
    </div>
    <div class="cctv-controls">
      <button id="cctv-focus-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.focusDisabled" data-i18n>FOCUS</button>
      <button id="cctv-coverage-btn" :class="['scene-btn', { active: view?.coverage.active }]" :disabled="view?.toggleDisabled">{{ view?.coverage.text ?? t('COVERAGE OFF') }}</button>
      <button id="cctv-auto-hop-btn" :class="['scene-btn', { active: view?.autoHop.active }]" :disabled="view?.toggleDisabled">{{ view?.autoHop.text ?? t('AUTO HOP OFF') }}</button>
    </div>
    <div class="cctv-controls">
      <button id="cctv-projection-btn" :class="['scene-btn', { active: view?.projection.active }]" :disabled="view?.toggleDisabled">{{ view?.projection.text ?? t('PROJECTION ON') }}</button>
      <span id="cctv-quality-chip" class="gev-status-badge gev-status-badge--box" :data-cal-badge="view?.quality.calBadge">{{ view?.quality.label ?? t('CAL · {badge}', { badge: '--' }) }}</span>
    </div>
    <div class="cctv-calibration-block">
      <div class="cctv-calibration-header">
        <div class="cctv-summary-label" data-i18n>CALIBRATION</div>
        <button id="cctv-adjust-btn" :class="['scene-btn', { active: view?.calibration.adjust.active }]" title="Drag the camera in the world: rings rotate, arrows move, handles set range/FOV" data-i18n-title :disabled="view?.calibration.disabled">{{ view?.calibration.adjust.text ?? t('ADJUST') }}</button>
      </div>
      <div id="cctv-cal-readout" class="cctv-cal-readout" aria-label="Camera pose — click a value to type" data-i18n-aria-label>
        <CctvCalValue field="heading" label="HDG" title="Heading (compass °) — click to type" data-i18n-title />
        <CctvCalValue field="pitch" label="PITCH" title="Pitch (° up/down) — click to type" data-i18n-title />
        <CctvCalValue field="fov" label="FOV" title="Horizontal FOV (°) — click to type" data-i18n-title />
        <CctvCalValue field="range" label="RANGE" title="Range / monitor-plane distance (m) — click to type" data-i18n-title />
        <CctvCalValue field="height" label="HGT" title="Mount height above ground (m) — click to type" data-i18n-title />
        <CctvCalValue field="north" label="ΔN" title="North offset from catalog position (m) — click to type" data-i18n-title />
        <CctvCalValue field="east" label="ΔE" title="East offset from catalog position (m) — click to type" data-i18n-title />
      </div>
      <div class="cctv-controls cctv-calibration-actions">
        <button id="cctv-calib-save-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.calibration.disabled" data-i18n>SAVE CAL</button>
        <button id="cctv-calib-reset-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.calibration.disabled" data-i18n>RESET CAL</button>
      </div>
    </div>
    <div class="cctv-summary-label" data-i18n>SCENE SUMMARY</div>
    <div id="cctv-summary">{{ summary ?? t('Enable CCTV to start camera-linked intelligence summaries.') }}</div>
    </div>
  </div>
</div>
</template>
