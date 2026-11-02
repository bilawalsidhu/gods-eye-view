<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { vPanelState } from '../../rail/panelState.js';
import { vClassToggle } from '../../rail/classToggle.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vRangeValue } from '../../rail/rangeValue.js';
import UiSegmented from '../../kit/UiSegmented.vue';
import UiSlider from '../../kit/UiSlider.js';
import GeoImport from './GeoImport.vue';
import { useDisplayStore } from '../../stores/display.js';
import UiButton from '../../kit/UiButton.vue';
import UiSelect from '../../kit/UiSelect.js';
import { StyleParameterRows } from '../../styleParameters.js';

// The Display panel. VisualSettings presents the HUD, Sonar, Scope,
// Celestial, detection, bloom and sharpen, AircraftDisplay the 3D group and
// the draw tool its controls, and each publishes them; until they do, the
// panel shows its initial markup. GeoImport renders the file import.
const display = useDisplayStore();
const { view, models3d, draw, parameters, cockpitPortal } = storeToRefs(display);
// A control's change goes to its owner (DisplayBindings or the draw tool).
const act = (name, ...args) => display.act(name, ...args);
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
const modelsOptions = computed(() => [
  { value: 'proximity', label: t('Proximity'), attrs: { id: 'models3d-mode-proximity', 'data-mode': 'proximity' } },
  { value: 'all', label: t('All'), attrs: { id: 'models3d-mode-all', 'data-mode': 'all' } },
]);
const drawShape = computed(() => draw.value?.shape ?? 'area');
const drawShapeOptions = computed(() => [
  { value: 'area', label: t('Area'), attrs: { 'data-shape': 'area' } },
  { value: 'line', label: t('Line'), attrs: { 'data-shape': 'line' } },
  { value: 'pin', label: t('Pin'), attrs: { 'data-shape': 'pin' } },
]);
const allocationOptions = computed(() => [
  { value: 'ELASTIC', label: t('Elastic'), attrs: { id: 'detection-allocation-elastic', 'data-allocation': 'ELASTIC' } },
  { value: 'WEIGHTED', label: t('Weighted'), attrs: { id: 'detection-allocation-weighted', 'data-allocation': 'WEIGHTED' } },
]);
</script>

<template>
<!-- Post-processing toggles (top-right) -->
<div id="pp-toggles" v-panel-state="'pp-toggles'" class="panel-collapsible collapsed ui-scroll" data-panel-id="pp-toggles">
  <div class="compact pp-header-row">
    <span class="pp-header-label">{{ t('DISPLAY') }}</span>
    <span class="panel-divider" aria-hidden="true"></span>
    <PanelCollapseButton class="pp-collapse-btn" target="pp-toggles" :name="t('DISPLAY')" sideways start-collapsed />
  </div>
  <div class="pp-panel-body ui-scroll" data-rail-scroller>
  <!-- Cockpit shows these four groups in its Display popover: each teleports to the slot the Cockpit display portal publishes. While disabled a Teleport stays in place; its 'body' target only keeps server rendering from dropping it. -->
  <Teleport :to="cockpitPortal?.hud ?? 'body'" :disabled="!cockpitPortal?.hud">
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: hud?.visible }" id="hud-toggle" @click="act('toggleHud')" :title="t('Intelligence HUD (H)')">
      <span class="pp-icon">&#x25CE;</span>
      <span class="pp-label" translate="no">HUD</span>
    </button>
    <div class="pp-slider-row" :class="{ visible: hud?.visible }" id="hud-layout-row">
      <span class="pp-slider-mini-label">{{ t('Layout') }}</span>
      <UiSelect id="hud-layout-select" class="pp-select gev-field gev-field--compact" :model-value="hud?.variant ?? 'tactical'" @update:model-value="act('setHudLayout', $event)" :aria-label="t('HUD layout')">
        <option value="tactical">{{ t('Tactical') }}</option>
        <option value="minimal">{{ t('Minimal') }}</option>
        <option value="cyber">{{ t('Cyber') }}</option>
      </UiSelect>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-toggle-row" id="cyber-sonar-row">
      <span class="pp-slider-mini-label">{{ t('Sonar') }}</span>
      <UiButton class="pp-mode-btn" :pressed="sonarOn" pressed-class="active" id="cyber-sonar-toggle" @click="act('toggleSonar')" :title="t('Cyber sonar contact scanner')" :aria-label="t('Cyber sonar contact scanner')">{{ sonarOn ? t('ON') : t('OFF') }}</UiButton>
    </div>
    <output id="cyber-sonar-status" class="cyber-sonar-control" role="status"></output>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-rings-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-rings">{{ t('Rings') }}</label>
      <UiSlider class="pp-slider" id="cyber-sonar-rings" @update:model-value="act('setSonarRings', $event)" min="3" max="12" step="1" :model-value="sonar?.rings ?? 8" :aria-label="t('Sonar ring count')" />
      <span class="pp-slider-value" id="cyber-sonar-rings-value">{{ sonar?.rings ?? 8 }}</span>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-range-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-range">{{ t('Range') }}</label>
      <UiSlider class="pp-slider" id="cyber-sonar-range" @update:model-value="act('setSonarRange', $event)" min="60" max="120" step="1" :model-value="sonar?.range ?? 100" :aria-label="t('Sonar ring range')" />
      <span class="pp-slider-value" id="cyber-sonar-range-value">{{ pct(sonar?.range ?? 100) }}</span>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-intensity-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-intensity">{{ t('Power') }}</label>
      <UiSlider class="pp-slider" id="cyber-sonar-intensity" @update:model-value="act('setSonarIntensity', $event)" min="0" max="100" step="1" :model-value="sonar?.intensity ?? 70" :aria-label="t('Sonar intensity')" />
      <span class="pp-slider-value" id="cyber-sonar-intensity-value">{{ pct(sonar?.intensity ?? 70) }}</span>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-opacity-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-opacity">{{ t('Opacity') }}</label>
      <UiSlider class="pp-slider" id="cyber-sonar-opacity" @update:model-value="act('setSonarOpacity', $event)" min="35" max="100" step="1" :model-value="sonar?.opacity ?? 84" :aria-label="t('Cyber contact and label opacity')" :title="t('Minimum opacity for map dots, icons, models, brackets, and labels between sonar passes')" />
      <span class="pp-slider-value" id="cyber-sonar-opacity-value">{{ pct(sonar?.opacity ?? 84) }}</span>
    </div>
    <div class="pp-slider-row cyber-sonar-control cyber-sonar-setting" id="cyber-sonar-sector-row">
      <label class="pp-slider-mini-label" for="cyber-sonar-sector">{{ t('Sector') }}</label>
      <UiSlider class="pp-slider" id="cyber-sonar-sector" @update:model-value="act('setSonarSector', $event)" min="8" max="60" step="1" :model-value="sonar?.sector ?? 24" :aria-label="t('Sonar sector width')" />
      <span class="pp-slider-value" id="cyber-sonar-sector-value">{{ `${sonar?.sector ?? 24}°` }}</span>
    </div>
  </div>
  </Teleport>
  <Teleport :to="cockpitPortal?.detection ?? 'body'" :disabled="!cockpitPortal?.detection">
  <div class="pp-toggle-group">
    <UiButton class="pp-toggle-btn" :class="{ active: detectButton?.active, panoptic: detectButton?.panoptic }" :pressed="detectButton?.pressed ?? false" id="detection-toggle" @click="act('cycleDetection')" :title="t('Detection Overlay (D)')" :aria-label="detectButton?.ariaLabel ?? t('Detection overlay')">
      <span class="pp-icon">&#x25A3;</span>
      <span class="pp-label">{{ detectButton?.label ?? t('DETECT') }}</span>
    </UiButton>
    <div class="pp-slider-row detection-slider-row" :class="{ visible: detection?.rowsVisible }" id="detection-slider-row">
      <label class="pp-slider-mini-label" for="detection-density-slider">{{ t('Density') }}</label>
      <UiSlider class="pp-slider" id="detection-density-slider" @update:model-value="act('setDensity', $event)" min="0" max="100" step="25" :model-value="detection?.densityPct ?? 50" :aria-label="t('Detection label density')" />
      <span class="pp-slider-value" id="detection-density-value">{{ pct(detection?.densityPct ?? 50) }}</span>
    </div>
    <div class="pp-slider-row detection-allocation-row" :class="{ visible: detection?.rowsVisible }" id="detection-allocation-row">
      <span class="pp-slider-mini-label">{{ t('Allocation') }}</span>
      <UiSegmented class="pp-mode-seg detection-allocation-seg" item-class="pp-mode-btn" keyboard="none" :label="t('Detection label allocation')" :options="allocationOptions" :model-value="allocation" @update:model-value="act('setAllocation', $event)" />
    </div>
    <div class="pp-slider-row detection-fade-row" :class="{ visible: detection?.rowsVisible }" id="detection-fade-row">
      <label class="pp-slider-mini-label" for="detection-fade-slider">{{ t('Fade') }}</label>
      <UiSlider class="pp-slider" id="detection-fade-slider" @update:model-value="act('setFade', $event)" min="0" max="40" step="1" :model-value="detection?.fadePct ?? 7" :aria-label="t('Detection fade distance')" :title="t('World-overlay fade distance outside the keyhole as a percentage of its radius')" />
      <span class="pp-slider-value" id="detection-fade-value">{{ pct(detection?.fadePct ?? 7) }}</span>
    </div>
    <div class="pp-slider-row detection-opacity-row" :class="{ visible: detection?.rowsVisible }" id="detection-opacity-row">
      <label class="pp-slider-mini-label" for="detection-opacity-slider">{{ t('Outside') }}</label>
      <UiSlider class="pp-slider" id="detection-opacity-slider" @update:model-value="act('setOutsideOpacity', $event)" min="0" max="100" step="1" :model-value="detection?.outsideOpacityPct ?? 1" :aria-label="t('Detection opacity outside the keyhole')" :title="t('World-overlay label and card opacity beyond the fade distance')" />
      <span class="pp-slider-value" id="detection-opacity-value">{{ pct(detection?.outsideOpacityPct ?? 1) }}</span>
    </div>
  </div>
  </Teleport>
  <!-- The one shared preset-parameter surface: the active style's parameters, as VisualSettings publishes them. -->
  <Teleport :to="cockpitPortal?.parameters ?? 'body'" :disabled="!cockpitPortal?.parameters">
  <div id="param-slider-panel" v-panel-state="'param-slider-panel'" v-class-toggle="{ active: !!parameters }">
    <div class="param-panel-header">
      <span class="param-panel-title">{{ t('PARAMETERS') }}</span>
      <span class="param-panel-divider"></span>
      <PanelCollapseButton id="param-panel-collapse-btn" target="param-slider-panel" />
    </div>
    <div id="param-sliders"><StyleParameterRows v-if="parameters" :key="parameters.style" :rows="parameters.rows" :on-input="(name, value) => act('setStyleParameter', name, value)" /></div>
  </div>
  </Teleport>
  <Teleport :to="cockpitPortal?.models3d ?? 'body'" :disabled="!cockpitPortal?.models3d">
  <div class="pp-toggle-group">
    <!-- 3D aircraft is DEFAULT-ON in Proximity (owner directive 2026-08-22), so the
         button ships lit and the mode row ships open — the same markup-carries-the-default
         convention as #scope-toggle. ui.js re-syncs both from durable layer state, which
         is what flips them back for a share link or a stored session carrying 3D off. -->
    <UiButton class="pp-toggle-btn" :pressed="models3dOn" pressed-class="active" id="models3d-toggle" @click="act('toggleModels')" :title="t('3D aircraft — flat icons zoomed out, 3D models up close')">
      <span class="pp-icon">&#x2708;</span>
      <span class="pp-label">3D</span>
    </UiButton>
    <div class="pp-slider-row" :class="{ visible: models3d?.rowVisible ?? true }" id="models3d-mode-row">
      <span class="pp-slider-mini-label">{{ t('Models') }}</span>
      <UiSegmented class="pp-mode-seg" item-class="pp-mode-btn" keyboard="none" :label="t('3D model coverage')" :options="modelsOptions" :model-value="modelsMode" @update:model-value="act('setModelsMode', $event)" />
    </div>
  </div>
  </Teleport>
  <div class="pp-toggle-group">
    <label class="pp-toggle-btn pp-scope-toggle" :title="t('Scope — the circular viewport mask')">
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">adjust</span>
      <span class="pp-label">{{ t('Scope') }}</span>
      <input type="checkbox" id="scope-toggle" @change="act('setScopeEnabled', $event.target.checked)" :checked="scopeOn" />
    </label>
    <div class="pp-slider-row visible" id="scope-slider-row">
      <span class="pp-slider-mini-label">{{ t('Feather') }}</span>
      <UiSlider class="pp-slider" id="scope-feather-slider" @update:model-value="act('setScopeFeather', $event)" min="0" max="200" :model-value="scopeFeather" :disabled="!scopeOn" :aria-label="t('Scope edge feather')" :title="t('Scope edge feather as a percentage of the keyhole radius')" />
      <span class="pp-slider-value" id="scope-feather-value">{{ pct(scopeFeather) }}</span>
    </div>
  </div>
  <div class="pp-toggle-group">
    <UiButton class="pp-toggle-btn" :pressed="draw?.active ?? false" pressed-class="active" id="draw-toggle" @click="act('toggleDraw')" :title="t('Draw on the world — click vertices, double-click or Enter to finish, Esc to cancel')">
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">draw</span>
      <span class="pp-label">{{ t('Draw') }}</span>
    </UiButton>
    <div class="pp-slider-row" :class="{ visible: draw?.active }" id="draw-mode-row">
      <span class="pp-slider-mini-label">{{ t('Shape') }}</span>
      <UiSegmented class="pp-mode-seg" item-class="pp-mode-btn" keyboard="none" :label="t('Shape to draw')" :options="drawShapeOptions" :model-value="drawShape" @update:model-value="act('setDrawShape', $event)" />
    </div>
    <div class="pp-slider-row" :class="{ visible: draw?.active }" id="draw-label-row">
      <input type="text" class="pp-text-input" id="draw-label-input" v-range-value="draw?.label ?? ''" @input="act('setDrawLabel', $event.target.value)" maxlength="120" :placeholder="t('Label (optional)')" :aria-label="t('Label for the drawn shape')" autocomplete="off" spellcheck="false">
      <UiSelect class="pp-select draw-color-select gev-field gev-field--compact" id="draw-color-select" :model-value="draw?.color ?? 'primary'" @update:model-value="act('setDrawColor', $event)" :aria-label="t('Colour of the drawn shape')">
        <option value="primary">{{ t('Primary') }}</option>
        <option value="amber">{{ t('Amber') }}</option>
        <option value="cyan">{{ t('Cyan') }}</option>
        <option value="green">{{ t('Green') }}</option>
        <option value="red">{{ t('Red') }}</option>
      </UiSelect>
      <button class="pp-mode-btn draw-clear-btn" id="draw-clear" type="button" @click="act('clearDraw')" :title="t('Remove every mark from the board')">{{ t('Clear') }}</button>
      <span class="draw-hint" id="draw-hint" aria-live="polite">{{ draw?.hint ?? '' }}</span>
    </div>
  </div>
  <GeoImport />
  <div class="pp-toggle-group">
    <UiButton class="pp-toggle-btn" :pressed="celestial?.active ?? false" pressed-class="active" id="celestial-toggle" @click="act('toggleCelestial')" :title="celestialTitle" :disabled="celestial ? !celestial.supported : undefined" :aria-disabled="celestial ? String(!celestial.supported) : undefined">
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">flare</span>
      <span class="pp-label">{{ t('Celestial') }}</span>
    </UiButton>
  </div>
  <button class="pp-toggle-btn" id="clean-view-toggle" @click="act('toggleCleanView')" :title="t('Hide UI chrome')">
    <span class="pp-icon">&#x25A1;</span>
    <span class="pp-label">{{ t('Clean UI') }}</span>
  </button>
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: view?.bloom.active }" id="bloom-toggle" @click="act('toggleBloom')" :title="t('Bloom / Glow')">
      <span class="pp-icon">&#x2728;</span>
      <span class="pp-label">{{ t('Bloom') }}</span>
    </button>
    <div class="pp-slider-row" :class="{ visible: view?.bloom.active }" id="bloom-slider-row">
      <UiSlider class="pp-slider" id="bloom-intensity-slider" @update:model-value="act('setBloomIntensity', $event)" min="0" max="200" :model-value="view?.bloom.intensity ?? 0" :aria-label="t('Bloom intensity')" />
      <span class="pp-slider-value" id="bloom-intensity-value">{{ pct(view?.bloom.intensity ?? 0) }}</span>
    </div>
  </div>
  <div class="pp-toggle-group">
    <button class="pp-toggle-btn" :class="{ active: view?.sharpen.active }" id="sharpen-toggle" @click="act('toggleSharpen')" :title="t('Sharpening')">
      <span class="pp-icon">&#x1F50D;</span>
      <span class="pp-label">{{ t('Sharpen') }}</span>
    </button>
    <div class="pp-slider-row" :class="{ visible: view?.sharpen.active }" id="sharpen-slider-row">
      <UiSlider class="pp-slider" id="sharpen-intensity-slider" @update:model-value="act('setSharpenIntensity', $event)" min="0" max="100" :model-value="view?.sharpen.intensity ?? 49" :aria-label="t('Sharpen intensity')" />
      <span class="pp-slider-value" id="sharpen-intensity-value">{{ pct(view?.sharpen.intensity ?? 49) }}</span>
    </div>
  </div>
</div>
</div>
</template>
