<script setup>
import { storeToRefs } from 'pinia';
import { defineAsyncComponent, ref } from 'vue';
import { t } from '../../../i18n/index.js';
import { HACKRF_GAIN_STEPS_DB, R820T_GAIN_STEPS_DB } from '../../../sdr/gain.js';
import { localSdrGainOptionLabel } from '../../localSdrPresentation.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { vFieldValue } from '../../rail/fieldValue.js';
import UiSlider from '../../kit/UiSlider.js';
import { useRadioStore } from '../../stores/radio.js';
import UiButton from '../../kit/UiButton.vue';
import UiSelect from '../../kit/UiSelect.js';

// The local SDR card in the Radio panel. LocalSdrControls presents it and
// publishes it; until it does, the card shows its initial markup. Its
// controls call LocalSdrControls through the store. The numeric gain
// options read in the page language; their values stay numeric.
const radio = useRadioStore();
const { sdr } = storeToRefs(radio);
const { act } = radio;
const frequency = ref(null);
const GAINS = R820T_GAIN_STEPS_DB.map((gain) => gain.toFixed(1));
const tune = () => act('tuneSdr', frequency.value.value);
const AircraftAtcChannels = defineAsyncComponent(() => import('./AircraftAtcChannels.vue'));
</script>

<template>
<div id="sdr-radio-card" class="sdr-radio-card" role="group" :aria-label="t('Local SDR receiver')">
  <div class="sdr-radio-heading">
    <strong>{{ t('LOCAL SDR') }}</strong>
    <span id="sdr-connection-state" v-class-toggle="{ active: sdr?.connectionActive }">{{ sdr ? sdr.connectionLabel : 'NO USB' }}</span>
  </div>
  <p>{{ t('Chrome/Edge · WebUSB · one local tuner for FM, ATC or ADS-B.') }}</p>
  <div class="sdr-gain-row">
    <label for="sdr-receiver-select">{{ t('Receiver') }}</label>
    <UiSelect class="gev-field" id="sdr-receiver-select" :model-value="sdr?.receiverKind ?? 'rtl'" @update:model-value="act('selectSdrReceiver', $event)" :disabled="sdr?.receiverDisabled ?? true">
      <option value="rtl" translate="no">RTL-SDR</option>
      <option value="hackrf" translate="no">HackRF One</option>
    </UiSelect>
  </div>
  <div class="sdr-radio-actions">
    <UiButton id="sdr-connect-btn" @click="act('toggleSdrConnection')" class="panel-layer-toggle" :pressed="sdr?.connectPressed ?? false" pressed-class="active" :disabled="sdr?.connectDisabled">{{ sdr ? sdr.connectLabel : t('CONNECT') }}</UiButton>
    <UiButton id="sdr-locate-btn" @click="act('locateSdr')" v-class-toggle="{ active: sdr?.locateActive }" :title="t('Use your location for faster ADS-B position decoding')" :disabled="sdr?.locateDisabled">{{ sdr ? sdr.locateLabel : t('LOCATE') }}</UiButton>
    <UiButton id="sdr-change-device-btn" @click="act('changeSdrDevice')" :title="t('Choose a different SDR or receiver channel')" :disabled="sdr?.changeDeviceDisabled">{{ t('CHANGE DEVICE') }}</UiButton>
  </div>
  <div class="sdr-mode-row" role="group" :aria-label="t('SDR receiver mode')">
    <UiButton id="sdr-mode-fm-btn" @click="act('setSdrMode', 'fm')" :pressed="sdr ? sdr.fmActive : true" pressed-class="active" :disabled="sdr?.modeDisabled" translate="no">FM</UiButton>
    <UiButton id="sdr-mode-atc-btn" @click="act('setSdrMode', 'atc')" :pressed="sdr?.atcActive ?? false" pressed-class="active" :disabled="sdr?.modeDisabled" translate="no">ATC · AM</UiButton>
    <UiButton id="sdr-mode-adsb-btn" @click="act('setSdrMode', 'adsb')" :pressed="sdr?.adsbActive ?? false" pressed-class="active" :disabled="sdr?.modeDisabled" translate="no">ADS-B · 1090</UiButton>
  </div>
  <div v-if="sdr?.receiverKind !== 'hackrf'" class="sdr-gain-row">
    <label for="sdr-gain-select">{{ t('GAIN') }}</label>
    <UiSelect class="gev-field" id="sdr-gain-select" hold :model-value="sdr ? sdr.gain : 'auto'" @update:model-value="act('setSdrGain', $event)" :aria-label="t('RTL-SDR tuner gain for the current mode')" :disabled="sdr?.gainDisabled">
      <option value="auto">{{ t('AUTO') }}</option>
      <option v-for="gain in GAINS" :key="gain" :value="gain" translate="no">{{ localSdrGainOptionLabel(gain) }}</option>
    </UiSelect>
  </div>
  <template v-else>
    <div v-for="(steps, stage) in HACKRF_GAIN_STEPS_DB" :key="stage" class="sdr-gain-row">
      <label :for="'sdr-hackrf-' + stage" translate="no">{{ stage.toUpperCase() }}</label>
      <UiSelect class="gev-field" :id="'sdr-hackrf-' + stage" hold :model-value="sdr.hackrfGain?.[stage]" @update:model-value="act('setHackrfGain', stage, $event)" :disabled="sdr.gainDisabled">
        <option v-for="gain in steps" :key="gain" :value="gain" translate="no">{{ localSdrGainOptionLabel(gain) }}</option>
      </UiSelect>
    </div>
    <div class="sdr-gain-row">
      <label for="sdr-hackrf-amp" translate="no">AMP</label>
      <UiSelect class="gev-field" id="sdr-hackrf-amp" hold :model-value="sdr.hackrfGain?.amp ? 'on' : 'off'" @update:model-value="act('setHackrfGain', 'amp', $event === 'on')" :disabled="sdr.gainDisabled">
        <option value="off">{{ t('OFF') }}</option>
        <option value="on">{{ t('ON') }}</option>
      </UiSelect>
    </div>
  </template>
  <div id="sdr-adsb-stats" class="sdr-adsb-stats" role="status" aria-live="off" :hidden="sdr ? sdr.statsHidden : true">
    <span><output id="sdr-stat-rate">{{ sdr ? sdr.stats.rate : '--' }}</output> <span>{{ t('MSG/S') }}</span></span>
    <span><output id="sdr-stat-heard">{{ sdr ? sdr.stats.heard : '0' }}</output> <span>{{ t('HEARD') }}</span></span>
    <span><output id="sdr-stat-positioned">{{ sdr ? sdr.stats.positioned : '0' }}</output> <span>{{ t('POSITIONED') }}</span></span>
    <span translate="no">IQ <output id="sdr-stat-iq">{{ sdr ? sdr.stats.iq : '--' }}</output></span>
  </div>
  <div class="sdr-frequency-row">
    <label for="sdr-frequency-input">{{ sdr?.atcActive ? t('ATC channel') : t('FM MHZ') }}</label>
    <input v-if="sdr?.atcActive" key="atc" id="sdr-frequency-input" ref="frequency" class="gev-field" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" :disabled="sdr.frequencyDisabled" :aria-invalid="sdr.invalidAtcChannel || undefined" :aria-describedby="sdr.invalidAtcChannel ? 'sdr-atc-channel-error' : undefined" @input="act('clearSdrTuneError')" @keydown.enter.prevent="tune" v-field-value="sdr.frequency" />
    <input v-else key="fm" ref="frequency" class="gev-field" id="sdr-frequency-input" @keydown.enter.prevent="tune" type="number" min="87.5" max="108" step="0.1" value="98.5" inputmode="decimal" :disabled="sdr?.frequencyDisabled" v-field-value="sdr ? sdr.frequency : '98.5'" />
    <UiButton id="sdr-tune-btn" @click="tune" :disabled="sdr?.tuneDisabled">{{ t('TUNE') }}</UiButton>
  </div>
  <p v-if="sdr?.invalidAtcChannel" id="sdr-atc-channel-error" class="radio-playback-state error" role="status">{{ t('Enter a valid ATC channel, such as 118.005.') }}</p>
  <div v-if="!sdr?.atcActive" class="sdr-seek-row" role="group" :aria-label="t('Seek broadcast FM stations')">
    <UiButton id="sdr-seek-back-btn" @click="act('seekSdr', -1)" :disabled="sdr ? sdr.seekDisabled : true">{{ t('◀ SEEK') }}</UiButton>
    <UiButton id="sdr-seek-forward-btn" @click="act('seekSdr', 1)" :disabled="sdr ? sdr.seekDisabled : true">{{ t('SEEK ▶') }}</UiButton>
  </div>
  <label class="radio-volume-row" for="sdr-volume">
    <span>{{ t('SDR VOL') }}</span>
    <UiSlider id="sdr-volume" hold @update:model-value="act('setSdrVolume', $event)" min="0" max="100" :aria-label="t('Local SDR volume')" :disabled="sdr?.volumeDisabled" :model-value="sdr ? sdr.volume : 80" />
    <output id="sdr-volume-value" class="gev-slider-value" for="sdr-volume">{{ sdr ? sdr.volumeText : '80%' }}</output>
  </label>
  <div id="sdr-status" class="radio-playback-state" :class="{ error: sdr?.statusError }" role="status" aria-live="polite">{{ sdr ? sdr.statusText : t('Connect an RTL-SDR to begin.') }}</div>
  <div id="sdr-feed-status" class="sdr-feed-status" role="status" aria-live="off" :hidden="sdr ? sdr.feedLine === null : true">{{ sdr?.feedLine ?? '' }}</div>
  <AircraftAtcChannels v-if="sdr?.atcActive" />
</div>
</template>
