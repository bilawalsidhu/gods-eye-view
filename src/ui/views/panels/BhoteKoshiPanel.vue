<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useBhoteKoshiPanelStore } from '../../stores/bhoteKoshiPanel.js';
import UiSlider from '../../kit/UiSlider.js';

// The Bhote Koshi reconstruction controls, at the end of the context rail,
// as the event layer (src/data/bhoteKoshiEvent.js) presents them. Clicks and
// slider moves go back to the layer.
const { panel, controls } = storeToRefs(useBhoteKoshiPanelStore());
const call = (name, ...args) => controls.value?.[name]?.(...args);
const sliderValue = (event, scale) => Number(event.target.value) / scale;
</script>

<template>
  <aside v-if="panel" id="bhote-koshi-event-panel" :class="{ 'bhote-event-scene-beat': panel.sceneBeat }" :aria-label="t('Bhote Koshi flood reconstruction controls')">
    <div class="bhote-event-header">
      <div>
        <div class="bhote-event-kicker">{{ t('EVENT RECONSTRUCTION · 26 AUG 2026') }}</div>
        <div class="bhote-event-title">{{ t('BHOTE KOSHI OUTBURST FLOOD') }}</div>
      </div>
      <button class="bhote-event-icon-btn" type="button" data-action="close" :title="t('Close event layer')" :aria-label="t('Close event layer')" @click="call('close')">×</button>
    </div>
    <div class="bhote-event-status-row">
      <span class="bhote-event-status observed" :hidden="panel.refs.observedStatus.hidden">{{ t('OBSERVED IMAGERY') }}</span>
      <span class="bhote-event-status reconstructed">{{ t('SCHEMATIC CORRIDOR') }}</span>
    </div>
    <section class="bhote-event-section" data-role="imagery-comparison" :hidden="panel.refs.imagerySection.hidden">
      <div class="bhote-event-section-head">
        <span>{{ t('2021 HISTORICAL REFERENCE / 2026 POST-EVENT') }}</span>
        <span data-role="split-readout">{{ panel.refs.splitReadout.textContent }}</span>
      </div>
      <UiSlider class="bhote-event-range" unstyled data-role="split" min="0" max="100" :model-value="panel.refs.splitInput.value" :aria-label="t('Historical reference and post-event image split')" @update:model-value="call('setSplit', $event / 100)" />
      <div class="bhote-event-dates">
        <span data-role="before-date">{{ panel.beforeDate.date ? `${panel.beforeDate.name} · ` : panel.beforeDate.name }}<span v-if="panel.beforeDate.date" class="bhote-event-date">{{ panel.beforeDate.date }}</span></span>
        <span data-role="after-date">{{ panel.afterDate.date ? `${panel.afterDate.name} · ` : panel.afterDate.name }}<span v-if="panel.afterDate.date" class="bhote-event-date">{{ panel.afterDate.date }}</span></span>
      </div>
    </section>
    <section class="bhote-event-section">
      <div class="bhote-event-section-head">
        <span data-role="timeline-label">{{ panel.refs.timelineLabel.textContent }}</span>
        <span data-role="time">{{ panel.refs.time.textContent }}</span>
      </div>
      <UiSlider class="bhote-event-range flood" unstyled data-role="progress" min="0" max="1000" :model-value="panel.refs.progressInput.value" :hidden="panel.refs.progressInput.hidden" :disabled="panel.refs.progressInput.disabled" :aria-label="panel.refs.progressInput.attributes['aria-label']" @update:model-value="call('previewProgress', $event / 1000)" @change="call('commitProgress', sliderValue($event, 1000), { final: true })" />
      <div class="bhote-event-story-nav" :aria-label="t('Story beat navigation')">
        <button type="button" data-action="previous-beat" :title="t('Previous story beat')" :aria-label="panel.refs.previousButton.attributes['aria-label']" :disabled="panel.refs.previousButton.disabled" @click="call('previousBeat')">‹</button>
        <div class="bhote-event-story-current">
          <span data-role="beat-index">{{ panel.refs.beatIndex.textContent }}</span>
          <strong data-role="beat-title" aria-live="polite">{{ panel.refs.beatTitle.textContent }}</strong>
          <small data-role="beat-meta">{{ panel.refs.beatMeta.textContent }}</small>
        </div>
        <button type="button" data-action="next-beat" :title="t('Next story beat')" :aria-label="panel.refs.nextButton.attributes['aria-label']" :disabled="panel.refs.nextButton.disabled" @click="call('nextBeat')">›</button>
      </div>
      <div class="bhote-event-actions">
        <button type="button" data-action="play" :aria-label="panel.refs.playButton.attributes['aria-label']" :disabled="panel.refs.playButton.disabled" @click="call('play')">{{ panel.refs.playButton.textContent }}</button>
        <button type="button" data-action="play-scene" :hidden="panel.refs.playSceneButton.hidden" :title="t('Play the next shot and continue through this scene')" :aria-label="panel.refs.playSceneButton.attributes['aria-label']" :disabled="panel.refs.playSceneButton.disabled" @click="call('playScene')">{{ panel.refs.playSceneButton.textContent }}</button>
        <button type="button" data-action="cinematic" :aria-pressed="panel.refs.cinematicButton.attributes['aria-pressed']" :hidden="panel.refs.cinematicButton.hidden" :disabled="panel.refs.cinematicButton.disabled" @click="call('toggleCinematic')">{{ panel.refs.cinematicButton.textContent }}</button>
        <button type="button" data-action="story-replay" :aria-label="panel.refs.storyReplayButton.attributes['aria-label']" :hidden="panel.refs.storyReplayButton.hidden" :disabled="panel.refs.storyReplayButton.disabled" @click="call('replayCinematic')">{{ panel.refs.storyReplayButton.textContent }}</button>
        <button type="button" data-action="open-source" :hidden="panel.refs.openSourceButton.hidden" :disabled="panel.refs.openSourceButton.disabled" @click="call('openActiveSource')">{{ t('↗ OPEN ORIGINAL') }}</button>
        <button type="button" data-action="corridor" :hidden="panel.refs.corridorButton.hidden" :disabled="panel.refs.corridorButton.disabled" @click="call('focusCorridor')">{{ t('⌖ LOWER GORGE') }}</button>
      </div>
    </section>
    <details class="bhote-event-evidence">
      <summary>{{ t('FIELD REPORTS · {count}', { count: panel.reports.length }) }}</summary>
      <div class="bhote-event-report-list"><button v-for="(report, index) in panel.reports" :key="index" type="button" class="bhote-event-report" @click="call('openReport', index)"><span>{{ report.label }}</span><small>{{ report.status }}</small></button></div>
    </details>
    <div class="bhote-event-credit">
      <span>{{ t('GEOLOCATIONS · {credit}', { credit: 'GEO GEORGE SHADRACH' }) }}</span>
      <button type="button" data-action="geolocation-map" @click="call('openGeolocationMap')">{{ t('↗ OPEN PUBLIC MAP') }}</button>
    </div>
    <p class="bhote-event-caveat"><span data-role="caveat">{{ panel.refs.caveat.textContent }}</span><span data-role="imagery-cloud-note" :hidden="panel.refs.imageryCloudNote.hidden">{{ t(' Clouds are preserved from the source imagery.') }}</span></p>
  </aside>
</template>
