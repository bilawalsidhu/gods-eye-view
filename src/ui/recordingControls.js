/** Own recording chrome, safe frames and the pre-recording HUD snapshot. */
export class RecordingControls {
  constructor({ syncShareState }) {
    this._syncShareState = syncShareState;
    this.destroyed = false;
    this._recordingMode = false;
    this._recordingConfig = {
      hidePanels: true,
      hudMode: 'minimal',
      safeFrame: '16:9',
    };
    this._preRecordingHudState = null;
    this._safeFrameOverlay = document.getElementById('safe-frame-overlay');
    this._safeFrameBox = document.getElementById('safe-frame-box');
    this._hudLayoutSelect = document.getElementById('hud-layout-select');
    this._hudBtn = document.getElementById('hud-toggle');
    this.hud = null;
  }
  _initRecordingOverlay() {
    if (this.destroyed) return;
    if (!this._safeFrameOverlay || !this._safeFrameBox) return;
    this._safeFrameOverlay.classList.remove(
      'active',
      'ratio-9-16',
      'ratio-16-9',
    );
  }

  setRecordingMode(enabled, options = {}) {
    if (this.destroyed) return;
    const {
      hidePanels = true,
      hudMode = 'minimal',
      safeFrame = '16:9',
    } = options;
    this._recordingMode = !!enabled;
    this._recordingConfig = { hidePanels, hudMode, safeFrame };

    document.body.classList.toggle(
      'recording-mode',
      this._recordingMode && hidePanels,
    );

    if (this._safeFrameOverlay) {
      this._safeFrameOverlay.classList.remove('ratio-9-16', 'ratio-16-9');
      this._safeFrameOverlay.classList.toggle('active', this._recordingMode);
      this._safeFrameOverlay.classList.add(
        safeFrame === '9:16' ? 'ratio-9-16' : 'ratio-16-9',
      );
    }

    if (this._recordingMode) {
      // Snapshot the user's HUD state once per recording session so exit can
      // restore it (re-entrant calls must not capture mid-recording state).
      if (!this._preRecordingHudState) {
        this._preRecordingHudState = {
          mode: this.hud.getMode(),
          variant: this.hud.getVariant(),
        };
      }
      if (hudMode === 'off') {
        this.hud.setMode('off');
      } else if (hudMode === 'full' || hudMode === 'minimal') {
        this.hud.setMode('on');
        this.hud.setVariant(hudMode === 'minimal' ? 'minimal' : 'tactical');
        if (this._hudLayoutSelect)
          this._hudLayoutSelect.value = this.hud.getVariant();
      } else {
        this.hud.setMode('auto');
      }
    } else {
      const saved = this._preRecordingHudState;
      this._preRecordingHudState = null;
      if (saved) {
        this.hud.setVariant(saved.variant);
        if (this._hudLayoutSelect)
          this._hudLayoutSelect.value = this.hud.getVariant();
      }
      this.hud.setMode(saved ? saved.mode : 'auto');
      if (this._safeFrameOverlay) {
        this._safeFrameOverlay.classList.remove(
          'active',
          'ratio-9-16',
          'ratio-16-9',
        );
      }
    }
    this._hudBtn.classList.toggle('active', this.hud.visible);
    this._syncShareState();
  }
  destroy() {
    if (this.destroyed) return;
    // Restore an active session while its supplied HUD is still alive.
    if (this._recordingMode) this.setRecordingMode(false);
    this.destroyed = true;
  }
}
