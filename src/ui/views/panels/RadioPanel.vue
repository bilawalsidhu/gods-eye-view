<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { vRangeValue } from '../../rail/rangeValue.js';
import { useRadioStore } from '../../stores/radio.js';

// The Radio panel inside Context. RadioControls presents the directory row,
// station card, transport, volume and playback line and publishes them;
// until it does, the panel shows its initial markup. The tuner and the
// local SDR card keep their owners' element bindings.
const { view: radio } = storeToRefs(useRadioStore());
</script>

<template>
<section id="radio-panel" class="panel-collapsible collapsed" v-class-toggle="radio ? { 'radio-enabled': radio.enabled, 'lifecycle-uncertain': radio.uncertain } : null" data-panel-id="radio-panel" aria-label="Internet radio and local SDR" data-i18n-aria-label>
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
      <input id="radio-volume" class="gev-quantitative-slider" type="range" min="0" max="100" value="80" aria-label="Radio volume" :disabled="radio?.volume.disabled" v-range-value="radio ? radio.volume.value : 80" data-i18n-aria-label />
      <output id="radio-volume-value" class="gev-slider-value" for="radio-volume">{{ radio ? `${radio.volume.value}%` : '80%' }}</output>
    </label>
    <div id="radio-playback-state" class="radio-playback-state" :class="{ error: radio?.playback.error }" role="status" aria-live="polite">{{ radio ? radio.playback.text : t('Radio off') }}</div>
    <div class="radio-links">
      <a id="radio-station-homepage" :href="radio ? radio.station.homepage || undefined : '#'" target="_blank" rel="noopener noreferrer" :hidden="radio ? !radio.station.homepage : true" data-i18n>STATION SITE</a>
      <a href="https://www.radio-browser.info/" target="_blank" rel="noopener noreferrer" data-i18n>DIRECTORY: RADIO BROWSER</a>
    </div>
    <p class="radio-privacy" data-i18n>Audio connects directly to the broadcaster after you press play. Your IP is visible to that broadcaster.</p>
    <div id="sdr-radio-card" class="sdr-radio-card" role="group" aria-label="Local RTL-SDR receiver" data-i18n-aria-label>
      <div class="sdr-radio-heading">
        <strong data-i18n>LOCAL RTL-SDR</strong>
        <span id="sdr-connection-state" data-i18n-runtime>NO USB</span>
      </div>
      <p data-i18n>Chrome/Edge · WebUSB · one local tuner shared by FM and the Local ADS-B layer.</p>
      <div class="sdr-radio-actions">
        <button id="sdr-connect-btn" class="panel-layer-toggle" type="button" aria-pressed="false" data-i18n>CONNECT</button>
        <button id="sdr-locate-btn" type="button" title="Use your location for faster ADS-B position decoding" data-i18n-title data-i18n>LOCATE</button>
        <button id="sdr-change-device-btn" type="button" title="Choose a different RTL-SDR or receiver channel" data-i18n-title data-i18n>CHANGE DEVICE</button>
      </div>
      <div class="sdr-mode-row" role="group" aria-label="RTL-SDR receiver mode" data-i18n-aria-label>
        <button id="sdr-mode-fm-btn" class="active" type="button" aria-pressed="true" translate="no">FM</button>
        <button id="sdr-mode-adsb-btn" type="button" aria-pressed="false" translate="no">ADS-B · 1090</button>
      </div>
      <div class="sdr-gain-row">
        <label for="sdr-gain-select" data-i18n>GAIN</label>
        <select class="gev-field" id="sdr-gain-select" aria-label="RTL-SDR tuner gain for the current mode" data-i18n-aria-label>
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
      <div id="sdr-adsb-stats" class="sdr-adsb-stats" role="status" aria-live="off" hidden>
        <span><output id="sdr-stat-rate">--</output> <span data-i18n>MSG/S</span></span>
        <span><output id="sdr-stat-heard">0</output> <span data-i18n>HEARD</span></span>
        <span><output id="sdr-stat-positioned">0</output> <span data-i18n>POSITIONED</span></span>
        <span translate="no">IQ <output id="sdr-stat-iq">--</output></span>
      </div>
      <div class="sdr-frequency-row">
        <label for="sdr-frequency-input" data-i18n>FM MHZ</label>
        <input class="gev-field" id="sdr-frequency-input" type="number" min="87.5" max="108" step="0.1" value="98.5" inputmode="decimal" />
        <button id="sdr-tune-btn" type="button" data-i18n>TUNE</button>
      </div>
      <div class="sdr-seek-row" role="group" aria-label="Seek broadcast FM stations" data-i18n-aria-label>
        <button id="sdr-seek-back-btn" type="button" disabled data-i18n>◀ SEEK</button>
        <button id="sdr-seek-forward-btn" type="button" disabled data-i18n>SEEK ▶</button>
      </div>
      <label class="radio-volume-row" for="sdr-volume">
        <span data-i18n>SDR VOL</span>
        <input id="sdr-volume" class="gev-quantitative-slider" type="range" min="0" max="100" value="80" aria-label="Local SDR volume" data-i18n-aria-label />
        <output id="sdr-volume-value" class="gev-slider-value" for="sdr-volume">80%</output>
      </label>
      <div id="sdr-status" class="radio-playback-state" role="status" aria-live="polite" data-i18n>Connect an RTL-SDR to begin.</div>
      <div id="sdr-feed-status" class="sdr-feed-status" role="status" aria-live="off" hidden></div>
    </div>
  </div>
</section>
</template>
