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
import UiButton from '../../kit/UiButton.vue';
import UiSelect from '../../kit/UiSelect.js';

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
<div id="sdr-radio-card" class="sdr-radio-card" role="group" :aria-label="t('Local RTL-SDR receiver')">
  <div class="sdr-radio-heading">
    <strong>{{ t('LOCAL RTL-SDR') }}</strong>
    <span id="sdr-connection-state" v-class-toggle="{ active: sdr?.connectionActive }">{{ sdr ? sdr.connectionLabel : 'NO USB' }}</span>
  </div>
  <p>{{ t('Chrome/Edge · WebUSB · one local tuner shared by FM and the Local ADS-B layer.') }}</p>
  <div class="sdr-radio-actions">
    <UiButton id="sdr-connect-btn" @click="act('toggleSdrConnection')" class="panel-layer-toggle" :pressed="sdr?.connectPressed ?? false" pressed-class="active" :disabled="sdr?.connectDisabled">{{ sdr ? sdr.connectLabel : t('CONNECT') }}</UiButton>
    <button id="sdr-locate-btn" type="button" @click="act('locateSdr')" v-class-toggle="{ active: sdr?.locateActive }" :title="t('Use your location for faster ADS-B position decoding')" :disabled="sdr?.locateDisabled">{{ sdr ? sdr.locateLabel : t('LOCATE') }}</button>
    <button id="sdr-change-device-btn" type="button" @click="act('changeSdrDevice')" :title="t('Choose a different RTL-SDR or receiver channel')" :disabled="sdr?.changeDeviceDisabled">{{ t('CHANGE DEVICE') }}</button>
  </div>
  <div class="sdr-mode-row" role="group" :aria-label="t('RTL-SDR receiver mode')">
    <UiButton id="sdr-mode-fm-btn" @click="act('setSdrMode', 'fm')" :pressed="sdr ? sdr.fmActive : true" pressed-class="active" :disabled="sdr?.modeDisabled" translate="no">FM</UiButton>
    <UiButton id="sdr-mode-adsb-btn" @click="act('setSdrMode', 'adsb')" :pressed="sdr?.adsbActive ?? false" pressed-class="active" :disabled="sdr?.modeDisabled" translate="no">ADS-B · 1090</UiButton>
  </div>
  <div class="sdr-gain-row">
    <label for="sdr-gain-select">{{ t('GAIN') }}</label>
    <UiSelect class="gev-field" id="sdr-gain-select" hold :model-value="sdr ? sdr.gain : 'auto'" @update:model-value="act('setSdrGain', $event)" :aria-label="t('RTL-SDR tuner gain for the current mode')" :disabled="sdr?.gainDisabled">
      <option value="auto">{{ t('AUTO') }}</option>
      <option v-for="gain in GAINS" :key="gain" :value="gain" translate="no">{{ localSdrGainOptionLabel(gain) }}</option>
    </UiSelect>
  </div>
  <div id="sdr-adsb-stats" class="sdr-adsb-stats" role="status" aria-live="off" :hidden="sdr ? sdr.statsHidden : true">
    <span><output id="sdr-stat-rate">{{ sdr ? sdr.stats.rate : '--' }}</output> <span>{{ t('MSG/S') }}</span></span>
    <span><output id="sdr-stat-heard">{{ sdr ? sdr.stats.heard : '0' }}</output> <span>{{ t('HEARD') }}</span></span>
    <span><output id="sdr-stat-positioned">{{ sdr ? sdr.stats.positioned : '0' }}</output> <span>{{ t('POSITIONED') }}</span></span>
    <span translate="no">IQ <output id="sdr-stat-iq">{{ sdr ? sdr.stats.iq : '--' }}</output></span>
  </div>
  <div class="sdr-frequency-row">
    <label for="sdr-frequency-input">{{ t('FM MHZ') }}</label>
    <input ref="frequency" class="gev-field" id="sdr-frequency-input" @keydown.enter.prevent="tune" type="number" min="87.5" max="108" step="0.1" value="98.5" inputmode="decimal" :disabled="sdr?.frequencyDisabled" v-field-value="sdr ? sdr.frequency : '98.5'" />
    <button id="sdr-tune-btn" type="button" @click="tune" :disabled="sdr?.tuneDisabled">{{ t('TUNE') }}</button>
  </div>
  <div class="sdr-seek-row" role="group" :aria-label="t('Seek broadcast FM stations')">
    <button id="sdr-seek-back-btn" type="button" @click="act('seekSdr', -1)" :disabled="sdr ? sdr.seekDisabled : true">{{ t('◀ SEEK') }}</button>
    <button id="sdr-seek-forward-btn" type="button" @click="act('seekSdr', 1)" :disabled="sdr ? sdr.seekDisabled : true">{{ t('SEEK ▶') }}</button>
  </div>
  <label class="radio-volume-row" for="sdr-volume">
    <span>{{ t('SDR VOL') }}</span>
    <UiSlider id="sdr-volume" hold @update:model-value="act('setSdrVolume', $event)" min="0" max="100" :aria-label="t('Local SDR volume')" :disabled="sdr?.volumeDisabled" :model-value="sdr ? sdr.volume : 80" />
    <output id="sdr-volume-value" class="gev-slider-value" for="sdr-volume">{{ sdr ? sdr.volumeText : '80%' }}</output>
  </label>
  <div id="sdr-status" class="radio-playback-state" :class="{ error: sdr?.statusError }" role="status" aria-live="polite">{{ sdr ? sdr.statusText : t('Connect an RTL-SDR to begin.') }}</div>
  <div id="sdr-feed-status" class="sdr-feed-status" role="status" aria-live="off" :hidden="sdr ? sdr.feedLine === null : true">{{ sdr?.feedLine ?? '' }}</div>
</div>
</template>
