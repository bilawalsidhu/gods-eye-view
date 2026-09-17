import { createFrameRateMonitor } from './frameRateMonitor.js';
import { bindApplicationShortcuts } from './visualInput.js';
import { bindDisplayControls } from './displayControls.js';
import { canonicalizeDensity } from '../data/detectionPolicy.js';

/** Own keyboard/display event subscriptions; settings remain with their state owners. */
export class DisplayBindings {
  constructor({
    viewer,
    services,
    elements,
    operations,
    readState,
    claimDetection,
  }) {
    Object.assign(
      this,
      { viewer, services, readState, claimDetection },
      elements,
      operations,
    );
  }
  get shareLinkManager() {
    return this.readState().shareLinkManager;
  }
  get hud() {
    return this.readState().hud;
  }
  get bloomEnabled() {
    return this.readState().bloomEnabled;
  }
  get sharpenEnabled() {
    return this.readState().sharpenEnabled;
  }
  get celestialRing() {
    return this.readState().celestialRing;
  }
  get celestialRingEnabled() {
    return this.readState().celestialRingEnabled;
  }
  get _models3dEnabled() {
    return this.readState()._models3dEnabled;
  }
  get _models3dModeBtns() {
    return this.readState()._models3dModeBtns;
  }
  get _detectionAllocationBtns() {
    return this.readState()._detectionAllocationBtns;
  }
  _initUI() {
    const {
      cycleDetectionMode,
      setScopeMaskEnabled,
      isScopeMaskEnabled,
      setScopeMaskFeather,
    } = this.services;
    this._applicationShortcuts?.destroy();
    this._frameRateMonitor?.destroy();
    this._frameRateMonitor = createFrameRateMonitor({
      viewer: this.viewer,
      documentRef: document,
    });
    this._applicationShortcuts = bindApplicationShortcuts({
      documentRef: document,
      searchInput: this._locationSearch,
      actions: {
        setStyle: (style) => this.setStyle(style),
        dismissSearch: () => {
          if (this._locationSearch.classList.contains('expanded')) {
            this._locationSearch.classList.remove('expanded');
            this._locationSearch.value = '';
            this._locationSearch.blur();
          }
        },
        toggleHud: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.hud.toggle();
          this._updateHudButtonState();
          this._syncShareState();
        },
        toggleOrbit: () => this._toggleOrbit(),
        toggleCleanView: () => this.toggleCleanView(),
        toggleLayers: () =>
          document.getElementById('data-panel').classList.toggle('active'),
        cycleDetection: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.claimDetection();
          cycleDetectionMode();
          this._syncShareState();
        },
        toggleCctv: () => this._toggleCctvEnabled(),
        rewindHistory: () => this._rewindHistory?.(),
        resumeLiveHistory: () => this._resumeLiveHistory?.(),
      },
    });

    this._displayControls?.destroy();
    this._displayControls = bindDisplayControls({
      elements: {
        styleButtons: document.querySelectorAll('.style-btn'),
        bloomButton: this._bloomBtn,
        bloomSlider: this._bloomSlider,
        sharpenButton: this._sharpenBtn,
        sharpenSlider: this._sharpenSlider,
        scopeButton: this._scopeBtn,
        scopeFeatherSlider: this._scopeFeatherSlider,
        hudLayout: this._hudLayoutSelect,
        hudButton: this._hudBtn,
        cleanViewButton: this._cleanViewBtn,
        cleanViewExitButton: this._cleanViewExitBtn,
        densitySlider: this._detectionDensitySlider,
        detectionButton: this._detectionBtn,
        allocationButtons: this._detectionAllocationBtns,
        fadeSliders: [this._detectionFadeSlider, this._detectionOpacitySlider],
        celestialButton: this._celestialBtn,
        modelsButton: this._models3dBtn,
        modelModeButtons: this._models3dBtn ? this._models3dModeBtns : [],
      },
      actions: {
        setStyle: (style) => this.setStyle(style),
        toggleBloom: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setBloomEnabled(!this.bloomEnabled);
        },
        setBloomIntensity: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setBloomIntensity(value);
        },
        toggleSharpen: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setSharpenEnabled(!this.sharpenEnabled);
        },
        toggleScope: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          const next = !isScopeMaskEnabled();
          setScopeMaskEnabled(next);
          this._scopeBtn.classList.toggle('active', next);
          this._scopeBtn.setAttribute('aria-pressed', String(next));
          this._syncShareState();
        },
        setScopeFeather: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          const pct = Math.max(0, Math.min(100, value || 0));
          if (this._scopeFeatherValue)
            this._scopeFeatherValue.textContent = `${pct}%`;
          setScopeMaskFeather(pct / 100);
          this._syncShareState();
        },
        setSharpenIntensity: (pct) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          if (this._sharpenSliderValue)
            this._sharpenSliderValue.textContent = `${pct}%`;
          this._applySharpenIntensity(pct / 100);
          this._syncShareState();
        },
        setHudLayout: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._setHudVariant(value);
        },
        toggleCleanView: () => this.toggleCleanView(),
        exitCleanView: () => this.toggleCleanView(false),
        setDensity: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.claimDetection();
          const pct = canonicalizeDensity(value);
          this._detectionDensitySlider.value = String(pct);
          if (this._detectionDensityValue)
            this._detectionDensityValue.textContent = `${pct}%`;
          this._applyDetectionDensityFromUi();
          this._syncShareState();
        },
        setAllocation: (value) => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.claimDetection();
          this._setDetectionAllocation(value);
        },
        setFade: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this._applyDetectionFadeFromUi();
          this._syncShareState();
        },
        toggleCelestial: () => {
          const ringIsVisible = !!this.celestialRing?.visible;
          if (!this.celestialRingEnabled || !ringIsVisible) {
            this.setCelestialRingEnabled(true, { focus: true });
          } else {
            this.setCelestialRingEnabled(false);
          }
        },
        toggleHud: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.hud.toggle();
          this._updateHudButtonState();
          this._syncShareState();
        },
        cycleDetection: () => {
          this.shareLinkManager?.claimRestoreLane?.('visual');
          this.claimDetection();
          cycleDetectionMode();
          this._syncShareState();
        },
        toggleModels: () => {
          this._setModels3dEnabled(!this._models3dEnabled);
          this._syncModels3dModeRow();
        },
        setModelsMode: (mode) => this._setModels3dMode(mode),
      },
    });
  }
  destroy() {
    this._applicationShortcuts?.destroy();
    this._applicationShortcuts = null;
    this._frameRateMonitor?.destroy();
    this._frameRateMonitor = null;
    this._displayControls?.destroy();
    this._displayControls = null;
  }
}
