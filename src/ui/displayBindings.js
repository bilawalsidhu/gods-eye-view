import { createFrameRateMonitor } from './frameRateMonitor.js';
import { bindApplicationShortcuts } from './visualInput.js';
import { useDisplayStore } from './stores/display.js';
import { applicationPinia } from './vueRuntime.js';

/** Own keyboard/display event subscriptions; settings remain with their state owners. */
export class DisplayBindings {
  constructor({
    viewer,
    services,
    elements,
    operations,
    readState,
    claimDetection,
    displayStore,
  }) {
    Object.assign(
      this,
      { viewer, services, readState, claimDetection, displayStore },
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
  _initUI() {
    const { cycleDetectionMode, isScopeMaskEnabled } = this.services;
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
        setStyle: (style) => this.setStyle(style, { userInitiated: true }),
        dismissSearch: () => this._closeLocationSearch?.({ ifOpen: true }),
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
      },
    });

    this._setScope({ enabled: isScopeMaskEnabled() }, { apply: false });
    // The Display controls (and the dock's style buttons) answer through
    // the display store; DisplayPanel's events call these actions.
    this._detachDisplayControls?.();
    const store = this.displayStore ?? useDisplayStore(applicationPinia());
    const token = store.connect({
      setStyle: (style) => this.setStyle(style, { userInitiated: true }),
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
      setScopeEnabled: (enabled) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._setScope({ enabled });
        this._syncShareState();
      },
      setScopeFeather: (value) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._setScope({ featherPct: value });
        this._syncShareState();
      },
      setSharpenIntensity: (pct) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._setSharpenIntensity(pct);
      },
      setHudLayout: (value) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._setHudVariant(value, { applyVisualDefaults: true });
      },
      toggleCleanView: () => this.toggleCleanView(),
      exitCleanView: () => this.toggleCleanView(false),
      setDensity: (value) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this.claimDetection();
        this._setDetectionDensity(value);
        this._syncShareState();
      },
      setAllocation: (value) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this.claimDetection();
        this._setDetectionAllocation(value);
      },
      setFade: (fadePct) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._setDetectionFade({ fadePct });
        this._syncShareState();
      },
      setOutsideOpacity: (outsideOpacityPct) => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._setDetectionFade({ outsideOpacityPct });
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
      toggleSonar: () => this._setCyberSonarEnabled(),
      setSonarRings: (value) => this._setCyberSonarSetting('rings', value),
      setSonarRange: (value) => this._setCyberSonarSetting('range', value),
      setSonarIntensity: (value) =>
        this._setCyberSonarSetting('intensity', value),
      setSonarOpacity: (value) => this._setCyberSonarSetting('opacity', value),
      setSonarSector: (value) => this._setCyberSonarSetting('sector', value),
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
    });
    this._detachDisplayControls = () => store.detach(token);
  }
  destroy() {
    this._applicationShortcuts?.destroy();
    this._applicationShortcuts = null;
    this._frameRateMonitor?.destroy();
    this._frameRateMonitor = null;
    this._detachDisplayControls?.();
    this._detachDisplayControls = null;
  }
}
