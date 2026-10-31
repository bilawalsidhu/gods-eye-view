<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { vFieldValue } from '../../rail/fieldValue.js';
import { useRadioStore } from '../../stores/radio.js';

// The local RTL-SDR card in the Radio panel. LocalSdrControls presents it and
// publishes it; until it does, the card shows its initial markup. The
// numeric gain options are labelled once by the controls.
const { sdr } = storeToRefs(useRadioStore());
</script>

<template>
<div id="sdr-radio-card" class="sdr-radio-card" role="group" aria-label="Local RTL-SDR receiver" data-i18n-aria-label>
  <div class="sdr-radio-heading">
    <strong data-i18n>LOCAL RTL-SDR</strong>
    <span id="sdr-connection-state" v-class-toggle="{ active: sdr?.connectionActive }" data-i18n-runtime>{{ sdr ? sdr.connectionLabel : 'NO USB' }}</span>
  </div>
  <p data-i18n>Chrome/Edge · WebUSB · one local tuner shared by FM and the Local ADS-B layer.</p>
  <div class="sdr-radio-actions">
    <button id="sdr-connect-btn" class="panel-layer-toggle" :class="{ active: sdr?.connectPressed }" type="button" :aria-pressed="String(sdr?.connectPressed ?? false)" :disabled="sdr?.connectDisabled">{{ sdr ? sdr.connectLabel : t('CONNECT') }}</button>
    <button id="sdr-locate-btn" type="button" v-class-toggle="{ active: sdr?.locateActive }" title="Use your location for faster ADS-B position decoding" :disabled="sdr?.locateDisabled" data-i18n-title>{{ sdr ? sdr.locateLabel : t('LOCATE') }}</button>
    <button id="sdr-change-device-btn" type="button" title="Choose a different RTL-SDR or receiver channel" :disabled="sdr?.changeDeviceDisabled" data-i18n-title data-i18n>CHANGE DEVICE</button>
  </div>
  <div class="sdr-mode-row" role="group" aria-label="RTL-SDR receiver mode" data-i18n-aria-label>
    <button id="sdr-mode-fm-btn" class="active" v-class-toggle="sdr ? { active: sdr.fmActive } : null" type="button" :aria-pressed="String(sdr ? sdr.fmActive : true)" :disabled="sdr?.modeDisabled" translate="no">FM</button>
    <button id="sdr-mode-adsb-btn" type="button" v-class-toggle="{ active: sdr?.adsbActive }" :aria-pressed="String(sdr?.adsbActive ?? false)" :disabled="sdr?.modeDisabled" translate="no">ADS-B · 1090</button>
  </div>
  <div class="sdr-gain-row">
    <label for="sdr-gain-select" data-i18n>GAIN</label>
    <select class="gev-field" id="sdr-gain-select" aria-label="RTL-SDR tuner gain for the current mode" :disabled="sdr?.gainDisabled" v-field-value="sdr ? sdr.gain : 'auto'" data-i18n-aria-label>
      <option value="auto" data-i18n>AUTO</option>
      <option value="0.0" translate="no">0.0 dB</option>
      <option value="0.9" translate="no">0.9 dB</option>
      <option value="1.4" translate="no">1.4 dB</option>
      <option value="2.7" translate="no">2.7 dB</option>
      <option value="3.7" translate="no">3.7 dB</option>
      <option value="7.7" translate="no">7.7 dB</option>
      <option value="8.7" translate="no">8.7 dB</option>
      <option value="12.5" translate="no">12.5 dB</option>
      <option value="14.4" translate="no">14.4 dB</option>
      <option value="15.7" translate="no">15.7 dB</option>
      <option value="16.6" translate="no">16.6 dB</option>
      <option value="19.7" translate="no">19.7 dB</option>
      <option value="20.7" translate="no">20.7 dB</option>
      <option value="22.9" translate="no">22.9 dB</option>
      <option value="25.4" translate="no">25.4 dB</option>
      <option value="28.0" translate="no">28.0 dB</option>
      <option value="29.7" translate="no">29.7 dB</option>
      <option value="32.8" translate="no">32.8 dB</option>
      <option value="33.8" translate="no">33.8 dB</option>
      <option value="36.4" translate="no">36.4 dB</option>
      <option value="37.2" translate="no">37.2 dB</option>
      <option value="38.6" translate="no">38.6 dB</option>
      <option value="40.2" translate="no">40.2 dB</option>
      <option value="42.1" translate="no">42.1 dB</option>
      <option value="43.4" translate="no">43.4 dB</option>
      <option value="43.9" translate="no">43.9 dB</option>
      <option value="44.5" translate="no">44.5 dB</option>
      <option value="48.0" translate="no">48.0 dB</option>
      <option value="49.6" translate="no">49.6 dB</option>
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
    <input class="gev-field" id="sdr-frequency-input" type="number" min="87.5" max="108" step="0.1" value="98.5" inputmode="decimal" :disabled="sdr?.frequencyDisabled" v-field-value="sdr ? sdr.frequency : '98.5'" />
    <button id="sdr-tune-btn" type="button" :disabled="sdr?.tuneDisabled" data-i18n>TUNE</button>
  </div>
  <div class="sdr-seek-row" role="group" aria-label="Seek broadcast FM stations" data-i18n-aria-label>
    <button id="sdr-seek-back-btn" type="button" :disabled="sdr ? sdr.seekDisabled : true" data-i18n>◀ SEEK</button>
    <button id="sdr-seek-forward-btn" type="button" :disabled="sdr ? sdr.seekDisabled : true" data-i18n>SEEK ▶</button>
  </div>
  <label class="radio-volume-row" for="sdr-volume">
    <span data-i18n>SDR VOL</span>
    <input id="sdr-volume" class="gev-quantitative-slider" type="range" min="0" max="100" value="80" aria-label="Local SDR volume" :disabled="sdr?.volumeDisabled" v-field-value="sdr ? sdr.volume : 80" data-i18n-aria-label />
    <output id="sdr-volume-value" class="gev-slider-value" for="sdr-volume">{{ sdr ? sdr.volumeText : '80%' }}</output>
  </label>
  <div id="sdr-status" class="radio-playback-state" :class="{ error: sdr?.statusError }" role="status" aria-live="polite">{{ sdr ? sdr.statusText : t('Connect an RTL-SDR to begin.') }}</div>
  <div id="sdr-feed-status" class="sdr-feed-status" role="status" aria-live="off" :hidden="sdr ? sdr.feedLine === null : true">{{ sdr?.feedLine ?? '' }}</div>
</div>
</template>
