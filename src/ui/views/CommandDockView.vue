<script setup>
import { storeToRefs } from 'pinia';
import { msg, t } from '../../i18n/index.js';
import { vPanelState } from '../rail/panelState.js';
import UiButton from '../kit/UiButton.vue';
import { vClassToggle } from '../rail/classToggle.js';
import { useDisplayStore } from '../stores/display.js';
import { computed } from 'vue';
import { useLocationStore } from '../stores/location.js';
import { usePanelChromeStore } from '../stores/panelChrome.js';
import { usePointerReticleStore } from '../stores/pointerReticle.js';
import { useVoiceStore } from '../stores/voice.js';
import PhoneTabBar from './panels/PhoneTabBar.vue';
import VoiceControl from './panels/VoiceControl.vue';

// VisualSettings publishes the active style and the map source controls
// their chip row; until they do, the dock shows its initial markup. A style
// button calls the Display controls' owner, a chip the map source controls.
const display = useDisplayStore();
const { style, mapSource, mapSourceControls } = storeToRefs(display);
// LocationControls publishes the location tray; pills call the controls,
// and the search field keeps their listeners.
const { view: loc, controls: locationControls } = storeToRefs(useLocationStore());

// PanelChrome presents each tray's open and pinned state; the tray toggles
// keep its hover and focus listeners, and the pins call it.
const chrome = usePanelChromeStore();
const { panels } = storeToRefs(chrome);
/** A tray toggle's words, or `fallback` until the tray is presented. */
function trayWords(panelId, name, fallback) {
  const state = panels.value[panelId];
  if (!state) return fallback;
  return t(state.collapsed ? msg('Expand {name}') : msg('Collapse {name}'), {
    name,
  });
}
/** A pin's click: a pin never opens the tray behind it. */
function pin(event, panelId) {
  event.stopPropagation();
  chrome.act('pin', panelId);
}

// The voice control, while a voice session presents one. It sits between the
// location bar and the visual presets; the trays keep their elements when the
// order changes.
const { view: voice } = storeToRefs(useVoiceStore());
// Once voice has taken its place, the location bar stays first.
let voiceShown = false;
const dockOrder = computed(() => {
  if (voice.value) voiceShown = true;
  return voice.value
    ? ['location', 'voice', 'control']
    : voiceShown
      ? ['location', 'control']
      : ['control', 'location'];
});

// Where the user pointed while a voice turn is live (PointerReticle).
const { reticles } = storeToRefs(usePointerReticleStore());

function selectMapSource(chip) {
  if (!chip.available) return;
  void mapSourceControls.value?.select(chip.id).catch(() => {});
}
</script>

<template>
  <!-- Unified bottom command dock: locations, voice, visual presets -->
  <div id="command-dock" class="ui-scroll" :aria-label="t('Navigation, voice, and visual preset controls')">
  <template v-for="slot in dockOrder" :key="slot">
  <!-- Control panel -->
  <div v-if="slot === 'control'" id="control-panel" v-panel-state="'control-panel'" class="panel-collapsible collapsed">
    <div class="panel-glow"></div>
    <div class="panel-inner">
      <button id="control-panel-toggle" class="panel-header dock-tray-toggle" type="button"
        data-dock-toggle-target="control-panel" :aria-expanded="String(panels['control-panel']?.collapsed === false)"
        aria-controls="control-panel-popover" :aria-label="trayWords('control-panel', t('VISUAL PRESETS'), t('Expand Visual Presets'))" :title="trayWords('control-panel', t('VISUAL PRESETS'), undefined)">
        <span class="panel-title"><span class="dock-label-icon dock-label-icon-presets" aria-hidden="true"></span>{{ t('VISUAL PRESETS') }}</span>
        <span class="panel-divider"></span>
      </button>
      <div id="control-panel-popover" class="dock-popover-content">
      <UiButton variant="icon" class="dock-pin-btn" data-pin-target="control-panel" :label="t('Pin visual presets')" :title="t('Keep visual presets open')" :pressed="!!panels['control-panel']?.pinned" @click="pin($event, 'control-panel')"><img src="/pin.svg" alt="" /></UiButton>
      <div id="style-buttons" class="button-grid">
        <button class="style-btn active" data-style="normal" @click="display.act('setStyle', 'normal')" v-class-toggle="{ ...(style && { active: style.name === 'normal' }) }" :title="t('Show the globe without a visual filter.')">
          <span class="btn-icon">◯</span>
          <span class="btn-label">{{ t('Normal') }}</span>
          <span class="btn-key">1</span>
        </button>
        <button class="style-btn" data-style="retro" @click="display.act('setStyle', 'retro')" v-class-toggle="{ ...(style && { active: style.name === 'retro' }) }" :title="t('Emulate a green phosphor CRT with scanlines and screen curvature.')">
          <span class="btn-icon">▦</span>
          <span class="btn-label">{{ t('CRT') }}</span>
          <span class="btn-key">2</span>
        </button>
        <button class="style-btn" data-style="surveillance" @click="display.act('setStyle', 'surveillance')" v-class-toggle="{ ...(style && { active: style.name === 'surveillance' }) }" :title="t('Simulate night-vision goggles with green intensification and a tube vignette.')">
          <span class="btn-icon">🌙</span>
          <span class="btn-label">{{ t('NVG') }}</span>
          <span class="btn-key">3</span>
        </button>
        <button class="style-btn" data-style="thermal" @click="display.act('setStyle', 'thermal')" v-class-toggle="{ ...(style && { active: style.name === 'thermal' }) }" :title="t('Simulate FLIR-style thermal contrast. Turn up Ironbow for color.')">
          <span class="btn-icon">🌡️</span>
          <span class="btn-label">{{ t('FLIR') }}</span>
          <span class="btn-key">4</span>
        </button>
        <button class="style-btn" data-style="anime" @click="display.act('setStyle', 'anime')" v-class-toggle="{ ...(style && { active: style.name === 'anime' }) }" :title="t('Apply bright cel-shaded color and illustrated outlines.')">
          <span class="btn-icon">✦</span>
          <span class="btn-label">{{ t('Anime') }}</span>
          <span class="btn-key">5</span>
        </button>
        <button class="style-btn" data-style="noir" @click="display.act('setStyle', 'noir')" v-class-toggle="{ ...(style && { active: style.name === 'noir' }) }" :title="t('Apply high-contrast monochrome film-noir grading.')">
          <span class="btn-icon">◐</span>
          <span class="btn-label">{{ t('Noir') }}</span>
          <span class="btn-key">6</span>
        </button>
      </div>
      <section class="map-source-section" aria-labelledby="map-source-label">
        <div class="map-source-heading">
          <span id="map-source-label">{{ t('MAP SOURCE') }}</span>
          <span id="map-stack-status" class="pp-stack-status" v-class-toggle="{ warn: !!mapSource?.status.warn }" aria-live="polite">{{ mapSource ? mapSource.status.text : '3D' }}</span>
        </div>
        <div id="map-stack-chips" class="map-stack-chip-row" role="group" :aria-label="t('Map source')"><UiButton v-for="chip in mapSource?.chips" :key="chip.id" class="map-stack-chip" :pressed="Boolean(chip.active)" pressed-class="active" v-class-toggle="{ unavailable: !chip.available }" :data-stack-id="chip.id" :title="chip.title" :aria-disabled="String(!chip.available)" :aria-label="chip.ariaLabel" @click="selectMapSource(chip)"><span class="map-stack-chip-label">{{ chip.label }}</span><span v-if="chip.requirement" class="map-stack-chip-req">{{ chip.requirement }}</span></UiButton></div>
      </section>
      </div>
      <div id="style-mini-status" class="panel-mini-status" aria-live="polite">
        <span class="panel-mini-label">{{ t('Style') }}</span>
        <span id="style-mini-value" class="panel-mini-value">{{ style ? style.label : t('NORMAL') }}</span>
      </div>
    </div>
  </div>

  <VoiceControl v-else-if="slot === 'voice'" :key="voice.id" :view="voice" />

  <!-- Location bar -->
  <div v-else-if="slot === 'location'" id="location-bar" v-panel-state="'location-bar'" class="panel-collapsible collapsed">
    <div class="panel-glow"></div>
    <div class="location-inner">
      <div class="location-toolbar">
        <button id="location-bar-toggle" class="dock-tray-toggle" type="button" data-dock-toggle-target="location-bar" aria-controls="location-bar-popover" :aria-expanded="String(panels['location-bar']?.collapsed === false)" :aria-label="trayWords('location-bar', t('LOCATION'), t('Expand LOCATION'))" :title="trayWords('location-bar', t('LOCATION'), t('Expand LOCATION'))">
          <span class="location-toolbar-label"><span class="dock-label-icon dock-label-icon-location" aria-hidden="true"></span>{{ t('LOCATION') }}</span>
        </button>
        <button class="panel-collapse-btn" data-collapse-target="location-bar" :title="t('Collapse panel')" @click="chrome.act('toggle', 'location-bar')">+</button>
      </div>
      <div id="location-mini-status" class="location-mini-status" aria-live="polite">
        <div id="location-mini-city" class="location-mini-city">{{ loc ? loc.status.city : t('📍 Location: --') }}</div>
        <div id="location-mini-poi" class="location-mini-poi">{{ loc ? loc.status.poi : t('Landmark: --') }}</div>
      </div>
      <div id="location-bar-popover" class="dock-popover-content">
        <UiButton variant="icon" class="dock-pin-btn" data-pin-target="location-bar" :label="t('Pin location tray')" :title="t('Keep location tray open')" :pressed="!!panels['location-bar']?.pinned" @click="pin($event, 'location-bar')"><img src="/pin.svg" alt="" /></UiButton>
        <div id="poi-row" class="poi-row-container" v-class-toggle="{ expanded: !!loc?.poisExpanded }"><UiButton v-for="poi in loc?.pois" :key="`${loc.poiCity}:${poi.index}`" class="poi-pill" :pressed="Boolean(poi.active)" pressed-class="active" :data-poi-index="poi.index" @click="locationControls?.choosePoi(poi.index)"><span class="poi-pill-key">{{ poi.key }}</span><span class="poi-pill-name">{{ poi.name }}</span></UiButton></div>
        <div class="location-bar-divider" id="location-bar-divider" v-class-toggle="{ visible: !!loc?.poisExpanded }"></div>
        <div class="location-city-row">
          <div id="location-pills" class="location-pills"><UiButton v-for="city in loc?.cities" :key="city.id" class="location-pill" :pressed="Boolean(city.active)" pressed-class="active" :data-location-id="city.id" @click="locationControls?.chooseCity(city.id)">{{ city.label }}</UiButton></div>
          <div class="location-search-wrap">
            <button id="search-toggle" class="search-toggle-btn" :title="t('Search any location')" @click="locationControls?.toggleSearch()">
              <span>&#x1F50E;</span>
            </button>
            <input type="text" id="location-search" v-class-toggle="{ expanded: !!loc?.searchExpanded, searching: !!loc?.searching }" :placeholder="t('Search any location...')" autocomplete="off" spellcheck="false" :aria-label="t('Search location by name or coordinates')" :aria-invalid="loc?.searchError ? 'true' : null" :aria-describedby="loc?.searchError ? 'location-search-error' : null" />
          </div>
        </div>
        <p id="location-search-error" class="location-search-error" role="alert">{{ loc?.searchError }}</p>
      </div>
    </div>
  </div>
  </template>
  <PhoneTabBar />
  <Teleport to="body">
    <div v-for="reticle in reticles" :key="reticle.owner.key" class="gev-pointer-reticle" aria-hidden="true" :hidden="!reticle.visible" :data-target="reticle.target" :style="{ left: `${reticle.left}px`, top: `${reticle.top}px` }"></div>
  </Teleport>
  </div>
</template>
