/** Own recording chrome, safe frames and the pre-recording HUD snapshot. */
export class RecordingControls {
  constructor({ syncShareState, syncHudControls }) {
    this._syncShareState = syncShareState;
    // Shows the HUD's visibility and layout on the Display controls.
    this._syncHudControls = syncHudControls;
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
      } else {
        this.hud.setMode('auto');
      }
    } else {
      const saved = this._preRecordingHudState;
      this._preRecordingHudState = null;
      if (saved) {
        this.hud.setVariant(saved.variant);
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
    this._syncHudControls();
    this._syncShareState();
  }
  destroy() {
    if (this.destroyed) return;
    // Restore an active session while its supplied HUD is still alive.
    if (this._recordingMode) this.setRecordingMode(false);
    this.destroyed = true;
  }
}
