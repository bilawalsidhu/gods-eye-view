<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { msg, t } from '../../../i18n/index.js';
import CctvCalValue from '../../cctv/CctvCalValue.vue';
import UiBadge from '../../kit/UiBadge.vue';
import UiButton from '../../kit/UiButton.vue';
import UiSelect from '../../kit/UiSelect.js';
import { useCctvStore } from '../../stores/cctv.js';

// CctvControls binds these element IDs at startup. Context moves the same
// controls into Camera settings. The selected card shows the camera frame
// and hosts the live canvas while video plays.
const { view, frame, live, summary } = storeToRefs(useCctvStore());
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
const coverageState = computed(() => {
  const mode = view.value?.coverage?.mode;
  return mode === 'viewshed' ? t('Viewshed') : mode === 'on' ? t('On') : t('Off');
});
// Projection is on until the controls say otherwise, as the layer starts.
const projectionOn = computed(() => (view.value ? Boolean(view.value.projection?.active) : true));
/** How long auto-hop stays on each camera, in seconds (the layer's bounds). */
const HOP_STEPS = [8, 12, 18, 30, 45, 60, 90];
const hopSec = computed(() => view.value?.autoHop?.sec ?? 18);
const hopSteps = computed(() => (HOP_STEPS.includes(hopSec.value) ? HOP_STEPS : [...HOP_STEPS, hopSec.value].sort((a, b) => a - b)));
// The calibration grid: a readable label beside each value. The label names
// the value's chip, and with its unit, the number typed into it.
const degrees = (name) => t('{name} in degrees', { name });
const metres = (name) => t('{name} in metres', { name });
const CAL_ROWS = [
  { field: 'heading', label: msg('HDG'), name: () => t('Heading'), unit: degrees, title: () => t('Heading (compass °) — click to type') },
  { field: 'pitch', label: msg('PITCH'), name: () => t('Pitch'), unit: degrees, title: () => t('Pitch (° up/down) — click to type') },
  { field: 'fov', label: msg('FOV'), name: () => t('Field of view'), unit: degrees, title: () => t('Horizontal FOV (°) — click to type') },
  { field: 'range', label: msg('RANGE'), name: () => t('Range'), unit: metres, title: () => t('Range / monitor-plane distance (m) — click to type') },
  { field: 'height', label: msg('HGT'), name: () => t('Height'), unit: metres, title: () => t('Mount height above ground (m) — click to type') },
  { field: 'north', label: msg('ΔN'), name: () => t('North offset'), unit: metres, title: () => t('North offset from catalog position (m) — click to type') },
  { field: 'east', label: msg('ΔE'), name: () => t('East offset'), unit: metres, title: () => t('East offset from catalog position (m) — click to type') },
];
</script>

<template>
  <div class="cctv-tools-root">
    <!-- Stays in the hidden home: only the fold below moves to a card. -->
    <div id="cctv-frame-wrap" class="cctv-frame-wrap" hidden>
      <img id="cctv-frame" alt="" :class="{ active: frame?.hasFrame }" :src="frame?.src || undefined" :hidden="live" v-bind="frameData" />
      <canvas id="cctv-video" class="cctv-frame" :hidden="!live" role="img" :aria-label="view?.activeCameraLabel || t('Camera view')"></canvas>
    </div>
    <div id="cctv-tools" class="cctv-tools">
      <section class="cctv-tools__group" :aria-label="t('View')">
        <h5 class="cctv-tools__head">{{ t('View') }}</h5>
        <div class="cctv-tools__toggles">
          <UiButton id="cctv-projection-btn" class="gev-tool-toggle" :pressed="projectionOn" pressed-class="is-on" :disabled="view?.toggleDisabled">
            <span class="gev-tool-toggle__switch" aria-hidden="true"></span>{{ t('Projection') }}
          </UiButton>
          <UiButton id="cctv-coverage-btn" class="gev-tool-toggle" :pressed="Boolean(view?.coverage.active)" pressed-class="is-on" :title="t('Off, on, then viewshed')" :disabled="view?.toggleDisabled">
            <span class="gev-tool-toggle__switch" aria-hidden="true"></span>{{ t('Coverage') }}<span class="gev-tool-toggle__state">{{ coverageState }}</span>
          </UiButton>
        </div>
      </section>

      <section class="cctv-tools__group" :aria-label="t('Auto-hop')">
        <h5 class="cctv-tools__head">{{ t('Auto-hop') }}</h5>
        <div class="cctv-tools__toggles">
          <UiButton id="cctv-auto-hop-btn" class="gev-tool-toggle" :pressed="Boolean(view?.autoHop.active)" pressed-class="is-on" :disabled="view?.toggleDisabled">
            <span class="gev-tool-toggle__switch" aria-hidden="true"></span>{{ t('Hop between cameras') }}
          </UiButton>
          <label class="cctv-tools__interval">
            <span>{{ t('Every') }}</span>
            <UiSelect id="cctv-auto-hop-sec" class="gev-field" :model-value="hopSec" :disabled="view?.toggleDisabled" :aria-label="t('Seconds on each camera')">
              <option v-for="sec in hopSteps" :key="sec" :value="sec">{{ t('{n} s', { n: sec }) }}</option>
            </UiSelect>
          </label>
        </div>
      </section>

      <!-- Calibration is for the person fixing a camera's pose: a fold,
           open in the tab. -->
      <details class="cctv-tools__calibration" open>
        <summary class="cctv-tools__head cctv-tools__fold">{{ t('Calibration') }}</summary>
        <UiBadge id="cctv-quality-chip" class="cctv-tools__status" :data-cal-badge="view?.quality.calBadge">{{ view?.quality.status || view?.quality.label || t('CAL · {badge}', { badge: '--' }) }}</UiBadge>
        <div id="cctv-cal-readout" class="cctv-cal-grid" :aria-label="t('Camera pose — click a value to type')">
          <div v-for="row in CAL_ROWS" :key="row.field" class="cctv-cal-grid__row">
            <span :id="`cctv-cal-label-${row.field}`" class="cctv-cal-grid__label">{{ row.name() }}</span>
            <CctvCalValue :field="row.field" :label="row.label" :title="row.title()" bare :label-id="`cctv-cal-label-${row.field}`" :input-label="row.unit(row.name())" />
          </div>
        </div>
        <div class="cctv-tools__row">
          <UiButton id="cctv-adjust-btn" class="gev-tool-button" :pressed="Boolean(view?.calibration.adjust.active)" pressed-class="is-on" :title="t('Drag the camera in the world: rings rotate, arrows move, handles set range/FOV')" :disabled="view?.calibration.disabled">{{ t('Adjust') }}</UiButton>
          <UiButton id="cctv-calib-save-btn" class="gev-tool-button" :disabled="view?.calibration.disabled">{{ t('Save') }}</UiButton>
          <UiButton id="cctv-calib-reset-btn" class="gev-tool-button" :disabled="view?.calibration.disabled">{{ t('Reset') }}</UiButton>
        </div>
      </details>

      <section class="cctv-tools__group" :aria-label="t('Scene summary')">
        <h5 class="cctv-tools__head">{{ t('Scene summary') }}</h5>
        <dl v-if="view?.summaryLines?.length" id="cctv-summary" class="cctv-tools__lines">
          <div v-for="line in view.summaryLines" :key="line.label" class="cctv-tools__line">
            <dt>{{ line.label }}</dt>
            <dd>{{ line.value }}</dd>
          </div>
        </dl>
        <p v-else id="cctv-summary" class="cctv-tools__summary-text">{{ summary }}</p>
      </section>
    </div>
  </div>
</template>
