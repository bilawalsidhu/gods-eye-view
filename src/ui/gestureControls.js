/**
 * Gesture Controls Controller & UI Integration.
 *
 * Coordinates webcam hand tracking, gesture mapping, visual feedback,
 * and command dispatching to God's Eye View shell.
 */

import { HandTracker } from '../input/handTracker.js';
import { GestureMapper, GESTURE_NAMES } from '../input/gestureMapper.js';
import { GestureOverlay } from '../input/gestureOverlay.js';
import { getTacticalAudio } from '../audio/tacticalAudio.js';

export class GestureControls {
  /**
   * @param {object} options
   * @param {HTMLElement} [options.container] - button container
   * @param {(action: string, payload: object) => void} options.onAction
   * @param {(error: Error) => void} [options.onError]
   * @param {(enabled: boolean) => void} [options.onStatusChange]
   * @param {TacticalAudioEngine} [options.audioEngine]
   */
  constructor({
    container = null,
    onAction = null,
    onError = null,
    onStatusChange = null,
    audioEngine = null,
  } = {}) {
    this.container = container;
    this.onAction = onAction;
    this.onError = onError;
    this.onStatusChange = onStatusChange;
    this.audioEngine = audioEngine || getTacticalAudio();

    this.tracker = null;
    this.mapper = null;
    this.overlay = null;

    this.isEnabled = false;
    this.root = null;
    this.modalEl = null;

    this._init();
  }

  _init() {
    this.mapper = new GestureMapper({
      holdDurationMs: 200,
      onAction: (action, payload) => this._handleMappedAction(action, payload),
    });

    if (typeof document !== 'undefined') {
      this.overlay = new GestureOverlay({
        onClose: () => this.toggle(false),
        onSimulate: (gesture) => this.triggerSimulatedGesture(gesture),
      });
      this._buildControlsButton();
    }
  }

  _buildControlsButton() {
    this.root = document.createElement('div');
    this.root.className = 'gev-gesture-ctrl-widget';
    this.root.innerHTML = `
      <button class="gev-gesture-toggle-btn" title="Toggle Webcam Gesture Control" aria-label="Toggle Gesture Control">
        <span>🖐️</span>
        <span class="gev-gesture-label">GESTURES</span>
      </button>
      <button class="gev-gesture-help-btn" title="Gesture Reference Guide" aria-label="Gesture Guide">?</button>
    `;

    const toggleBtn = this.root.querySelector('.gev-gesture-toggle-btn');
    const helpBtn = this.root.querySelector('.gev-gesture-help-btn');

    toggleBtn?.addEventListener('click', () => {
      this.toggle(!this.isEnabled);
    });

    helpBtn?.addEventListener('click', () => {
      this.showHelpModal();
    });

    if (this.container) {
      this.container.appendChild(this.root);
    }
  }

  /**
   * Enable or disable webcam hand gesture tracking.
   */
  async toggle(enable = !this.isEnabled) {
    this.isEnabled = Boolean(enable);

    const toggleBtn = this.root?.querySelector('.gev-gesture-toggle-btn');
    toggleBtn?.classList.toggle('active', this.isEnabled);
    this.onStatusChange?.(this.isEnabled);

    if (this.isEnabled) {
      this.audioEngine.playLock();
      this.overlay?.show();

      if (!this.tracker) {
        this.tracker = new HandTracker({
          videoEl: this.overlay?.videoElement,
          fps: 15,
          smoothing: 0.65,
          onResults: ({ landmarks }) => {
            const { rawGesture } = this.mapper.processFrame(landmarks);
            this.overlay?.renderLandmarks(landmarks, rawGesture);
            if (rawGesture && rawGesture !== 'NONE') {
              this.overlay?.highlightGesture(rawGesture);
            }
          },
          onError: (err) => {
            console.warn('[GestureControls] HandTracker error:', err);
            this.onError?.(err);
            this.overlay?.setCameraError(err?.message || 'Webcam unavailable');
          },
        });
      }

      try {
        await this.tracker.start();
      } catch (err) {
        console.warn('[GestureControls] Tracker start failure:', err);
        this.onError?.(err);
        this.overlay?.setCameraError(err?.message || 'Webcam unavailable');
      }
    } else {
      this.audioEngine.playRelease();
      this.overlay?.hide();
      this.tracker?.stop();
    }
  }

  /**
   * Manually trigger a gesture action (for testing / fallback).
   */
  triggerSimulatedGesture(gestureName) {
    this.overlay?.highlightGesture(gestureName);
    const action = this.mapper?._mapGestureToAction(gestureName);
    if (action) {
      this._handleMappedAction(action, {
        simulated: true,
        gesture: gestureName,
      });
    }
  }

  _handleMappedAction(action, payload) {
    if (!this.isEnabled && !payload?.simulated) return;
    this.audioEngine.playClick();
    this.onAction?.(action, payload);
  }

  showHelpModal() {
    if (typeof document === 'undefined') return;
    this.closeHelpModal();

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'gev-gesture-modal';
    this.modalEl.innerHTML = `
      <div class="gev-gesture-card">
        <div class="gev-gesture-card-title">
          <span>🖐️ TACTICAL GESTURE REFERENCE</span>
          <button class="gev-gesture-pip-close" id="gev-gesture-modal-close">✕</button>
        </div>
        <p style="font-size: 11px; color: #8fa3b5; margin-bottom: 12px;">
          Hold gesture in webcam view to trigger commands without touching mouse or keyboard:
        </p>
        <div class="gev-gesture-grid">
          <div class="gev-gesture-grid-item">
            <span class="gev-gesture-grid-icon">☝️</span>
            <div class="gev-gesture-grid-text">
              <strong>POINT & DRAG</strong>
              <span>Pan the 3D globe</span>
            </div>
          </div>
          <div class="gev-gesture-grid-item">
            <span class="gev-gesture-grid-icon">✊</span>
            <div class="gev-gesture-grid-text">
              <strong>CLOSED FIST</strong>
              <span>Lock / Unlock target</span>
            </div>
          </div>
          <div class="gev-gesture-grid-item">
            <span class="gev-gesture-grid-icon">🤏</span>
            <div class="gev-gesture-grid-text">
              <strong>PINCH</strong>
              <span>Zoom in & out</span>
            </div>
          </div>
          <div class="gev-gesture-grid-item">
            <span class="gev-gesture-grid-icon">✋</span>
            <div class="gev-gesture-grid-text">
              <strong>OPEN PALM</strong>
              <span>Reset globe home</span>
            </div>
          </div>
          <div class="gev-gesture-grid-item">
            <span class="gev-gesture-grid-icon">👆</span>
            <div class="gev-gesture-grid-text">
              <strong>TWO FINGERS</strong>
              <span>Toggle Cockpit view</span>
            </div>
          </div>
          <div class="gev-gesture-grid-item">
            <span class="gev-gesture-grid-icon">✌️</span>
            <div class="gev-gesture-grid-text">
              <strong>PEACE SIGN</strong>
              <span>Cycle visual styles</span>
            </div>
          </div>
          <div class="gev-gesture-grid-item">
            <span class="gev-gesture-grid-icon">🤙</span>
            <div class="gev-gesture-grid-text">
              <strong>SHAKA / HANG LOOSE</strong>
              <span>Toggle Voice Control</span>
            </div>
          </div>
          <div class="gev-gesture-grid-item">
            <span class="gev-gesture-grid-icon">🫱</span>
            <div class="gev-gesture-grid-text">
              <strong>SWIPE HAND</strong>
              <span>Next / Prev contact</span>
            </div>
          </div>
        </div>
      </div>
    `;

    this.modalEl
      .querySelector('#gev-gesture-modal-close')
      ?.addEventListener('click', () => {
        this.closeHelpModal();
      });

    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.closeHelpModal();
    });

    document.body.appendChild(this.modalEl);
  }

  closeHelpModal() {
    this.modalEl?.remove();
    this.modalEl = null;
  }

  destroy() {
    this.toggle(false);
    this.closeHelpModal();
    this.overlay?.destroy();
    this.root?.remove();
    this.root = null;
  }
}
