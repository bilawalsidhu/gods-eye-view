<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { vPanelState } from '../../rail/panelState.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vRangeValue } from '../../rail/rangeValue.js';
import UiSegmented from '../../kit/UiSegmented.vue';
import { useDisplayStore } from '../../stores/display.js';

// The Display panel. VisualSettings presents the HUD, Sonar, Scope,
// Celestial, detection, bloom and sharpen, AircraftDisplay the 3D group, the
// draw tool its controls and the file import its list, and each publishes
// them; until they do, the panel shows its initial markup.
const display = useDisplayStore();
const { view, models3d, draw, geoImport } = storeToRefs(display);
// A control's change goes to the Display controls' owner (DisplayBindings).
const act = (name, ...args) => display.act(name, ...args);
const integer = (event) => parseInt(event.target.value, 10);
const pct = (value) => `${value}%`;
const hud = computed(() => view.value?.hud ?? null);
const sonar = computed(() => view.value?.sonar ?? null);
const sonarOn = computed(() => sonar.value?.enabled ?? true);
const detection = computed(() => view.value?.detection ?? null);
const detectButton = computed(() => detection.value?.button ?? null);
const allocation = computed(() => detection.value?.allocation ?? 'ELASTIC');
const scopeOn = computed(() => view.value?.scope.enabled ?? true);
const scopeFeather = computed(() => view.value?.scope.featherPct ?? 100);
const celestial = computed(() => view.value?.celestial ?? null);
const celestialTitle = computed(() =>
  celestial.value && !celestial.value.supported
    ? t('Celestial ring — available in Normal style')
    : t('Celestial ring — reveal the full globe'),
);
const models3dOn = computed(() => models3d.value?.pressed ?? true);
const modelsMode = computed(() => models3d.value?.mode ?? 'proximity');
// A segmented control's segment, selected when `current` holds its value.
const segment = (current) => (value) => ({
  class: { active: current.value === value },
  'aria-checked': String(current.value === value),
});
const modelsOptions = [
  { value: 'proximity', label: t('Proximity'), attrs: { id: 'models3d-mode-proximity', 'data-mode': 'proximity' } },
  { value: 'all', label: t('All'), attrs: { id: 'models3d-mode-all', 'data-mode': 'all' } },
];
const drawShape = computed(() => draw.value?.shape ?? 'area');
const drawSegment = segment(drawShape);
const allocationOptions = [
  { value: 'ELASTIC', label: t('Elastic'), attrs: { id: 'detection-allocation-elastic', 'data-allocation': 'ELASTIC' } },
  { value: 'WEIGHTED', label: t('Weighted'), attrs: { id: 'detection-allocation-weighted', 'data-allocation': 'WEIGHTED' } },
];
const geoRows = computed(() => geoImport.value?.rows ?? []);
const geoListed = computed(() => geoRows.value.length > 0);
</script>

<template>
<!-- Post-processing toggles (top-right) -->
<div id="pp-toggles" v-panel-state="'pp-toggles'" class="panel-collapsible collapsed ui-scroll" data-panel-id="pp-toggles">
  <div class="compact pp-header-row">
    <span data-i18n class="pp-header-label">DISPLAY</span>
    <span class="panel-divider" aria-hidden="true"></span>
    <PanelCollapseButton class="pp-collapse-btn" target="pp-toggles" :name="t('DISPLAY')" sideways start-collapsed />
  </div>
  <div class="pp-panel-body ui-scroll" data-rail-scroller>
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: hud?.visible }" id="hud-toggle" @click="act('toggleHud')" title="Intelligence HUD (H)" data-i18n-title>
      <span class="pp-icon">&#x25CE;</span>
      <span class="pp-label" translate="no">HUD</span>
    </button>
    <div class="pp-slider-row" :class="{ visible: hud?.visible }" id="hud-layout-row">
      <span class="pp-slider-mini-label" data-i18n>Layout</span>
      <select id="hud-layout-select" @change="act('setHudLayout', $event.target.value)" class="pp-select gev-field gev-field--compact" v-range-value="hud?.variant ?? 'tactical'" aria-label="HUD layout" data-i18n-aria-label>
        <option value="tactical" data-i18n>Tactical</option>
        <option value="minimal" data-i18n>Minimal</option>
        <option value="cyber" data-i18n>Cyber</option>
      </select>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-toggle-row" id="cyber-sonar-row">
      <span class="pp-slider-mini-label" data-i18n>Sonar</span>
      <button class="pp-mode-btn" :class="{ active: sonarOn }" id="cyber-sonar-toggle" @click="act('toggleSonar')" title="Cyber sonar contact scanner" aria-label="Cyber sonar contact scanner" :aria-pressed="String(sonarOn)" data-i18n-title data-i18n-aria-label>{{ sonarOn ? t('ON') : t('OFF') }}</button>
    </div>
    <output id="cyber-sonar-status" class="cyber-sonar-control" role="status"></output>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-rings-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-rings" data-i18n>Rings</label>
      <input type="range" class="gev-quantitative-slider pp-slider" id="cyber-sonar-rings" @input="act('setSonarRings', integer($event))" min="3" max="12" step="1" value="8" v-range-value="sonar?.rings ?? 8" aria-label="Sonar ring count" data-i18n-aria-label />
      <span class="pp-slider-value" id="cyber-sonar-rings-value">{{ sonar?.rings ?? 8 }}</span>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-range-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-range" data-i18n>Range</label>
      <input type="range" class="gev-quantitative-slider pp-slider" id="cyber-sonar-range" @input="act('setSonarRange', integer($event))" min="60" max="120" step="1" value="100" v-range-value="sonar?.range ?? 100" aria-label="Sonar ring range" data-i18n-aria-label />
      <span class="pp-slider-value" id="cyber-sonar-range-value">{{ pct(sonar?.range ?? 100) }}</span>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-intensity-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-intensity" data-i18n>Power</label>
      <input type="range" class="gev-quantitative-slider pp-slider" id="cyber-sonar-intensity" @input="act('setSonarIntensity', integer($event))" min="0" max="100" step="1" value="70" v-range-value="sonar?.intensity ?? 70" aria-label="Sonar intensity" data-i18n-aria-label />
      <span class="pp-slider-value" id="cyber-sonar-intensity-value">{{ pct(sonar?.intensity ?? 70) }}</span>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-opacity-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-opacity" data-i18n>Opacity</label>
      <input type="range" class="gev-quantitative-slider pp-slider" id="cyber-sonar-opacity" @input="act('setSonarOpacity', integer($event))" min="35" max="100" step="1" value="84" v-range-value="sonar?.opacity ?? 84" aria-label="Cyber contact and label opacity" title="Minimum opacity for map dots, icons, models, brackets, and labels between sonar passes" data-i18n-aria-label data-i18n-title />
      <span class="pp-slider-value" id="cyber-sonar-opacity-value">{{ pct(sonar?.opacity ?? 84) }}</span>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-sector-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-sector" data-i18n>Sector</label>
      <input type="range" class="gev-quantitative-slider pp-slider" id="cyber-sonar-sector" @input="act('setSonarSector', integer($event))" min="8" max="60" step="1" value="24" v-range-value="sonar?.sector ?? 24" aria-label="Sonar sector width" data-i18n-aria-label />
      <span class="pp-slider-value" id="cyber-sonar-sector-value">{{ `${sonar?.sector ?? 24}°` }}</span>
    </div>
  </div>
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: detectButton?.active, panoptic: detectButton?.panoptic }" id="detection-toggle" @click="act('cycleDetection')" title="Detection Overlay (D)" :aria-label="detectButton?.ariaLabel ?? t('Detection overlay')" :aria-pressed="String(detectButton?.pressed ?? false)" data-i18n-title>
      <span class="pp-icon">&#x25A3;</span>
      <span class="pp-label">{{ detectButton?.label ?? t('DETECT') }}</span>
    </button>
    <div class="pp-slider-row detection-slider-row" :class="{ visible: detection?.rowsVisible }" id="detection-slider-row">
      <label class="pp-slider-mini-label" for="detection-density-slider" data-i18n>Density</label>
      <input type="range" class="gev-quantitative-slider pp-slider" id="detection-density-slider" @input="act('setDensity', $event.target.value)" min="0" max="100" step="25" value="50" v-range-value="detection?.densityPct ?? 50" aria-label="Detection label density" data-i18n-aria-label />
      <span class="pp-slider-value" id="detection-density-value">{{ pct(detection?.densityPct ?? 50) }}</span>
    </div>
    <div class="pp-slider-row detection-allocation-row" :class="{ visible: detection?.rowsVisible }" id="detection-allocation-row">
      <span class="pp-slider-mini-label" data-i18n>Allocation</span>
      <UiSegmented class="pp-mode-seg detection-allocation-seg" item-class="pp-mode-btn" keyboard="none" :label="t('Detection label allocation')" :options="allocationOptions" :model-value="allocation" @update:model-value="act('setAllocation', $event)" />
    </div>
    <div class="pp-slider-row detection-fade-row" :class="{ visible: detection?.rowsVisible }" id="detection-fade-row">
      <label class="pp-slider-mini-label" for="detection-fade-slider" data-i18n>Fade</label>
      <input type="range" class="gev-quantitative-slider pp-slider" id="detection-fade-slider" @input="act('setFade', integer($event))" min="0" max="40" step="1" value="7" v-range-value="detection?.fadePct ?? 7" aria-label="Detection fade distance" title="World-overlay fade distance outside the keyhole as a percentage of its radius" data-i18n-aria-label data-i18n-title />
      <span class="pp-slider-value" id="detection-fade-value">{{ pct(detection?.fadePct ?? 7) }}</span>
    </div>
    <div class="pp-slider-row detection-opacity-row" :class="{ visible: detection?.rowsVisible }" id="detection-opacity-row">
      <label class="pp-slider-mini-label" for="detection-opacity-slider" data-i18n>Outside</label>
      <input type="range" class="gev-quantitative-slider pp-slider" id="detection-opacity-slider" @input="act('setOutsideOpacity', integer($event))" min="0" max="100" step="1" value="1" v-range-value="detection?.outsideOpacityPct ?? 1" aria-label="Detection opacity outside the keyhole" title="World-overlay label and card opacity beyond the fade distance" data-i18n-aria-label data-i18n-title />
      <span class="pp-slider-value" id="detection-opacity-value">{{ pct(detection?.outsideOpacityPct ?? 1) }}</span>
    </div>
  </div>
  <!-- The one shared preset-parameter surface is inserted here at runtime. -->
  <div id="param-slider-panel" v-panel-state="'param-slider-panel'">
    <div class="param-panel-header">
      <span class="param-panel-title" data-i18n>PARAMETERS</span>
      <span class="param-panel-divider"></span>
      <PanelCollapseButton id="param-panel-collapse-btn" target="param-slider-panel" />
    </div>
    <div id="param-sliders"></div>
  </div>
  <div class="pp-toggle-group">
    <!-- 3D aircraft is DEFAULT-ON in Proximity (owner directive 2026-08-22), so the
         button ships lit and the mode row ships open — the same markup-carries-the-default
         convention as #scope-toggle. ui.js re-syncs both from durable layer state, which
         is what flips them back for a share link or a stored session carrying 3D off. -->
    <button class="pp-toggle-btn" :class="{ active: models3dOn }" id="models3d-toggle" @click="act('toggleModels')" :aria-pressed="String(models3dOn)" title="3D aircraft — flat icons zoomed out, 3D models up close" data-i18n-title>
      <span class="pp-icon">&#x2708;</span>
      <span class="pp-label">3D</span>
    </button>
    <div class="pp-slider-row" :class="{ visible: models3d?.rowVisible ?? true }" id="models3d-mode-row">
      <span class="pp-slider-mini-label" data-i18n>Models</span>
      <UiSegmented class="pp-mode-seg" item-class="pp-mode-btn" keyboard="none" :label="t('3D model coverage')" :options="modelsOptions" :model-value="modelsMode" @update:model-value="act('setModelsMode', $event)" />
    </div>
  </div>
  <div class="pp-toggle-group">
    <label class="pp-toggle-btn pp-scope-toggle" title="Scope — the circular viewport mask" data-i18n-title>
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">adjust</span>
      <span class="pp-label" data-i18n>Scope</span>
      <input type="checkbox" id="scope-toggle" @change="act('setScopeEnabled', $event.target.checked)" :checked="scopeOn" />
    </label>
    <div class="pp-slider-row visible" id="scope-slider-row">
      <span class="pp-slider-mini-label" data-i18n>Feather</span>
      <input type="range" class="gev-quantitative-slider pp-slider" id="scope-feather-slider" @input="act('setScopeFeather', integer($event))" min="0" max="200" value="100" v-range-value="scopeFeather" :disabled="!scopeOn" aria-label="Scope edge feather" title="Scope edge feather as a percentage of the keyhole radius" data-i18n-aria-label data-i18n-title />
      <span class="pp-slider-value" id="scope-feather-value">{{ pct(scopeFeather) }}</span>
    </div>
  </div>
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: draw?.active }" id="draw-toggle" title="Draw on the world — click vertices, double-click or Enter to finish, Esc to cancel" :aria-pressed="String(draw?.active ?? false)" data-i18n-title>
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">draw</span>
      <span class="pp-label" data-i18n>Draw</span>
    </button>
    <div class="pp-slider-row" :class="{ visible: draw?.active }" id="draw-mode-row">
      <span class="pp-slider-mini-label" data-i18n>Shape</span>
      <div class="gev-segmented pp-mode-seg" role="radiogroup" aria-label="Shape to draw" data-i18n-aria-label>
        <button class="gev-segment pp-mode-btn" data-shape="area" role="radio" v-bind="drawSegment('area')" data-i18n>Area</button>
        <button class="gev-segment pp-mode-btn" data-shape="line" role="radio" v-bind="drawSegment('line')" data-i18n>Line</button>
        <button class="gev-segment pp-mode-btn" data-shape="pin" role="radio" v-bind="drawSegment('pin')" data-i18n>Pin</button>
      </div>
    </div>
    <div class="pp-slider-row" :class="{ visible: draw?.active }" id="draw-label-row">
      <input type="text" class="pp-text-input" id="draw-label-input" maxlength="120" placeholder="Label (optional)" aria-label="Label for the drawn shape" data-i18n-placeholder data-i18n-aria-label autocomplete="off" spellcheck="false">
      <select class="pp-select draw-color-select gev-field gev-field--compact" id="draw-color-select" aria-label="Colour of the drawn shape" data-i18n-aria-label>
        <option value="primary" data-i18n>Primary</option>
        <option value="amber" data-i18n>Amber</option>
        <option value="cyan" data-i18n>Cyan</option>
        <option value="green" data-i18n>Green</option>
        <option value="red" data-i18n>Red</option>
      </select>
      <button class="pp-mode-btn draw-clear-btn" id="draw-clear" type="button" title="Remove every mark from the board" data-i18n-title data-i18n>Clear</button>
      <span class="draw-hint" id="draw-hint" aria-live="polite">{{ draw?.hint ?? '' }}</span>
    </div>
  </div>
  <div class="pp-toggle-group" id="geo-import-group">
    <button class="pp-toggle-btn" id="geo-import-button" type="button" title="Show your own GeoJSON, KML, KMZ or GPX files on the globe (or drop them onto it). File bytes stay on this device; overlays can appear in map screenshots shared with voice." data-i18n-title>
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">upload_file</span>
      <span class="pp-label" data-i18n>Import</span>
    </button>
    <input type="file" id="geo-import-input" accept=".geojson,.json,.kml,.kmz,.gpx" multiple hidden aria-label="Choose GeoJSON, KML, KMZ or GPX files" data-i18n-aria-label>
    <ul class="geo-import-list" :class="{ visible: geoListed }" id="geo-import-list" aria-label="Imported files" data-i18n-aria-label><li v-for="row in geoRows" :key="row.id" class="geo-import-row" :data-import-id="row.id"><span :class="['geo-import-swatch', { 'own-styles': row.ownStyles }]" :style="row.ownStyles ? null : { background: row.color }"></span><span class="geo-import-name" :title="row.title">{{ row.name }}</span><button v-for="item in row.actions" :key="item.action" type="button" class="geo-import-action" :data-action="item.action" :title="item.label" :aria-label="item.label" :aria-pressed="item.pressed"><span class="material-symbols-outlined" aria-hidden="true">{{ item.icon }}</span></button></li></ul>
    <span class="draw-hint geo-import-hint" id="geo-import-hint" aria-live="polite">{{ geoImport?.hint ?? '' }}</span>
  </div>
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: celestial?.active }" id="celestial-toggle" @click="act('toggleCelestial')" :title="celestialTitle" :aria-pressed="String(celestial?.active ?? false)" :disabled="celestial ? !celestial.supported : undefined" :aria-disabled="celestial ? String(!celestial.supported) : undefined">
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">flare</span>
      <span class="pp-label" data-i18n>Celestial</span>
    </button>
  </div>
  <button class="pp-toggle-btn" id="clean-view-toggle" @click="act('toggleCleanView')" title="Hide UI chrome" data-i18n-title>
    <span class="pp-icon">&#x25A1;</span>
    <span class="pp-label" data-i18n>Clean UI</span>
  </button>
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: view?.bloom.active }" id="bloom-toggle" @click="act('toggleBloom')" title="Bloom / Glow" data-i18n-title>
      <span class="pp-icon">&#x2728;</span>
      <span class="pp-label" data-i18n>Bloom</span>
    </button>
    <div class="pp-slider-row" :class="{ visible: view?.bloom.active }" id="bloom-slider-row">
      <input type="range" class="gev-quantitative-slider pp-slider" id="bloom-intensity-slider" @input="act('setBloomIntensity', integer($event))" min="0" max="200" value="0" v-range-value="view?.bloom.intensity ?? 0" aria-label="Bloom intensity" data-i18n-aria-label />
      <span class="pp-slider-value" id="bloom-intensity-value">{{ pct(view?.bloom.intensity ?? 0) }}</span>
    </div>
  </div>
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: view?.sharpen.active }" id="sharpen-toggle" @click="act('toggleSharpen')" title="Sharpening" data-i18n-title>
      <span class="pp-icon">&#x1F50D;</span>
      <span class="pp-label" data-i18n>Sharpen</span>
    </button>
    <div class="pp-slider-row" :class="{ visible: view?.sharpen.active }" id="sharpen-slider-row">
      <input type="range" class="gev-quantitative-slider pp-slider" id="sharpen-intensity-slider" @input="act('setSharpenIntensity', integer($event))" min="0" max="100" value="49" v-range-value="view?.sharpen.intensity ?? 49" aria-label="Sharpen intensity" data-i18n-aria-label />
      <span class="pp-slider-value" id="sharpen-intensity-value">{{ pct(view?.sharpen.intensity ?? 49) }}</span>
    </div>
  </div>
</div>
</div>
</template>
