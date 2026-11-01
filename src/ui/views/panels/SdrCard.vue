<script setup>
import { storeToRefs } from 'pinia';
import { ref } from 'vue';
import { t } from '../../../i18n/index.js';
import { R820T_GAIN_STEPS_DB } from '../../../sdr/gain.js';
import { localSdrGainOptionLabel } from '../../localSdrPresentation.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { vFieldValue } from '../../rail/fieldValue.js';
import UiSlider from '../../kit/UiSlider.js';
import { useRadioStore } from '../../stores/radio.js';

// The local RTL-SDR card in the Radio panel. LocalSdrControls presents it and
// publishes it; until it does, the card shows its initial markup. Its
// controls call LocalSdrControls through the store. The numeric gain
// options read in the page language; their values stay numeric.
const radio = useRadioStore();
const { sdr } = storeToRefs(radio);
const { act } = radio;
const frequency = ref(null);
const GAINS = R820T_GAIN_STEPS_DB.map((gain) => gain.toFixed(1));
const tune = () => act('tuneSdr', frequency.value.value);
</script>

<template>
<div id="sdr-radio-card" class="sdr-radio-card" role="group" aria-label="Local RTL-SDR receiver" data-i18n-aria-label>
  <div class="sdr-radio-heading">
    <strong data-i18n>LOCAL RTL-SDR</strong>
    <span id="sdr-connection-state" v-class-toggle="{ active: sdr?.connectionActive }" data-i18n-runtime>{{ sdr ? sdr.connectionLabel : 'NO USB' }}</span>
  </div>
  <p data-i18n>Chrome/Edge · WebUSB · one local tuner shared by FM and the Local ADS-B layer.</p>
  <div class="sdr-radio-actions">
    <button id="sdr-connect-btn" @click="act('toggleSdrConnection')" class="panel-layer-toggle" :class="{ active: sdr?.connectPressed }" type="button" :aria-pressed="String(sdr?.connectPressed ?? false)" :disabled="sdr?.connectDisabled">{{ sdr ? sdr.connectLabel : t('CONNECT') }}</button>
    <button id="sdr-locate-btn" type="button" @click="act('locateSdr')" v-class-toggle="{ active: sdr?.locateActive }" title="Use your location for faster ADS-B position decoding" :disabled="sdr?.locateDisabled" data-i18n-title>{{ sdr ? sdr.locateLabel : t('LOCATE') }}</button>
    <button id="sdr-change-device-btn" type="button" @click="act('changeSdrDevice')" title="Choose a different RTL-SDR or receiver channel" :disabled="sdr?.changeDeviceDisabled" data-i18n-title data-i18n>CHANGE DEVICE</button>
  </div>
  <div class="sdr-mode-row" role="group" aria-label="RTL-SDR receiver mode" data-i18n-aria-label>
    <button id="sdr-mode-fm-btn" @click="act('setSdrMode', 'fm')" class="active" v-class-toggle="sdr ? { active: sdr.fmActive } : null" type="button" :aria-pressed="String(sdr ? sdr.fmActive : true)" :disabled="sdr?.modeDisabled" translate="no">FM</button>
    <button id="sdr-mode-adsb-btn" type="button" @click="act('setSdrMode', 'adsb')" v-class-toggle="{ active: sdr?.adsbActive }" :aria-pressed="String(sdr?.adsbActive ?? false)" :disabled="sdr?.modeDisabled" translate="no">ADS-B · 1090</button>
  </div>
  <div class="sdr-gain-row">
    <label for="sdr-gain-select" data-i18n>GAIN</label>
    <select class="gev-field" id="sdr-gain-select" @change="act('setSdrGain', $event.target.value)" aria-label="RTL-SDR tuner gain for the current mode" :disabled="sdr?.gainDisabled" v-field-value="sdr ? sdr.gain : 'auto'" data-i18n-aria-label>
      <option value="auto" data-i18n>AUTO</option>
      <option v-for="gain in GAINS" :key="gain" :value="gain" translate="no">{{ localSdrGainOptionLabel(gain) }}</option>
    </select>
  </div>
  <div id="sdr-adsb-stats" class="sdr-adsb-stats" role="status" aria-live="off" :hidden="sdr ? sdr.statsHidden : true">
    <span><output id="sdr-stat-rate">{{ sdr ? sdr.stats.rate : '--' }}</output> <span data-i18n>MSG/S</span></span>
    <span><output id="sdr-stat-heard">{{ sdr ? sdr.stats.heard : '0' }}</output> <span data-i18n>HEARD</span></span>
    <span><output id="sdr-stat-positioned">{{ sdr ? sdr.stats.positioned : '0' }}</output> <span data-i18n>POSITIONED</span></span>
    <span translate="no">IQ <output id="sdr-stat-iq">{{ sdr ? sdr.stats.iq : '--' }}</output></span>
  </div>
  <div class="sdr-frequency-row">
    <label for="sdr-frequency-input" data-i18n>FM MHZ</label>
    <input ref="frequency" class="gev-field" id="sdr-frequency-input" @keydown.enter.prevent="tune" type="number" min="87.5" max="108" step="0.1" value="98.5" inputmode="decimal" :disabled="sdr?.frequencyDisabled" v-field-value="sdr ? sdr.frequency : '98.5'" />
    <button id="sdr-tune-btn" type="button" @click="tune" :disabled="sdr?.tuneDisabled" data-i18n>TUNE</button>
  </div>
  <div class="sdr-seek-row" role="group" aria-label="Seek broadcast FM stations" data-i18n-aria-label>
    <button id="sdr-seek-back-btn" type="button" @click="act('seekSdr', -1)" :disabled="sdr ? sdr.seekDisabled : true" data-i18n>◀ SEEK</button>
    <button id="sdr-seek-forward-btn" type="button" @click="act('seekSdr', 1)" :disabled="sdr ? sdr.seekDisabled : true" data-i18n>SEEK ▶</button>
  </div>
  <label class="radio-volume-row" for="sdr-volume">
    <span data-i18n>SDR VOL</span>
    <UiSlider id="sdr-volume" hold @update:model-value="act('setSdrVolume', $event)" min="0" max="100" aria-label="Local SDR volume" :disabled="sdr?.volumeDisabled" :model-value="sdr ? sdr.volume : 80" data-i18n-aria-label />
    <output id="sdr-volume-value" class="gev-slider-value" for="sdr-volume">{{ sdr ? sdr.volumeText : '80%' }}</output>
  </label>
  <div id="sdr-status" class="radio-playback-state" :class="{ error: sdr?.statusError }" role="status" aria-live="polite">{{ sdr ? sdr.statusText : t('Connect an RTL-SDR to begin.') }}</div>
  <div id="sdr-feed-status" class="sdr-feed-status" role="status" aria-live="off" :hidden="sdr ? sdr.feedLine === null : true">{{ sdr?.feedLine ?? '' }}</div>
</div>
</template>
