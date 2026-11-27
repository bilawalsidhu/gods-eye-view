<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { vClassToggle } from '../../rail/classToggle.js';
import UiButton from '../../kit/UiButton.vue';
import UiSlider from '../../kit/UiSlider.js';
import { useRadioStore } from '../../stores/radio.js';
import RadioTuner from './RadioTuner.vue';

// RadioControls binds these IDs at startup. Context moves the directory and
// playback controls into the station list. The local receiver's controls
// stay on its Data Layers row (SdrCard.vue).
const store = useRadioStore();
const { act } = store;
const { view: radio } = storeToRefs(store);
</script>

<template>
  <details id="radio-panel" class="radio-fold" v-class-toggle="{ ...(radio && { 'radio-enabled': radio.enabled, 'lifecycle-uncertain': radio.uncertain }) }" :aria-label="t('Tuner and volume')">
    <summary class="radio-fold__summary">{{ t('Tuner and volume') }}</summary>
    <RadioTuner />
    <div class="radio-transport" role="group" :aria-label="t('Radio playback')">
      <UiButton id="radio-prev-btn" @click="act('cycleRadio', -1)" :aria-label="t('Previous filtered station')" :disabled="radio ? radio.transport.stepDisabled : true">{{ t('PREV') }}</UiButton>
      <UiButton id="radio-play-btn" @click="act('toggleRadioPlayback')" v-class-toggle="{ active: radio?.transport.play.active }" :aria-label="radio ? radio.transport.play.label : t('Play selected station')" :disabled="radio ? radio.transport.play.disabled : true">{{ radio ? radio.transport.play.text : t('PLAY') }}</UiButton>
      <UiButton id="radio-next-btn" @click="act('cycleRadio', 1)" :aria-label="t('Next filtered station')" :disabled="radio ? radio.transport.stepDisabled : true">{{ t('NEXT') }}</UiButton>
      <UiButton id="radio-stop-btn" @click="act('stopRadio')" :aria-label="t('Stop radio playback')" :disabled="radio ? radio.transport.stopDisabled : true">{{ t('STOP') }}</UiButton>
    </div>
    <label class="radio-volume-row" for="radio-volume">
      <span>{{ t('VOLUME') }}</span>
      <UiSlider id="radio-volume" hold @update:model-value="act('setRadioVolume', $event)" min="0" max="100" :aria-label="t('Radio volume')" :disabled="radio?.volume.disabled" :model-value="radio ? radio.volume.value : 80" />
      <output id="radio-volume-value" class="gev-slider-value" for="radio-volume">{{ radio ? `${radio.volume.value}%` : '80%' }}</output>
    </label>
    <div id="radio-playback-state" class="radio-playback-state" :class="{ error: radio?.playback.error }" role="status" aria-live="polite">{{ radio ? radio.playback.text : t('Radio off') }}</div>
    <div class="radio-links">
      <a id="radio-station-homepage" :href="radio ? radio.station.homepage || undefined : '#'" target="_blank" rel="noopener noreferrer" :hidden="radio ? !radio.station.homepage : true">{{ t('STATION SITE') }}</a>
      <a href="https://www.radio-browser.info/" target="_blank" rel="noopener noreferrer">{{ t('DIRECTORY: RADIO BROWSER') }}</a>
    </div>
  </details>
</template>
