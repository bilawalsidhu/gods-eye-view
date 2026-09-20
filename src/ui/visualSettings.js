import { STYLE_STATUS_LABELS } from './visualPresets.js';
import { UiLifetime } from './uiLifetime.js';
import {
  VisualEffects,
  STYLES,
  GLOBAL_POST_DEFAULTS,
  STYLE_PRESET_DEFAULTS,
  MILITARY_DETECTION_PRESET,
} from './effects.js';
import { createStyleParameters } from './visualInput.js';
import * as Cesium from 'cesium';
import {
  BLOOM_SCALE_VERSION,
  clampBloomIntensity,
  decodeBloomIntensity,
} from '../bloom.js';
import {
  ALLOCATION_STRATEGIES,
  canonicalizeDensity,
  defaultDensityForProfile,
  normalizeAllocationStrategy,
  normalizeProfile,
  profileForDensity,
} from '../data/detectionPolicy.js';
import {
  applyCockpitVisionStageIntensities,
  captureCockpitVisionBaseline,
  normalizeCockpitVisionMode,
} from '../cockpitVisionPolicy.js';
import {
  applyContactsDetection,
  shareCacheNeedsHeal,
  shareableDetectionState,
} from '../contactsDetectionPolicy.js';
const DETECTION_ALLOCATION_STORAGE_KEY = 'gev:detection-allocation:v1';

/** Own visual preferences, detection overrides and display-control state. */
export class VisualSettings {
  async restoreShareState(state) {
    const {
      setScopeMaskEnabled,
      setScopeMaskFeather,
      setScopeTerminusOverride,
      clampScopeTerminusPct,
    } = this.services;
    const {
      style,
      bloom,
      sharpen,
      bloomIntensity,
      bloomVersion,
      sharpenIntensity,
      hudVariant,
      hudVisible,
      detectionMode,
      detectionDensity,
      detectionAllocation,
      detectionFadePct,
      detectionOutsideOpacityPct,
      celestialRing,
      scopeEnabled,
      scopeFeatherPct,
      scopeTerminusPct,
      mapStack,
      panelState,
      styleParams,
    } = state || {};
    // Ignore the retired 'ai-edit' style from older share links.
    if (style && style !== 'normal' && style !== 'ai-edit') {
      this.setStyle(style, {
        applyPreset: true,
        revealParameters: false,
        restore: true,
      });
    }
    if (styleParams && style && this.stages[style] && STYLES[style]?.uniforms) {
      for (const [uniformName, uniformValue] of Object.entries(styleParams)) {
        if (!Object.hasOwn(STYLES[style].uniforms, uniformName)) continue;
        this.stages[style].uniforms[uniformName] = uniformValue;
      }
      this._updateSliderPanel(style, { reveal: false });
    }
    if (typeof bloomIntensity === 'number' && this._bloomSlider) {
      const intensity = decodeBloomIntensity(bloomIntensity, bloomVersion);
      this._setBloomIntensity(intensity, { syncShare: false });
    }
    if (typeof sharpenIntensity === 'number' && this._sharpenSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(sharpenIntensity)));
      this._sharpenSlider.value = String(pct);
      this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
    }
    if (typeof bloom === 'boolean') this._setBloomEnabled(bloom);
    if (typeof sharpen === 'boolean') this._setSharpenEnabled(sharpen);
    if (hudVariant) this._setHudVariant(hudVariant);
    if (typeof hudVisible === 'boolean') {
      this.hud.setMode(hudVisible ? 'on' : 'off');
      this._updateHudButtonState();
    }
    if (typeof detectionDensity === 'number' && this._detectionDensitySlider) {
      const pct = canonicalizeDensity(detectionDensity);
      this._detectionDensitySlider.value = String(pct);
      this._detectionDensityValue.textContent = `${pct}%`;
      this._applyDetectionDensityFromUi();
    }
    if (detectionAllocation) {
      this._setDetectionAllocation(detectionAllocation, {
        syncShare: false,
        persist: false,
      });
    }
    if (typeof detectionFadePct === 'number' && this._detectionFadeSlider) {
      this._detectionFadeSlider.value = String(detectionFadePct);
    }
    if (
      typeof detectionOutsideOpacityPct === 'number' &&
      this._detectionOpacitySlider
    ) {
      this._detectionOpacitySlider.value = String(detectionOutsideOpacityPct);
    }
    this._applyDetectionFadeFromUi();
    if (detectionMode) this._setDetectionMode(detectionMode);
    if (typeof celestialRing === 'boolean') {
      this.setCelestialRingEnabled(celestialRing, {
        syncShare: false,
        focus: false,
      });
    }
    if (typeof scopeEnabled === 'boolean') {
      setScopeMaskEnabled(scopeEnabled);
      this._scopeBtn?.classList.toggle('active', scopeEnabled);
      this._scopeBtn?.setAttribute('aria-pressed', String(scopeEnabled));
    }
    if (typeof scopeFeatherPct === 'number' && this._scopeFeatherSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(scopeFeatherPct)));
      this._scopeFeatherSlider.value = String(pct);
      if (this._scopeFeatherValue)
        this._scopeFeatherValue.textContent = `${pct}%`;
      setScopeMaskFeather(pct / 100);
    }
    // null restores the altitude-adaptive ramp; a number pins the terminus
    // (clamped to the supported 94..100 band, same as the `sce` hash key).
    if (scopeTerminusPct === null) setScopeTerminusOverride(null);
    else if (typeof scopeTerminusPct === 'number') {
      const pinned = clampScopeTerminusPct(scopeTerminusPct);
      setScopeTerminusOverride(pinned == null ? null : pinned / 100);
    }
    const mapStackRestore = mapStack
      ? this._setMapStack(mapStack, { syncShare: false })
      : Promise.resolve();
    if (panelState) this._restorePanelState(panelState);
    await mapStackRestore;
    this._syncShareState();
  }

  constructor({
    viewer,
    services,
    elements,
    operations,
    mapStackController,
    readHud,
    readCockpit,
    readDataManager,
    readShareLinks,
    readCelestialRing,
    readContextMode,
    readContextChanging,
    readDisplayPortalActive,
  }) {
    Object.assign(this, elements, operations, {
      viewer,
      services,
      mapStackController,
      readHud,
      readCockpit,
      readDataManager,
      readShareLinks,
      readCelestialRing,
      readContextMode,
      readContextChanging,
      readDisplayPortalActive,
    });
    this._lifetime = new UiLifetime();
    this._visualEffects = new VisualEffects({
      viewer,
      requestRender: services.governorRequestRender,
      holdRender: services.holdContinuousRender,
      releaseRender: services.releaseContinuousRender,
    });
    this.activeStyle = 'normal';
    document.documentElement.dataset.gevStyle = this.activeStyle;
    this._detectionUserOverridden = false;
    this._cockpitVisionMode = 'optical';
    this._cockpitVisionRestore = null;
    this._contactsDetectionRestore = null;
    this._detectionAllocationBtns = [
      document.getElementById('detection-allocation-elastic'),
      document.getElementById('detection-allocation-weighted'),
    ].filter(Boolean);
    let storedDetectionAllocation = 'ELASTIC';
    try {
      storedDetectionAllocation =
        localStorage.getItem(DETECTION_ALLOCATION_STORAGE_KEY) || 'ELASTIC';
    } catch {
      /* unavailable storage */
    }
    this._detectionAllocationPreference = normalizeAllocationStrategy(
      storedDetectionAllocation,
    );
  }
  get hud() {
    return this.readHud();
  }
  get cockpitView() {
    return this.readCockpit();
  }
  get _dataManager() {
    return this.readDataManager();
  }
  get shareLinkManager() {
    return this.readShareLinks();
  }
  get celestialRing() {
    return this.readCelestialRing();
  }
  get _contextMode() {
    return this.readContextMode();
  }
  get _contextModeChanging() {
    return this.readContextChanging();
  }
  get _cockpitDisplayPortalActive() {
    return this.readDisplayPortalActive();
  }
  get stages() {
    return this._visualEffects.stages;
  }

  get transitions() {
    return this._visualEffects.transitions;
  }

  get bloomEnabled() {
    return this._visualEffects.bloomEnabled;
  }

  get sharpenEnabled() {
    return this._visualEffects.sharpenEnabled;
  }

  _initStages() {
    this._visualEffects.initStyles();
  }

  _setStageIntensity(stage, value) {
    this._visualEffects.setStageIntensity(stage, value);
  }

  _syncStagesEnabledFromIntensity() {
    this._visualEffects.syncStagesEnabledFromIntensity();
  }

  _syncContactsDetection() {
    if (this._contextModeChanging) return;
    const result = applyContactsDetection({
      active: this._contextMode === 'flights',
      restore: this._contactsDetectionRestore,
      // A map style picked DURING the session owns detection on the way out —
      // its auto-enable preset is younger than the entry snapshot.
      styleOwnsDetection:
        !this._detectionUserOverridden &&
        Boolean(STYLE_PRESET_DEFAULTS[this.activeStyle]?.detection),
      // The snapshot must cover everything activation mutates — the preset
      // writes DENSITY as well as mode, so a mode-only snapshot returned
      // OFF @ 25% as OFF @ 75% and the next manual enable came back Dense.
      getState: () => {
        const state = this.getDetectionState();
        return { mode: state.detectionMode, densityPct: state.densityPct };
      },
      // Owner playtest: the force-on lands on the tactical look the military
      // styles apply — the SAME preset object — not on whatever profile the
      // operator last happened to leave detection at.
      applyPreset: () => this._applyDetectionPreset(MILITARY_DETECTION_PRESET),
      // The preset applier IS the state replayer: same density-then-mode order,
      // same slider writes, so a restore round-trips exactly.
      restoreState: (state) => this._applyDetectionPreset(state),
    });
    const hadOwnership = Boolean(this._contactsDetectionRestore);
    this._contactsDetectionRestore = result.restore;
    // Serialization reads that ownership: while Contacts holds it the link
    // carries the SAVED snapshot, and once released it carries live state. The
    // share cache therefore goes stale on any ownership transition, whether or
    // not the detection engine itself moved — and it does not always move.
    // Exiting while a military style owns detection returns changed:false (the
    // style's preset already matches), and returning early there left a copied
    // link claiming the operator's pre-Contacts values while the map showed
    // Dense @ 75%.
    if (
      !shareCacheNeedsHeal({
        changed: result.changed,
        hadOwnership,
        hasOwnership: Boolean(result.restore),
      })
    )
      return;
    if (result.changed) this._syncDetectionUiFromEngine();
    this._syncShareState();
  }

  _setCockpitVision(mode, active, { revealParameters = false } = {}) {
    const next = active ? normalizeCockpitVisionMode(mode) : 'optical';
    if (!this.stages) return;
    if (!active) {
      if (this._cockpitVisionRestore) {
        for (const [name, intensity] of Object.entries(
          this._cockpitVisionRestore,
        )) {
          if (this.stages[name])
            this._setStageIntensity(this.stages[name], intensity);
        }
      }
      this._cockpitVisionRestore = null;
      this._cockpitVisionMode = 'optical';
      this._syncIrBoost(); // Cockpit exit: fall back to the map preset's IR state
      this._updateSliderPanel(this.activeStyle, { reveal: false });
      this._revealCockpitStyleParameters({ openDisplay: revealParameters });
      return;
    }
    if (!this._cockpitVisionRestore) {
      this._cockpitVisionRestore = captureCockpitVisionBaseline(
        this.stages,
        this.transitions,
      );
    }
    if (next === 'optical') {
      applyCockpitVisionStageIntensities(
        this.stages,
        next,
        this._cockpitVisionRestore,
      );
      this._syncStagesEnabledFromIntensity();
      this._cockpitVisionMode = next;
      this._syncIrBoost();
      this._updateSliderPanel(this.activeStyle, { reveal: false });
      this._revealCockpitStyleParameters({ openDisplay: revealParameters });
      return;
    }
    const target = applyCockpitVisionStageIntensities(
      this.stages,
      next,
      this._cockpitVisionRestore,
    );
    this._syncStagesEnabledFromIntensity();
    this._cockpitVisionMode = next;
    this._syncIrBoost(); // Cockpit vision override ('nvg'/'thermal' boost; CRT/NOIR clear)
    this._updateSliderPanel(target || null, { reveal: false });
    this._revealCockpitStyleParameters({ openDisplay: revealParameters });
  }

  _syncIrBoost() {
    const cockpitMode = this.cockpitView?.active
      ? this._cockpitVisionMode
      : null;
    const effective =
      cockpitMode && cockpitMode !== 'optical' ? cockpitMode : this.activeStyle;
    const irBoost =
      effective === 'surveillance' ||
      effective === 'thermal' ||
      effective === 'nvg';
    this._dataManager?.setLayerParams('flights', { irBoost });
    this._dataManager?.setLayerParams('military', { irBoost });
    // Layers whose in-scene sprites restyle for a sensor preset need the
    // EFFECTIVE style — a cockpit vision override sets no map style, so the
    // map's own style event never fires for it.
    window.dispatchEvent(
      new CustomEvent('gev:vision-change', {
        detail: {
          style: effective,
          cockpit: Boolean(cockpitMode && cockpitMode !== 'optical'),
        },
      }),
    );
    // Fog blends distant geometry toward an effectively-BLACK color in this
    // app (the Cesium globe is hidden), so beyond ~100 km every 3D aircraft
    // fogs to a black silhouette — lighting and shaders can't reach past it
    // (owner cockpit-FLIR field rounds, 2026-08-16). IR sensors see through
    // haze, so the boost styles simply turn fog off; the prior state restores
    // on exit. Transition-guarded so repeated syncs don't clobber the saved value.
    const scene = this.viewer?.scene;
    if (scene?.fog && irBoost !== this._irBoostActive) {
      this._irBoostActive = irBoost;
      if (irBoost) {
        this._irFogWasEnabled = scene.fog.enabled;
        scene.fog.enabled = false;
      } else if (this._irFogWasEnabled != null) {
        scene.fog.enabled = this._irFogWasEnabled;
        this._irFogWasEnabled = null;
      }
      scene.requestRender?.();
    }
  }

  _syncCockpitInheritedStyle() {
    if (!this.cockpitView?.active || !this.stages) return;
    this._cockpitVisionRestore = Object.fromEntries(
      Object.keys(this.stages).map((name) => [
        name,
        name === this.activeStyle ? 1 : 0,
      ]),
    );
    for (const name of Object.keys(this.stages)) this.transitions.delete(name);
    this.cockpitView.setVisionMode(this.cockpitView.visionMode);
  }

  _revealCockpitStyleParameters({ openDisplay = false } = {}) {
    if (
      !this.cockpitView?.active ||
      !this._sliderPanel?.classList.contains('active')
    )
      return;
    if (
      openDisplay &&
      this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') !== 'true'
    ) {
      this._setCockpitDisclosure?.('display', true);
      return;
    }
    if (this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') !== 'true')
      return;
    this._sliderPanel.classList.remove('collapsed');
    this._syncPanelCollapseButton(this._sliderPanel);
    this._lifetime.frame(() =>
      this._lifetime.frame(() => {
        this._sliderPanel?.scrollIntoView?.({ block: 'nearest' });
      }),
    );
  }

  _initBloomSharpen() {
    this._visualEffects.initPostProcess(
      this._sharpenSlider ? parseInt(this._sharpenSlider.value, 10) / 100 : 0.6,
    );
  }

  _getBloomIntensity() {
    return this._visualEffects.bloomIntensity;
  }

  _syncBloomStageEnabled() {
    this._visualEffects.syncBloomEnabled();
  }

  _setBloomIntensity(intensity, { syncShare = true } = {}) {
    const { governorRequestRender } = this.services;
    governorRequestRender('bloom');
    const clamped = clampBloomIntensity(intensity);
    if (this._bloomSlider) this._bloomSlider.value = String(clamped);
    if (this._bloomSliderValue)
      this._bloomSliderValue.textContent = `${clamped}%`;
    this._applyBloomIntensity(clamped);
    if (syncShare) this._syncShareState();
  }

  _applyBloomIntensity(intensity) {
    this._visualEffects.applyBloomIntensity(intensity);
  }

  _setBloomEnabled(enabled) {
    const { governorRequestRender } = this.services;
    governorRequestRender('bloom');
    this._visualEffects.setBloomEnabled(enabled);
    this._syncBloomStageEnabled();
    this._bloomBtn.classList.toggle('active', this.bloomEnabled);
    this._bloomSliderRow.classList.toggle('visible', this.bloomEnabled);
    if (this.bloomEnabled) {
      this._applyBloomIntensity(this._getBloomIntensity());
    }
    this._syncShareState();
    this._layoutRightPanels();
  }

  _applySharpenIntensity(val) {
    this._visualEffects.applySharpenIntensity(val);
  }

  _setSharpenEnabled(enabled) {
    const { governorRequestRender } = this.services;
    governorRequestRender('sharpen');
    this._visualEffects.setSharpenEnabled(enabled);
    this._sharpenBtn.classList.toggle('active', this.sharpenEnabled);
    if (this._sharpenSliderRow) {
      this._sharpenSliderRow.classList.toggle('visible', this.sharpenEnabled);
    }
    if (this.sharpenEnabled && this._sharpenSlider) {
      this._applySharpenIntensity(
        parseInt(this._sharpenSlider.value, 10) / 100,
      );
    }
    this._syncShareState();
    this._layoutRightPanels();
  }

  _applyDetectionDensityFromUi() {
    const { getDetectionMode, setDetectionTuning } = this.services;
    if (!this._detectionDensitySlider) return;
    const pct = canonicalizeDensity(this._detectionDensitySlider.value);
    this._detectionDensitySlider.value = String(pct);
    if (this._detectionDensityValue)
      this._detectionDensityValue.textContent = `${pct}%`;
    setDetectionTuning({ densityPct: pct });
    this._updateDetectionButton(getDetectionMode());
  }

  _applyDetectionFadeFromUi() {
    const { setKeyholeFadeTuning } = this.services;
    const fadePct = Math.max(
      0,
      Math.min(40, Math.round(Number(this._detectionFadeSlider?.value) || 0)),
    );
    const outsideOpacityValue = this._detectionOpacitySlider?.value;
    const outsideOpacityPct = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          outsideOpacityValue == null ? 3 : Number(outsideOpacityValue) || 0,
        ),
      ),
    );
    if (this._detectionFadeSlider)
      this._detectionFadeSlider.value = String(fadePct);
    if (this._detectionFadeValue)
      this._detectionFadeValue.textContent = `${fadePct}%`;
    if (this._detectionOpacitySlider)
      this._detectionOpacitySlider.value = String(outsideOpacityPct);
    if (this._detectionOpacityValue)
      this._detectionOpacityValue.textContent = `${outsideOpacityPct}%`;
    setKeyholeFadeTuning({
      fadeRatio: fadePct / 100,
      outsideOpacity: outsideOpacityPct / 100,
    });
    this.viewer.scene.requestRender?.();
  }

  _setDetectionAllocation(strategy, { syncShare = true, persist = true } = {}) {
    const { setDetectionTuning } = this.services;
    const raw = String(strategy || '')
      .trim()
      .toUpperCase();
    if (!ALLOCATION_STRATEGIES.includes(raw)) return false;
    const normalized = normalizeAllocationStrategy(raw);
    this._detectionAllocationPreference = normalized;
    setDetectionTuning({ allocationStrategy: normalized });
    for (const button of this._detectionAllocationBtns) {
      const active = button.dataset.allocation === normalized;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    if (persist) {
      try {
        localStorage.setItem(DETECTION_ALLOCATION_STORAGE_KEY, normalized);
      } catch {
        /* best effort */
      }
    }
    if (syncShare) this._syncShareState();
    return true;
  }

  _syncDetectionUiFromEngine() {
    const { getKeyholeFadeTuning, getDetectionTuning, getDetectionMode } =
      this.services;
    const tuning = getDetectionTuning();
    if (this._detectionDensitySlider)
      this._detectionDensitySlider.value = String(tuning.densityPct);
    if (this._detectionDensityValue)
      this._detectionDensityValue.textContent = `${tuning.densityPct}%`;
    this._setDetectionAllocation(tuning.allocationStrategy, {
      syncShare: false,
      persist: false,
    });
    const fadeTuning = getKeyholeFadeTuning();
    if (this._detectionFadeSlider)
      this._detectionFadeSlider.value = String(
        Math.round(fadeTuning.fadeRatio * 100),
      );
    if (this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(
        Math.round(fadeTuning.outsideOpacity * 100),
      );
    }
    this._applyDetectionFadeFromUi();
    this._updateDetectionButton(getDetectionMode());
  }

  _setDetectionMode(modeLabel) {
    const { setDetectionModeByLabel } = this.services;
    if (!modeLabel) return;
    setDetectionModeByLabel(modeLabel);
    this._syncDetectionUiFromEngine();
    this._syncShareState();
  }

  _setHudVariant(variantName) {
    if (!variantName) return;
    this.hud.setVariant(variantName);
    if (
      this._hudLayoutSelect &&
      this._hudLayoutSelect.value !== this.hud.getVariant()
    ) {
      this._hudLayoutSelect.value = this.hud.getVariant();
    }
    this._syncShareState();
    this._scheduleAdaptivePanelLayout({ settle: true });
  }

  _applyStylePresetDefaults(styleName) {
    const { governorRequestRender } = this.services;
    const preset = STYLE_PRESET_DEFAULTS[styleName];
    if (!preset) return;

    if (preset.styleParams && typeof preset.styleParams === 'object') {
      for (const [targetStyle, params] of Object.entries(preset.styleParams)) {
        const stage = this.stages[targetStyle];
        if (!stage || !params || typeof params !== 'object') continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
          governorRequestRender('style-param');
        }
      }
    }

    const bloomInput = preset.bloom || {};
    if (typeof bloomInput.intensity === 'number' && this._bloomSlider) {
      this._setBloomIntensity(clampBloomIntensity(bloomInput.intensity), {
        syncShare: false,
      });
    }
    if (typeof bloomInput.enabled === 'boolean') {
      this._setBloomEnabled(bloomInput.enabled);
    }

    const sharpenInput = preset.sharpen || {};
    if (typeof sharpenInput.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(
        0,
        Math.min(100, Math.round(sharpenInput.intensity)),
      );
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof sharpenInput.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenInput.enabled);
    }

    if (preset.hudVariant) {
      this._setHudVariant(preset.hudVariant);
    }
    if (typeof preset.hudVisible === 'boolean') {
      this.hud.setMode(preset.hudVisible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    // A style may set a detection default (e.g. military styles -> Dense for
    // the "epic" default view), but ONLY if the user hasn't manually changed
    // detection this session. Detection is user-controlled and persists across
    // style switches, so an explicit Sparse/Off choice is never stomped.
    if (preset.detection && !this._detectionUserOverridden) {
      this._applyDetectionPreset(preset.detection);
    }
  }

  _applyDetectionPreset(det) {
    if (!det) return;
    if (typeof det.densityPct === 'number' && this._detectionDensitySlider) {
      const pct = canonicalizeDensity(det.densityPct);
      this._detectionDensitySlider.value = String(pct);
      if (this._detectionDensityValue)
        this._detectionDensityValue.textContent = `${pct}%`;
      this._applyDetectionDensityFromUi();
    }
    if (det.mode) this._setDetectionMode(String(det.mode).toUpperCase());
  }

  _applyGlobalPostDefaults() {
    const defaults = GLOBAL_POST_DEFAULTS;
    if (typeof defaults.bloom?.intensity === 'number' && this._bloomSlider) {
      this._setBloomIntensity(clampBloomIntensity(defaults.bloom.intensity), {
        syncShare: false,
      });
    }
    if (typeof defaults.bloom?.enabled === 'boolean') {
      this._setBloomEnabled(defaults.bloom.enabled);
    }

    if (
      typeof defaults.sharpen?.intensity === 'number' &&
      this._sharpenSlider
    ) {
      const sharpenPct = Math.max(
        0,
        Math.min(100, Math.round(defaults.sharpen.intensity)),
      );
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof defaults.sharpen?.enabled === 'boolean') {
      this._setSharpenEnabled(defaults.sharpen.enabled);
    }

    if (defaults.hudVariant) {
      this._setHudVariant(defaults.hudVariant);
    }
    if (typeof defaults.hudVisible === 'boolean') {
      this.hud.setMode(defaults.hudVisible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    if (defaults.detectionMode) {
      this._setDetectionMode(defaults.detectionMode);
    }
    if (
      typeof defaults.detectionDensity === 'number' &&
      this._detectionDensitySlider
    ) {
      const density = canonicalizeDensity(defaults.detectionDensity);
      this._detectionDensitySlider.value = String(density);
      this._detectionDensityValue.textContent = `${density}%`;
      this._applyDetectionDensityFromUi();
    }
    this._setDetectionAllocation(
      this._detectionAllocationPreference ||
        defaults.detectionAllocation ||
        'ELASTIC',
      { syncShare: false, persist: false },
    );
    if (this._detectionFadeSlider) {
      this._detectionFadeSlider.value = String(defaults.detectionFadePct ?? 7);
    }
    if (this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(
        defaults.detectionOutsideOpacityPct ?? 1,
      );
    }
    this._applyDetectionFadeFromUi();
    if (typeof defaults.celestialRing === 'boolean') {
      this.setCelestialRingEnabled(defaults.celestialRing, {
        syncShare: false,
        focus: false,
      });
    }
  }

  _shareableDetectionState() {
    const { getDetectionMode } = this.services;
    return shareableDetectionState({
      owned: this._contactsDetectionRestore,
      liveMode: getDetectionMode(),
      liveDensityPct: parseInt(this._detectionDensitySlider?.value || '50', 10),
    });
  }

  _readShareState() {
    const {
      getDetectionTuning,
      isScopeMaskEnabled,
      getScopeMaskFeather,
      getScopeTerminusOverride,
    } = this.services;
    const detection = this._shareableDetectionState();
    return {
      bloomEnabled: this.bloomEnabled,
      sharpenEnabled: this.sharpenEnabled,
      options: {
        bloomIntensity: this._getBloomIntensity(),
        bloomVersion: BLOOM_SCALE_VERSION,
        sharpenIntensity: parseInt(this._sharpenSlider?.value || '49', 10),
        hudVariant: this.hud.getVariant(),
        hudVisible: this.hud.visible,
        detectionMode: detection.mode,
        detectionDensity: detection.densityPct,
        detectionAllocation: getDetectionTuning().allocationStrategy,
        detectionFadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
        detectionOutsideOpacityPct: parseInt(
          this._detectionOpacitySlider?.value || '1',
          10,
        ),
        celestialRingEnabled: this.celestialRingEnabled,
        scopeEnabled: isScopeMaskEnabled(),
        scopeFeatherPct: Math.round(getScopeMaskFeather() * 100),
        // null when adaptive — the share layer omits `sce` entirely in that case.
        scopeTerminusPct:
          getScopeTerminusOverride() == null
            ? null
            : Math.round(getScopeTerminusOverride() * 100),
        mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
      },
    };
  }

  getDetectionState() {
    const { getDetectionTuning, getDetectionMode } = this.services;
    const pct = this._detectionDensitySlider
      ? parseInt(this._detectionDensitySlider.value, 10)
      : null;
    return {
      detectionMode: getDetectionMode(),
      densityPct: pct,
      allocationStrategy: getDetectionTuning().allocationStrategy,
      fadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
      outsideOpacityPct: parseInt(
        this._detectionOpacitySlider?.value || '0',
        10,
      ),
    };
  }

  getDetectionDiagnostics() {
    const { readDetectionDiagnostics } = this.services;
    return readDetectionDiagnostics();
  }

  setDetection({
    enabled,
    mode,
    densityPct,
    allocationStrategy,
    fadePct,
    outsideOpacityPct,
  } = {}) {
    const { getDetectionMode, setDetectionModeByLabel } = this.services;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return {
        ok: false,
        error: `Invalid detection enabled value: ${enabled}`,
        ...this.getDetectionState(),
      };
    }
    let requestedProfile = null;
    if (typeof mode === 'string' && mode.trim()) {
      requestedProfile = normalizeProfile(mode);
      if (!requestedProfile) {
        return {
          ok: false,
          error: `Unknown detection mode: ${mode}`,
          ...this.getDetectionState(),
        };
      }
    }
    let requestedDensity = null;
    if (densityPct != null) {
      if (!Number.isFinite(Number(densityPct))) {
        return {
          ok: false,
          error: `Invalid density: ${densityPct}`,
          ...this.getDetectionState(),
        };
      }
      requestedDensity = canonicalizeDensity(Number(densityPct));
    }
    if (
      requestedProfile &&
      requestedProfile !== 'OFF' &&
      requestedDensity != null &&
      profileForDensity(requestedDensity) !== requestedProfile
    ) {
      return {
        ok: false,
        error: `Detection mode ${requestedProfile} conflicts with density ${requestedDensity}%`,
        ...this.getDetectionState(),
      };
    }
    let requestedAllocation = null;
    if (allocationStrategy != null) {
      requestedAllocation = String(allocationStrategy).trim().toUpperCase();
      if (!ALLOCATION_STRATEGIES.includes(requestedAllocation)) {
        return {
          ok: false,
          error: `Unknown allocation strategy: ${allocationStrategy}`,
          ...this.getDetectionState(),
        };
      }
    }
    if (fadePct != null) {
      if (!Number.isFinite(Number(fadePct))) {
        return {
          ok: false,
          error: `Invalid fade distance: ${fadePct}`,
          ...this.getDetectionState(),
        };
      }
    }
    if (outsideOpacityPct != null) {
      if (!Number.isFinite(Number(outsideOpacityPct))) {
        return {
          ok: false,
          error: `Invalid outside opacity: ${outsideOpacityPct}`,
          ...this.getDetectionState(),
        };
      }
    }
    const hasExplicitVisualChange =
      typeof enabled === 'boolean' ||
      requestedProfile !== null ||
      requestedDensity !== null ||
      requestedAllocation !== null ||
      fadePct != null ||
      outsideOpacityPct != null;
    if (hasExplicitVisualChange) {
      // Voice/scripted detection control counts as an explicit user choice, so
      // neither style presets nor a still-pending shared visual restore can
      // overwrite it afterward.
      this.shareLinkManager?.claimRestoreLane?.('visual');
      this._detectionUserOverridden = true;
    }
    if (requestedAllocation) {
      this._setDetectionAllocation(requestedAllocation, { syncShare: false });
    }
    if (fadePct != null && this._detectionFadeSlider) {
      this._detectionFadeSlider.value = String(
        Math.max(0, Math.min(40, Math.round(Number(fadePct)))),
      );
    }
    if (outsideOpacityPct != null && this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(
        Math.max(0, Math.min(100, Math.round(Number(outsideOpacityPct)))),
      );
    }
    if (fadePct != null || outsideOpacityPct != null)
      this._applyDetectionFadeFromUi();

    if (
      requestedProfile &&
      requestedProfile !== 'OFF' &&
      requestedDensity == null
    ) {
      requestedDensity = defaultDensityForProfile(requestedProfile);
    }
    if (requestedDensity != null && this._detectionDensitySlider) {
      this._detectionDensitySlider.value = String(requestedDensity);
      this._applyDetectionDensityFromUi();
    }

    if (enabled === false || requestedProfile === 'OFF') {
      setDetectionModeByLabel('OFF');
    } else if (requestedProfile) {
      setDetectionModeByLabel(requestedProfile);
    } else if (enabled === true && getDetectionMode() === 'OFF') {
      setDetectionModeByLabel(
        profileForDensity(
          requestedDensity ?? this._detectionDensitySlider?.value ?? 50,
        ),
      );
    }
    this._syncDetectionUiFromEngine();
    this._syncShareState();
    return { ok: true, ...this.getDetectionState() };
  }

  setBloom({ enabled, intensityPct } = {}) {
    const current = () => ({
      enabled: !!this.bloomEnabled,
      intensityPct: this._bloomSlider
        ? parseInt(this._bloomSlider.value, 10)
        : null,
    });
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return {
        ok: false,
        error: `Invalid bloom enabled value: ${enabled}`,
        bloom: current(),
      };
    }
    if (
      intensityPct !== undefined &&
      (typeof intensityPct !== 'number' || !Number.isFinite(intensityPct))
    ) {
      return {
        ok: false,
        error: `Invalid bloom intensity: ${intensityPct}`,
        bloom: current(),
      };
    }
    const hasExplicitVisualChange =
      intensityPct !== undefined || enabled !== undefined;
    if (hasExplicitVisualChange)
      this.shareLinkManager?.claimRestoreLane?.('visual');
    if (intensityPct !== undefined) {
      this._setBloomIntensity(
        Math.round(Math.max(0, Math.min(200, intensityPct))),
      );
    }
    if (enabled !== undefined) this._setBloomEnabled(enabled);
    return {
      ok: true,
      bloom: current(),
    };
  }

  setSharpen({ enabled, intensityPct } = {}) {
    const current = () => ({
      enabled: !!this.sharpenEnabled,
      intensityPct: this._sharpenSlider
        ? parseInt(this._sharpenSlider.value, 10)
        : null,
    });
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return {
        ok: false,
        error: `Invalid sharpen enabled value: ${enabled}`,
        sharpen: current(),
      };
    }
    if (
      intensityPct !== undefined &&
      (typeof intensityPct !== 'number' || !Number.isFinite(intensityPct))
    ) {
      return {
        ok: false,
        error: `Invalid sharpen intensity: ${intensityPct}`,
        sharpen: current(),
      };
    }
    const hasExplicitVisualChange =
      intensityPct !== undefined || enabled !== undefined;
    if (hasExplicitVisualChange)
      this.shareLinkManager?.claimRestoreLane?.('visual');
    if (intensityPct !== undefined) {
      const pct = Math.round(Math.max(0, Math.min(100, intensityPct)));
      if (this._sharpenSlider) this._sharpenSlider.value = String(pct);
      if (this._sharpenSliderValue)
        this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
      this._syncShareState();
    }
    if (enabled !== undefined) this._setSharpenEnabled(enabled);
    return {
      ok: true,
      sharpen: current(),
    };
  }

  get celestialRingEnabled() {
    return !!this.celestialRing?.enabled;
  }

  setCelestialRingEnabled(enabled, { syncShare = true, focus = false } = {}) {
    const { isCelestialRingStyleSupported } = this.services;
    const styleSupported = isCelestialRingStyleSupported(this.activeStyle);
    const current = () => ({
      enabled: this.celestialRingEnabled,
      visible: !!this.celestialRing?.visible,
    });
    if (typeof enabled !== 'boolean') {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: `Invalid celestial ring enabled value: ${enabled}`,
      };
    }
    if (typeof syncShare !== 'boolean' || typeof focus !== 'boolean') {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: 'Celestial ring options must be boolean',
      };
    }
    if (!styleSupported && enabled) {
      return {
        ok: false,
        celestialRing: current(),
        cameraFocused: false,
        error: 'Celestial ring is available only in Normal style',
      };
    }
    if (syncShare) this.shareLinkManager?.claimRestoreLane?.('visual');
    const nextEnabled = styleSupported && enabled;
    this.celestialRing?.setEnabled(nextEnabled);
    this._celestialBtn?.classList.toggle('active', nextEnabled);
    this._celestialBtn?.setAttribute('aria-pressed', String(nextEnabled));
    if (this._celestialBtn) {
      this._celestialBtn.disabled = !styleSupported;
      this._celestialBtn.setAttribute('aria-disabled', String(!styleSupported));
      this._celestialBtn.title = styleSupported
        ? 'Celestial ring — reveal the full globe'
        : 'Celestial ring — available in Normal style';
    }
    let cameraFocused = false;
    if (nextEnabled && focus) {
      cameraFocused = !!this.celestialRing?.focusFullGlobe();
    }
    if (syncShare) this._syncShareState();
    return {
      ok: styleSupported || !enabled,
      celestialRing: current(),
      cameraFocused,
    };
  }

  getVisualState() {
    const {
      getDetectionTuning,
      getDetectionMode,
      isScopeMaskEnabled,
      getScopeMaskFeather,
    } = this.services;
    const styleParams = {};
    for (const [styleName, stage] of Object.entries(this.stages)) {
      const shader = STYLES[styleName];
      if (!shader?.uniforms) continue;
      styleParams[styleName] = {};
      for (const uniformName of Object.keys(shader.uniforms)) {
        styleParams[styleName][uniformName] = stage.uniforms[uniformName];
      }
    }

    return {
      style: this.activeStyle,
      bloom: {
        enabled: this.bloomEnabled,
        intensity: this._getBloomIntensity(),
        version: BLOOM_SCALE_VERSION,
      },
      sharpen: {
        enabled: this.sharpenEnabled,
        intensity: parseInt(this._sharpenSlider?.value || '49', 10),
      },
      hud: {
        visible: this.hud.visible,
        variant: this.hud.getVariant(),
      },
      detection: {
        mode: getDetectionMode(),
        density: parseInt(this._detectionDensitySlider?.value || '50', 10),
        allocation: getDetectionTuning().allocationStrategy,
        fadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
        outsideOpacityPct: parseInt(
          this._detectionOpacitySlider?.value || '0',
          10,
        ),
      },
      scope: {
        enabled: isScopeMaskEnabled(),
        featherPct: Math.round(getScopeMaskFeather() * 100),
      },
      mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
      styleParams,
    };
  }

  async applyVisualState(state = {}, { isCurrent = null } = {}) {
    const { setScopeMaskEnabled, setScopeMaskFeather } = this.services;
    const superseded = () => typeof isCurrent === 'function' && !isCurrent();
    if (superseded()) return false;

    if (state.style && state.style !== this.activeStyle) {
      this.setStyle(state.style, { applyPreset: false });
    }

    const bloomState = state.bloom || {};
    if (typeof bloomState.intensity === 'number' && this._bloomSlider) {
      const intensity = decodeBloomIntensity(
        bloomState.intensity,
        bloomState.version ?? state.bloomVersion ?? BLOOM_SCALE_VERSION,
      );
      this._setBloomIntensity(intensity, { syncShare: false });
    }
    if (typeof bloomState.enabled === 'boolean') {
      this._setBloomEnabled(bloomState.enabled);
    }

    const sharpenState = state.sharpen || {};
    if (typeof sharpenState.intensity === 'number' && this._sharpenSlider) {
      const pct = Math.max(
        0,
        Math.min(100, Math.round(sharpenState.intensity)),
      );
      this._sharpenSlider.value = String(pct);
      this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
    }
    if (typeof sharpenState.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenState.enabled);
    }

    const hudState = state.hud || {};
    if (hudState.variant) {
      this._setHudVariant(hudState.variant);
    }
    if (typeof hudState.visible === 'boolean') {
      this.hud.setMode(hudState.visible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    const scopeState = state.scope || {};
    if (typeof scopeState.enabled === 'boolean') {
      setScopeMaskEnabled(scopeState.enabled);
      this._scopeBtn?.classList.toggle('active', scopeState.enabled);
      this._scopeBtn?.setAttribute('aria-pressed', String(scopeState.enabled));
    }
    if (typeof scopeState.featherPct === 'number' && this._scopeFeatherSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(scopeState.featherPct)));
      this._scopeFeatherSlider.value = String(pct);
      if (this._scopeFeatherValue)
        this._scopeFeatherValue.textContent = `${pct}%`;
      setScopeMaskFeather(pct / 100);
    }

    const detectionState = state.detection || {};
    if (
      typeof detectionState.density === 'number' &&
      this._detectionDensitySlider
    ) {
      const pct = canonicalizeDensity(detectionState.density);
      this._detectionDensitySlider.value = String(pct);
      if (this._detectionDensityValue)
        this._detectionDensityValue.textContent = `${pct}%`;
      this._applyDetectionDensityFromUi();
    }
    if (detectionState.allocation) {
      this._setDetectionAllocation(detectionState.allocation, {
        syncShare: false,
      });
    }
    if (
      typeof detectionState.fadePct === 'number' &&
      this._detectionFadeSlider
    ) {
      this._detectionFadeSlider.value = String(detectionState.fadePct);
    }
    if (
      typeof detectionState.outsideOpacityPct === 'number' &&
      this._detectionOpacitySlider
    ) {
      this._detectionOpacitySlider.value = String(
        detectionState.outsideOpacityPct,
      );
    }
    this._applyDetectionFadeFromUi();
    if (detectionState.mode) {
      this._setDetectionMode(detectionState.mode);
    }

    if (state.mapStack) {
      // The stack switch is itself a MUTATION, not merely a suspension point,
      // so it needs a gate on BOTH sides of the await.
      if (superseded()) return false;
      const stackBefore = this.mapStackController?.getActiveId?.() ?? null;
      const genBefore =
        this.mapStackController?.getSwitchGeneration?.() ?? null;

      await this._setMapStack(state.mapStack, { syncShare: false });

      if (superseded()) {
        // Superseded DURING the switch, which the pre-check above cannot catch
        // and which has already moved the globe. The controller only
        // invalidates a switch when another setStack() arrives, and a winning
        // state that omits `mapStack` never issues one — every normalized scene
        // shot omits it — so this stale globe would simply stand. Put back what
        // the winner inherited.
        const genAfter =
          this.mapStackController?.getSwitchGeneration?.() ?? null;
        // _setMapStack issues exactly one setStack(), which advances the
        // generation once, or not at all when the stack was unavailable and
        // nothing was mutated. Anything past that is a NEWER switch whose
        // caller owns the globe now, and reverting would stomp a live intent.
        const globeIsStillOurs =
          genBefore !== null && genAfter !== null && genAfter <= genBefore + 1;
        const landed = this.mapStackController?.getActiveId?.() ?? null;
        if (globeIsStillOurs && stackBefore && landed !== stackBefore) {
          await this._setMapStack(stackBefore, { syncShare: false });
        }
        return false;
      }
      // Everything below is the uniform commit, already past its own gate.
    }

    if (state.styleParams && typeof state.styleParams === 'object') {
      for (const [styleName, params] of Object.entries(state.styleParams)) {
        const stage = this.stages[styleName];
        if (!stage || !params) continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
        }
      }
      this._updateSliderPanel(this.activeStyle);
    }

    this._syncShareState();
    return true;
  }

  applyCinematicPreset(preset = {}) {
    const bloomInput =
      typeof preset.bloom === 'object'
        ? preset.bloom
        : { intensity: preset.bloom };
    let decodedBloomIntensity = null;
    if (typeof bloomInput.intensity === 'number') {
      decodedBloomIntensity = decodeBloomIntensity(
        bloomInput.intensity,
        bloomInput.version ?? preset.bloomVersion ?? BLOOM_SCALE_VERSION,
      );
      this._setBloomIntensity(decodedBloomIntensity, { syncShare: false });
    }
    if (typeof bloomInput.enabled === 'boolean') {
      this._setBloomEnabled(bloomInput.enabled);
    } else if (typeof bloomInput.intensity === 'number') {
      this._setBloomEnabled(
        (decodedBloomIntensity ?? this._getBloomIntensity()) > 0,
      );
    }

    const sharpenInput =
      typeof preset.sharpen === 'object'
        ? preset.sharpen
        : { enabled: preset.sharpen };
    if (typeof sharpenInput.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(
        0,
        Math.min(100, Math.round(sharpenInput.intensity)),
      );
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof sharpenInput.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenInput.enabled);
    } else if (typeof sharpenInput.intensity === 'number') {
      this._setSharpenEnabled(sharpenInput.intensity > 0);
    }

    if (preset.hudVariant) {
      this._setHudVariant(preset.hudVariant);
    }

    if (preset.detectionMode) {
      this._setDetectionMode(preset.detectionMode);
    }
    if (
      typeof preset.detectionDensity === 'number' &&
      this._detectionDensitySlider
    ) {
      const density = canonicalizeDensity(preset.detectionDensity);
      this._detectionDensitySlider.value = String(density);
      this._detectionDensityValue.textContent = `${density}%`;
      this._applyDetectionDensityFromUi();
    }
    if (preset.detectionAllocation) {
      this._setDetectionAllocation(preset.detectionAllocation, {
        syncShare: false,
      });
    }

    if (preset.styleParams && typeof preset.styleParams === 'object') {
      for (const [styleName, params] of Object.entries(preset.styleParams)) {
        const stage = this.stages[styleName];
        if (!stage || !params || typeof params !== 'object') continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
        }
      }

      // Keep slider panel values in sync when updating the active style.
      this._updateSliderPanel(this.activeStyle);
    }

    this._syncShareState();
  }

  _updateSliderPanel(styleName, { reveal = false } = {}) {
    const { governorRequestRender } = this.services;
    this._styleParameters ||= createStyleParameters({
      container: this._sliderContainer,
    });
    this._styleParameters.clear();
    const shader = STYLES[styleName];

    if (!shader || !shader.uniforms || styleName === 'normal') {
      this._sliderPanel.classList.remove('active');
      this._scheduleRightPanelLayout();
      return;
    }

    this._styleParameters.render({
      uniforms: shader.uniforms,
      readValue: (uName) => this.stages[styleName].uniforms[uName],
      writeValue: (uName, val) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this.stages[styleName].uniforms[uName] = val;
      },
      onChange: () => {
        // Uniform writes need an explicit render under the idle governor.
        governorRequestRender('style-param-slider');
        this._syncShareState();
      },
    });

    this._sliderPanel.classList.add('active');
    this._scheduleRightPanelLayout();
    if (reveal) this._revealStyleParameters();
  }

  _revealStyleParameters() {
    if (!this._sliderPanel?.classList.contains('active')) return;
    if (this._cockpitDisplayPortalActive) return;
    this._sliderPanel.classList.remove('collapsed');
    this._syncPanelCollapseButton(this._sliderPanel);
    this.setPanelCollapsed('pp-toggles', false, { explicit: true });
    this._lifetime.frame(() =>
      this._lifetime.frame(() => {
        const scrollOwner = this._ppToggles;
        if (!scrollOwner) return;
        const ownerRect = scrollOwner.getBoundingClientRect();
        const panelRect = this._sliderPanel.getBoundingClientRect();
        scrollOwner.scrollTop += panelRect.top - ownerRect.top - 8;
      }),
    );
  }

  setStyle(
    styleName,
    {
      applyPreset = true,
      revealParameters = applyPreset,
      restore = false,
    } = {},
  ) {
    const { setDetectionStyle } = this.services;
    if (!restore) this.shareLinkManager?.claimRestoreLane?.('visual');
    if (styleName === this.activeStyle) {
      if (revealParameters && styleName !== 'normal')
        this._revealStyleParameters();
      return;
    }

    const previousStyle = this.activeStyle;
    this.activeStyle = styleName;
    document.documentElement.dataset.gevStyle = styleName;

    // The celestial optics treatment belongs to the unfiltered globe only.
    // Leaving Normal turns it off; returning merely re-enables the control.
    this.setCelestialRingEnabled(false, { syncShare: false, focus: false });

    // Transition out the previous shader style
    if (previousStyle !== 'normal' && this.stages[previousStyle]) {
      this._startTransition(
        previousStyle,
        this.stages[previousStyle].uniforms.intensity,
        0.0,
      );
    }

    // Transition in the new shader style
    if (styleName !== 'normal' && this.stages[styleName]) {
      this._startTransition(
        styleName,
        this.stages[styleName].uniforms.intensity,
        1.0,
      );
    }

    if (applyPreset) {
      this._applyStylePresetDefaults(styleName);
    }

    // Update button UI
    document.querySelectorAll('.style-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.style === styleName);
    });

    // Update style indicator
    const displayNames = { surveillance: 'NVG', thermal: 'FLIR', retro: 'CRT' };
    this._styleIndicator.textContent =
      displayNames[styleName] || styleName.toUpperCase();
    this._updateStyleMiniStatus(styleName);

    // Update parameter sliders
    this._updateSliderPanel(styleName, { reveal: revealParameters });

    // Notify HUD (color adaptation + auto show/hide)
    this.hud.onStyleChange(styleName);
    this._updateHudButtonState();

    // Sync detection overlay tone to active post-process style
    setDetectionStyle(styleName);
    this._syncIrBoost();
    window.dispatchEvent(
      new CustomEvent('gev:style-change', {
        detail: { style: styleName },
      }),
    );

    this._syncCockpitInheritedStyle();

    // Notify share link manager
    this.shareLinkManager.onStyleChange(styleName);
    this._syncShareState();
  }

  _startTransition(styleName, fromValue, toValue) {
    this._visualEffects.startTransition(styleName, fromValue, toValue);
  }

  _updateStyleMiniStatus(styleName = this.activeStyle) {
    if (!this._styleMiniValue) return;
    this._styleMiniValue.textContent =
      STYLE_STATUS_LABELS[styleName] ||
      String(styleName || 'normal').toUpperCase();
  }

  _updateHudButtonState() {
    this._hudBtn.classList.toggle('active', this.hud.visible);
    if (this._hudLayoutRow) {
      this._hudLayoutRow.classList.toggle('visible', this.hud.visible);
    }
    this._scheduleAdaptivePanelLayout({ settle: true });
  }

  _updateDetectionButton(modeLabel) {
    const btn = this._detectionBtn;
    const enabled = modeLabel !== 'OFF';
    btn.setAttribute('aria-pressed', String(enabled));
    btn.setAttribute(
      'aria-label',
      enabled
        ? `Detection overlay: ${String(modeLabel).toLowerCase()}`
        : 'Detection overlay: off',
    );
    btn.classList.remove('active', 'god', 'panoptic');
    if (modeLabel === 'SPARSE') {
      btn.querySelector('.pp-label').textContent = 'SPARSE';
      btn.classList.add('active');
    } else if (modeLabel === 'BALANCED') {
      btn.querySelector('.pp-label').textContent = 'BALANCED';
      btn.classList.add('active');
    } else if (modeLabel === 'DENSE') {
      btn.querySelector('.pp-label').textContent = 'DENSE';
      btn.classList.add('active', 'panoptic');
    } else {
      btn.querySelector('.pp-label').textContent = 'DETECT';
    }

    if (this._detectionSliderRow) {
      this._detectionSliderRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionAllocationRow) {
      this._detectionAllocationRow.classList.toggle(
        'visible',
        modeLabel !== 'OFF',
      );
    }
    if (this._detectionFadeRow) {
      this._detectionFadeRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionOpacityRow) {
      this._detectionOpacityRow.classList.toggle(
        'visible',
        modeLabel !== 'OFF',
      );
    }
    this._layoutRightPanels();
  }
  stop() {
    this._lifetime.destroy();
    this._styleParameters?.destroy();
    this._visualEffects.stop();
  }
  releaseIrBoost() {
    if (!this._irBoostActive) return;
    if (this._irFogWasEnabled != null && this.viewer?.scene?.fog)
      this.viewer.scene.fog.enabled = this._irFogWasEnabled;
    this._dataManager?.setLayerParams('flights', { irBoost: false });
    this._dataManager?.setLayerParams('military', { irBoost: false });
    this._irBoostActive = false;
    this._irFogWasEnabled = null;
  }
  destroy() {
    this.stop();
    this.releaseIrBoost();
    this._visualEffects.destroy();
  }
}
