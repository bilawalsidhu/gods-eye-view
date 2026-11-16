<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import RailPanel from '../../rail/RailPanel.vue';
import { vClassToggle } from '../../rail/classToggle.js';
import UiSlider from '../../kit/UiSlider.js';
import { useStationStore } from '../../stores/station.js';

// The STATION section inside Context: the selected space station's moving
// parts. Automatic leaves them to their rules (NASA's telemetry where the
// server relays it, computed from the Sun otherwise); Manual hands them to
// the person. The satellites layer publishes the view; its controls call
// the layer through the store. It is there only while a station is selected.
const store = useStationStore();
const { act } = store;
const { view } = storeToRefs(store);
const manual = computed(() => view.value?.mode === 'manual');

/** A duration as the status line words it. */
const ago = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 90
    ? t('{seconds} s', { seconds: formatNumber(seconds) })
    : t('{minutes} min', { minutes: formatNumber(Math.round(seconds / 60)) });
};
const clock = (ms) =>
  Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '';
const telemetry = computed(() => view.value?.telemetry ?? null);
const telemetryText = computed(() => {
  const status = telemetry.value;
  if (!status) return '';
  if (manual.value) return t('Manual · telemetry paused');
  switch (status.state) {
    case 'live':
      return t('Telemetry · updated {ago} ago', { ago: ago(status.poseAgeMs) });
    case 'no-signal':
      return Number.isFinite(status.liveUntilMs)
        ? t('No signal since {time} · computed values', { time: clock(status.liveUntilMs) })
        : t('No signal · computed values');
    case 'unavailable':
      return Number.isFinite(status.poseAgeMs)
        ? t('Telemetry unavailable · last update {ago} ago · computed values', { ago: ago(status.poseAgeMs) })
        : t('Telemetry unavailable · computed values');
    case 'disabled':
      return t('Telemetry not enabled on this server · computed values');
    case 'none':
      return t('No public telemetry · computed values');
    case 'idle':
      return t('Telemetry reads while the model is on screen');
    default:
      return t('Connecting to telemetry…');
  }
});
const telemetryTone = computed(() => {
  if (manual.value) return 'manual';
  const state = telemetry.value?.state;
  return state === 'live' ? 'live' : state === 'no-signal' ? 'waiting' : state === 'pending' ? 'waiting' : 'off';
});
const sunText = computed(() => {
  const sunlit = view.value?.sunlit;
  if (sunlit === null || sunlit === undefined) return '';
  return sunlit ? t('Now: in sunlight') : t("Now: in the Earth's shadow");
});
const stationWords = computed(() => ({
  expandLabel: t('Expand Station section'),
  collapseLabel: t('Collapse Station section'),
  expandTitle: t('Expand Station'),
  collapseTitle: t('Collapse Station'),
}));
</script>

<template>
<RailPanel id="station-panel" tag="section" start-collapsed :hidden="!view" v-class-toggle="{ 'station-manual': manual }" :aria-label="t('Controls for the selected space station')" :title="t('STATION')" :toggle-words="stationWords" :glow="false" scroll>
  <template #badge><span id="station-badge" class="station-badge">{{ view ? view.title : '' }}</span></template>
  <template v-if="view">
    <div class="station-subject">{{ view.subject }}</div>
    <div class="station-modes" role="radiogroup" :aria-label="t('Mode')">
      <button id="station-automatic-btn" type="button" role="radio" class="station-mode" :aria-checked="String(!manual)" v-class-toggle="{ 'is-active': !manual }" @click="act('setStationMode', 'automatic')">{{ t('Automatic') }}</button>
      <button id="station-manual-btn" type="button" role="radio" class="station-mode" :aria-checked="String(manual)" v-class-toggle="{ 'is-active': manual }" @click="act('setStationMode', 'manual')">{{ t('Manual') }}</button>
    </div>
    <p id="station-telemetry" class="station-telemetry" :data-tone="telemetryTone" role="status" aria-live="polite"><span class="station-telemetry-dot" aria-hidden="true"></span>{{ telemetryText }}</p>
    <p v-if="!manual && sunText" id="station-sun" class="station-note">{{ sunText }}</p>
    <p v-if="!manual && view.note" class="station-note">{{ t(view.note) }}</p>
    <template v-if="manual">
      <div v-for="group in view.groups" :key="group.id" class="station-group">
        <div class="station-label">{{ t(group.label) }}</div>
        <div v-if="group.kind === 'choices'" class="station-row" role="group" :aria-label="t(group.label)">
          <button v-for="choice in group.choices" :key="choice.id" type="button" class="station-button" :data-station-choice="`${group.id}:${choice.id}`" v-class-toggle="{ 'is-active': choice.active }" :aria-pressed="String(choice.active)" @click="act('chooseStation', group.id, choice.id)">{{ t(choice.label) }}</button>
        </div>
        <div v-else class="station-sliders">
          <label v-for="slider in group.sliders" :key="slider.id" class="station-slider">
            <span>{{ t(slider.label) }}</span>
            <UiSlider :id="`station-slider-${slider.id}`" :min="slider.min" :max="slider.max" :model-value="slider.value" :aria-label="t(slider.label)" @update:model-value="act('slideStation', slider.id, $event)" />
            <output class="gev-slider-value">{{ formatNumber(slider.value) }}°</output>
          </label>
          <button v-if="group.resume" type="button" class="station-button" :data-station-resume="group.id" @click="act('resumeStationArm', group.id)">{{ t(group.resume) }}</button>
        </div>
        <p v-if="group.note" class="station-note">{{ t(group.note) }}</p>
      </div>
    </template>
    <button v-if="view.zoom.offered" id="station-zoom-btn" type="button" class="station-button station-zoom" @click="act('zoomStation')">{{ t(view.zoom.label) }}</button>
  </template>
</RailPanel>
</template>
