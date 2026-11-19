<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import RailPanel from '../../rail/RailPanel.vue';
import CctvCalValue from '../../cctv/CctvCalValue.vue';
import CctvPicker from '../../cctv/CctvPicker.vue';
import { useCctvStore } from '../../stores/cctv.js';
import UiBadge from '../../kit/UiBadge.vue';

// The CCTV panel, rendered from what CctvControls presents and publishes;
// until it renders, the panel shows its initial markup. The controls draw
// the live video into its canvas.
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
<RailPanel id="cctv-panel" start-collapsed :title="t('CCTV')" sideways scroll rail-scroller>
    <div class="cyber-panel-body ui-scroll" data-rail-scroller>
    <div id="cctv-frame-wrap" :class="['cctv-frame-wrap', { loading: frame?.wrapLoading, 'has-frame': frame?.hasFrame }]">
      <span class="cctv-frame-caption" aria-hidden="true">{{ t('ACQUIRING FRAME') }}</span>
      <img id="cctv-frame" alt="CCTV feed frame" :class="{ active: frame?.hasFrame }" :src="frame?.src || undefined" :hidden="live" v-bind="frameData" />
      <canvas id="cctv-video" class="cctv-frame" :hidden="!live"></canvas>
    </div>
    <UiBadge id="cctv-source-badge" role="status" aria-live="polite" :data-frame-state="sourceBadge?.state">{{ sourceBadge?.label ?? t('SOURCE · UNKNOWN') }}</UiBadge>
    <div id="cctv-meta">{{ view?.meta ?? t('Enable CCTV to load camera intersections') }}</div>
    <div class="cctv-controls">
      <UiButton class="scene-btn" :pressed="Boolean(view?.enabled)" pressed-class="active" id="cctv-enable-btn">{{ view?.enabled ? t('CCTV ON') : t('CCTV OFF') }}</UiButton>
      <UiButton id="cctv-nearest-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.navDisabled">{{ t('NEAREST') }}</UiButton>
    </div>
    <div class="cctv-controls">
      <UiButton id="cctv-prev-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.navDisabled">{{ t('PREV') }}</UiButton>
      <CctvPicker class="gev-field" id="cctv-camera-select" :aria-label="t('CCTV camera')" />
      <UiButton id="cctv-next-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.navDisabled">{{ t('NEXT') }}</UiButton>
    </div>
    <div class="cctv-controls">
      <UiButton id="cctv-focus-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.focusDisabled">{{ t('FOCUS') }}</UiButton>
      <UiButton class="scene-btn" :pressed="Boolean(view?.coverage.active)" pressed-class="active" id="cctv-coverage-btn" :disabled="view?.toggleDisabled">{{ view?.coverage.text ?? t('COVERAGE OFF') }}</UiButton>
      <UiButton class="scene-btn" :pressed="Boolean(view?.autoHop.active)" pressed-class="active" id="cctv-auto-hop-btn" :disabled="view?.toggleDisabled">{{ view?.autoHop.text ?? t('AUTO HOP OFF') }}</UiButton>
    </div>
    <div class="cctv-controls">
      <UiButton class="scene-btn" :pressed="Boolean(view?.projection.active)" pressed-class="active" id="cctv-projection-btn" :disabled="view?.toggleDisabled">{{ view?.projection.text ?? t('PROJECTION ON') }}</UiButton>
      <UiBadge id="cctv-quality-chip" class="gev-status-badge--box" :data-cal-badge="view?.quality.calBadge">{{ view?.quality.label ?? t('CAL · {badge}', { badge: '--' }) }}</UiBadge>
    </div>
    <div class="cctv-calibration-block">
      <div class="cctv-calibration-header">
        <div class="cctv-summary-label">{{ t('CALIBRATION') }}</div>
        <UiButton class="scene-btn" :pressed="Boolean(view?.calibration.adjust.active)" pressed-class="active" id="cctv-adjust-btn" :title="t('Drag the camera in the world: rings rotate, arrows move, handles set range/FOV')" :disabled="view?.calibration.disabled">{{ view?.calibration.adjust.text ?? t('ADJUST') }}</UiButton>
      </div>
      <div id="cctv-cal-readout" class="cctv-cal-readout" :aria-label="t('Camera pose — click a value to type')">
        <CctvCalValue field="heading" label="HDG" :title="t('Heading (compass °) — click to type')" />
        <CctvCalValue field="pitch" label="PITCH" :title="t('Pitch (° up/down) — click to type')" />
        <CctvCalValue field="fov" label="FOV" :title="t('Horizontal FOV (°) — click to type')" />
        <CctvCalValue field="range" label="RANGE" :title="t('Range / monitor-plane distance (m) — click to type')" />
        <CctvCalValue field="height" label="HGT" :title="t('Mount height above ground (m) — click to type')" />
        <CctvCalValue field="north" label="ΔN" :title="t('North offset from catalog position (m) — click to type')" />
        <CctvCalValue field="east" label="ΔE" :title="t('East offset from catalog position (m) — click to type')" />
      </div>
      <div class="cctv-controls cctv-calibration-actions">
        <UiButton id="cctv-calib-save-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.calibration.disabled">{{ t('SAVE CAL') }}</UiButton>
        <UiButton id="cctv-calib-reset-btn" type="button" class="gev-action-button scene-btn" :disabled="view?.calibration.disabled">{{ t('RESET CAL') }}</UiButton>
      </div>
    </div>
    <div class="cctv-summary-label">{{ t('SCENE SUMMARY') }}</div>
    <div id="cctv-summary">{{ summary ?? t('Enable CCTV to start camera-linked intelligence summaries.') }}</div>
    </div>
</RailPanel>
</template>
