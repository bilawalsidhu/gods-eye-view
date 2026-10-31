<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { vFieldValue } from '../../rail/fieldValue.js';
import { vRangeValue } from '../../rail/rangeValue.js';
import { useRadioStore } from '../../stores/radio.js';
import SdrCard from './SdrCard.vue';

// The Radio panel inside Context. RadioControls presents the directory row,
// station card, transport, volume and playback line and publishes them;
// until it does, the panel shows its initial markup. The tuner keeps its
// owner's element bindings; SdrCard renders the local RTL-SDR card.
const { view: radio, sdr } = storeToRefs(useRadioStore());
// Only whether the receiver is connected reaches the panel; the card renders
// its own frames.
const sdrConnected = computed(() => sdr.value?.connectionActive ?? null);
</script>

<template>
<section id="radio-panel" class="panel-collapsible collapsed" v-class-toggle="{ ...(radio && { 'radio-enabled': radio.enabled, 'lifecycle-uncertain': radio.uncertain }), ...(sdrConnected !== null && { 'sdr-connected': sdrConnected }) }" data-panel-id="radio-panel" aria-label="Internet radio and local SDR" data-i18n-aria-label>
  <div class="radio-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-i18n>RADIO</span>
      <span id="radio-layer-state" class="radio-layer-state" :class="{ active: radio?.layerState.active }">{{ radio ? radio.layerState.text : t('OFF') }}</span>
      <span class="panel-divider"></span>
      <button class="panel-collapse-btn" data-collapse-target="radio-panel" title="Expand Radio" aria-label="Expand Radio section" data-i18n-title data-i18n-aria-label>+</button>
    </div>
    <div class="radio-directory-row">
      <button id="radio-enable-btn" class="panel-layer-toggle" :class="{ active: radio?.enable.active }" type="button" :aria-pressed="String(radio?.enable.active ?? false)" :aria-label="radio?.enable.label" :aria-disabled="radio ? String(radio.enable.busy) : undefined" :aria-busy="radio ? String(radio.enable.busy) : undefined">{{ radio ? radio.enable.text : t('ENABLE') }}</button>
      <label class="radio-filter-label" for="radio-filter" data-i18n>STATION TAG</label>
      <select class="gev-field" id="radio-filter" aria-label="Filter stations by station tag" :disabled="radio ? radio.filter.disabled : true" v-bind="radio?.filter.color ? { style: { color: radio.filter.color } } : {}" v-range-value="radio ? radio.filter.value : 'all'" data-i18n-aria-label>
        <option v-if="!radio?.filter.options" value="all">{{ t('All', { context: 'radio tag' }) }}</option><template v-else><option v-for="option in radio.filter.options" :key="option.id" :value="option.id" :data-radio-color="option.color" :style="{ color: option.color }" :aria-label="option.label">● {{ option.label }}</option></template>
      </select>
    </div>
    <div id="radio-station-card" class="radio-station-card" aria-live="polite">
      <strong id="radio-station-name">{{ radio ? radio.station.name : t('NO STATION SELECTED') }}</strong>
      <span id="radio-station-meta">{{ radio ? radio.station.meta : t('Enable Radio, then choose a globe marker or use next.') }}</span>
      <span id="radio-station-tags">{{ radio?.station.tags ?? '' }}</span>
    </div>
    <div id="radio-tuner" class="radio-tuner" hidden>
      <div class="radio-tuner-header">
        <span data-i18n id="radio-tuner-band-label">DIRECTORY BAND</span>
        <output id="radio-tuner-value" for="radio-tuner-slider" data-i18n>DRAG TO TUNE</output>
      </div>
      <div class="radio-tuner-dial">
        <div class="radio-tuner-scale" aria-hidden="true"></div>
        <div id="radio-tuner-needle" class="radio-tuner-needle" aria-hidden="true"></div>
        <input id="radio-tuner-slider" type="range" min="0" max="0" step="1" value="0"
          aria-label="Tune available internet radio stations" aria-valuetext="No station available" disabled data-i18n-aria-label />
      </div>
      <div class="radio-tuner-readout">
        <span id="radio-tuner-station" data-i18n>ALL · DRAG THE NEEDLE</span>
        <span data-i18n>SNAPS TO AVAILABLE STATIONS</span>
      </div>
    </div>
    <div class="radio-transport" role="group" aria-label="Radio playback" data-i18n-aria-label>
      <button id="radio-prev-btn" type="button" aria-label="Previous filtered station" :disabled="radio ? radio.transport.stepDisabled : true" data-i18n-aria-label data-i18n>PREV</button>
      <button id="radio-play-btn" type="button" v-class-toggle="{ active: radio?.transport.play.active }" :aria-label="radio ? radio.transport.play.label : t('Play selected station')" :disabled="radio ? radio.transport.play.disabled : true">{{ radio ? radio.transport.play.text : t('PLAY') }}</button>
      <button id="radio-next-btn" type="button" aria-label="Next filtered station" :disabled="radio ? radio.transport.stepDisabled : true" data-i18n-aria-label data-i18n>NEXT</button>
      <button id="radio-stop-btn" type="button" aria-label="Stop radio playback" :disabled="radio ? radio.transport.stopDisabled : true" data-i18n-aria-label data-i18n>STOP</button>
    </div>
    <label class="radio-volume-row" for="radio-volume">
      <span data-i18n>VOLUME</span>
      <input id="radio-volume" class="gev-quantitative-slider" type="range" min="0" max="100" value="80" aria-label="Radio volume" :disabled="radio?.volume.disabled" v-field-value="radio ? radio.volume.value : 80" data-i18n-aria-label />
      <output id="radio-volume-value" class="gev-slider-value" for="radio-volume">{{ radio ? `${radio.volume.value}%` : '80%' }}</output>
    </label>
    <div id="radio-playback-state" class="radio-playback-state" :class="{ error: radio?.playback.error }" role="status" aria-live="polite">{{ radio ? radio.playback.text : t('Radio off') }}</div>
    <div class="radio-links">
      <a id="radio-station-homepage" :href="radio ? radio.station.homepage || undefined : '#'" target="_blank" rel="noopener noreferrer" :hidden="radio ? !radio.station.homepage : true" data-i18n>STATION SITE</a>
      <a href="https://www.radio-browser.info/" target="_blank" rel="noopener noreferrer" data-i18n>DIRECTORY: RADIO BROWSER</a>
    </div>
    <p class="radio-privacy" data-i18n>Audio connects directly to the broadcaster after you press play. Your IP is visible to that broadcaster.</p>
    <SdrCard />
  </div>
</section>
</template>
