import { createFrameRateMonitor } from './frameRateMonitor.js';
import { bindApplicationShortcuts } from './visualInput.js';
import { useDisplayStore } from './stores/display.js';
import { applicationPinia } from './vueRuntime.js';

/** Own keyboard/display event subscriptions; settings remain with their state owners. */
export class DisplayBindings {
  constructor({
    viewer,
    services,
    operations,
    readState,
    claimDetection,
    displayStore,
  }) {
    Object.assign(
      this,
      { viewer, services, readState, claimDetection, displayStore },
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
    // A Display change the person made claims the share link's visual lane first.
    const visual =
      (fn) =>
      (...args) => {
        this.shareLinkManager?.claimRestoreLane('visual');
        fn(...args);
      };
    const toggleHud = visual(() => {
      this.hud.toggle();
      this._updateHudButtonState();
      this._syncShareState();
    });
    const cycleDetection = visual(() => {
      this.claimDetection();
      cycleDetectionMode();
      this._syncShareState();
    });
    this._applicationShortcuts?.destroy();
    this._frameRateMonitor?.destroy();
    this._frameRateMonitor = createFrameRateMonitor({
      viewer: this.viewer,
      documentRef: document,
    });
    this._applicationShortcuts = bindApplicationShortcuts({
      documentRef: document,
      actions: {
        setStyle: (style) => this.setStyle(style),
        toggleHud,
        toggleOrbit: () => this._toggleOrbit(),
        toggleCleanView: () => this.toggleCleanView(),
        // Same collapse as the panel's own button, so its rail entry stays.
        toggleLayers: () => this._togglePanel('data-panel'),
        cycleDetection,
        toggleCctv: () => this._toggleCctvEnabled(),
      },
    });

    this._setScope({ enabled: isScopeMaskEnabled() }, { apply: false });
    // The Display controls (and the dock's style buttons) answer through
    // the display store; DisplayPanel's events call these actions.
    this._detachDisplayControls?.();
    const store = this.displayStore ?? useDisplayStore(applicationPinia());
    const token = store.connect({
      setStyle: (style) => this.setStyle(style),
      toggleBloom: visual(() => this._setBloomEnabled(!this.bloomEnabled)),
      setBloomIntensity: visual((value) => this._setBloomIntensity(value)),
      toggleSharpen: visual(() =>
        this._setSharpenEnabled(!this.sharpenEnabled),
      ),
      setScopeEnabled: visual((enabled) => {
        this._setScope({ enabled });
        this._syncShareState();
      }),
      setScopeFeather: visual((value) => {
        this._setScope({ featherPct: value });
        this._syncShareState();
      }),
      setScopeOpacity: visual((value) => {
        this._setScope({ opacityPct: Number(value) });
        this._syncShareState();
      }),
      setSharpenIntensity: visual((pct) => this._setSharpenIntensity(pct)),
      setHudLayout: visual((value) => this._setHudVariant(value)),
      toggleCleanView: () => this.toggleCleanView(),
      exitCleanView: () => this.toggleCleanView(false),
      setDensity: visual((value) => {
        this.claimDetection();
        this._setDetectionDensity(value);
        this._syncShareState();
      }),
      setAllocation: visual((value) => {
        this.claimDetection();
        this._setDetectionAllocation(value);
      }),
      setFade: visual((fadePct) => {
        this._setDetectionFade({ fadePct });
        this._syncShareState();
      }),
      setOutsideOpacity: visual((outsideOpacityPct) => {
        this._setDetectionFade({ outsideOpacityPct });
        this._syncShareState();
      }),
      toggleCelestial: () => {
        const ringIsVisible = !!this.celestialRing?.visible;
        if (!this.celestialRingEnabled || !ringIsVisible) {
          this.setCelestialRingEnabled(true, { focus: true });
        } else {
          this.setCelestialRingEnabled(false);
        }
      },
      toggleHud,
      toggleSonar: visual(() => this._setCyberSonarEnabled()),
      setSonarRings: (value) => this._setCyberSonarSetting('rings', value),
      setSonarRange: (value) => this._setCyberSonarSetting('range', value),
      setSonarIntensity: (value) =>
        this._setCyberSonarSetting('intensity', value),
      setSonarOpacity: (value) => this._setCyberSonarSetting('opacity', value),
      setSonarSector: (value) => this._setCyberSonarSetting('sector', value),
      cycleDetection,
      toggleModels: () => {
        this._setModels3dEnabled(!this._models3dEnabled);
        this._syncModels3dModeRow();
      },
      setModelsMode: (mode) => this._setModels3dMode(mode),
      // Back to the out-of-the-box look: Normal style, the global post
      // defaults (bloom, sharpen, HUD, labels, celestial), scope on at full
      // feather and opacity, 3D aircraft on in Proximity.
      resetVisual: visual(() => {
        this.setStyle('normal');
        // The HUD layout and the Sonar style stay as the viewer set them.
        this._applyGlobalPostDefaults({ keepHudVariant: true });
        this._setDetectionAllocation('ELASTIC');
        this._setScope({ enabled: true, featherPct: 100, opacityPct: 100 });
        this._setModels3dEnabled(true);
        this._setModels3dMode('proximity');
        this._syncModels3dModeRow();
        // Inside Contacts the detection shown is lent for the session, and
        // leaving puts back the state from before. A reset there is the user's
        // choice, so the defaults become what leaving puts back and what a
        // share link carries.
        this.claimDetection();
        this._adoptDetectionAsRestore();
        this._syncShareState();
      }),
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
