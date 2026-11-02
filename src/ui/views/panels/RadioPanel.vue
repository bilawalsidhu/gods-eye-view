<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import RailPanel from '../../rail/RailPanel.vue';
import { vClassToggle } from '../../rail/classToggle.js';
import UiSlider from '../../kit/UiSlider.js';
import { useRadioStore } from '../../stores/radio.js';
import RadioTuner from './RadioTuner.vue';
import SdrCard from './SdrCard.vue';
import UiButton from '../../kit/UiButton.vue';
import UiSelect from '../../kit/UiSelect.js';

// The Radio panel inside Context. RadioControls presents the directory row,
// station card, transport, volume and playback line and publishes them;
// until it does, the panel shows its initial markup. RadioTuner renders the
// directory tuner and SdrCard the local RTL-SDR card. Its controls call
// RadioControls through the store.
const store = useRadioStore();
const { act } = store;
const { view: radio, sdr } = storeToRefs(store);
// A refused station tag puts the select back on the tag the filter keeps.
const setFilter = (select) => {
  select.value = act('setRadioFilter', select.value) ?? select.value;
};
// Only whether the receiver is connected reaches the panel; the card renders
// its own frames.
const sdrConnected = computed(() => sdr.value?.connectionActive ?? null);
// The collapse button keeps Radio's own wording, not "Expand RADIO".
const radioWords = computed(() => ({
  expandLabel: t('Expand Radio section'),
  collapseLabel: t('Collapse Radio section'),
  expandTitle: t('Expand Radio'),
  collapseTitle: t('Collapse Radio'),
}));
</script>

<template>
<RailPanel id="radio-panel" tag="section" start-collapsed v-class-toggle="{ ...(radio && { 'radio-enabled': radio.enabled, 'lifecycle-uncertain': radio.uncertain }), ...(sdrConnected !== null && { 'sdr-connected': sdrConnected }) }" :aria-label="t('Internet radio and local SDR')" :title="t('RADIO')" :toggle-words="radioWords" :glow="false" scroll>
  <template #badge><span id="radio-layer-state" class="radio-layer-state" :class="{ active: radio?.layerState.active }">{{ radio ? radio.layerState.text : t('OFF') }}</span></template>
    <div class="radio-directory-row">
      <UiButton id="radio-enable-btn" @click="act('toggleRadio', 'panel')" class="panel-layer-toggle" :pressed="radio?.enable.active ?? false" pressed-class="active" :aria-label="radio?.enable.label" :aria-disabled="radio ? String(radio.enable.busy) : undefined" :aria-busy="radio ? String(radio.enable.busy) : undefined">{{ radio ? radio.enable.text : t('ENABLE') }}</UiButton>
      <label class="radio-filter-label" for="radio-filter">{{ t('STATION TAG') }}</label>
      <UiSelect class="gev-field" id="radio-filter" @change="setFilter($event.target)" :aria-label="t('Filter stations by station tag')" :disabled="radio ? radio.filter.disabled : true" v-bind="radio?.filter.color ? { style: { color: radio.filter.color } } : {}" :model-value="radio ? radio.filter.value : 'all'">
        <option v-if="!radio?.filter.options" value="all">{{ t('All', { context: 'radio tag' }) }}</option><template v-else><option v-for="option in radio.filter.options" :key="option.id" :value="option.id" :data-radio-color="option.color" :style="{ color: option.color }" :aria-label="option.label">● {{ option.label }}</option></template>
      </UiSelect>
    </div>
    <div id="radio-station-card" class="radio-station-card" aria-live="polite">
      <strong id="radio-station-name">{{ radio ? radio.station.name : t('NO STATION SELECTED') }}</strong>
      <span id="radio-station-meta">{{ radio ? radio.station.meta : t('Enable Radio, then choose a globe marker or use next.') }}</span>
      <span id="radio-station-tags">{{ radio?.station.tags ?? '' }}</span>
    </div>
    <RadioTuner />
    <div class="radio-transport" role="group" :aria-label="t('Radio playback')">
      <button id="radio-prev-btn" @click="act('cycleRadio', -1)" type="button" :aria-label="t('Previous filtered station')" :disabled="radio ? radio.transport.stepDisabled : true">{{ t('PREV') }}</button>
      <button id="radio-play-btn" @click="act('toggleRadioPlayback')" type="button" v-class-toggle="{ active: radio?.transport.play.active }" :aria-label="radio ? radio.transport.play.label : t('Play selected station')" :disabled="radio ? radio.transport.play.disabled : true">{{ radio ? radio.transport.play.text : t('PLAY') }}</button>
      <button id="radio-next-btn" @click="act('cycleRadio', 1)" type="button" :aria-label="t('Next filtered station')" :disabled="radio ? radio.transport.stepDisabled : true">{{ t('NEXT') }}</button>
      <button id="radio-stop-btn" @click="act('stopRadio')" type="button" :aria-label="t('Stop radio playback')" :disabled="radio ? radio.transport.stopDisabled : true">{{ t('STOP') }}</button>
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
    <p class="radio-privacy">{{ t('Audio connects directly to the broadcaster after you press play. Your IP is visible to that broadcaster.') }}</p>
    <SdrCard />
</RailPanel>
</template>
