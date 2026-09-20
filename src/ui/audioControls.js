/**
 * Tactical Audio UI Controls.
 *
 * Provides a sci-fi audio control panel with master volume slider,
 * per-category toggles (SFX, Alerts, Ambiance), and instant mute toggle.
 */

import { getTacticalAudio } from '../audio/tacticalAudio.js';

export class AudioControls {
  /**
   * @param {object} options
   * @param {HTMLElement} [options.container] - DOM element to append controls into
   * @param {TacticalAudioEngine} [options.audioEngine]
   */
  constructor({ container = null, audioEngine = null } = {}) {
    this.audioEngine = audioEngine || getTacticalAudio();
    this.container = container;
    this.root = null;
    this._isOpen = false;
    this._initDom();
  }

  _initDom() {
    if (typeof document === 'undefined') return;

    this.root = document.createElement('div');
    this.root.className = 'gev-audio-controls';
    this.root.innerHTML = `
      <button class="gev-audio-toggle-btn" title="Tactical Audio Settings" aria-label="Toggle Tactical Audio">
        <span class="gev-audio-icon">🔊</span>
        <span class="gev-audio-label">AUDIO</span>
      </button>
      <div class="gev-audio-popup" hidden>
        <div class="gev-audio-popup-header">
          <span class="gev-audio-popup-title">TACTICAL AUDIO ENGINE</span>
          <button class="gev-audio-mute-btn" title="Toggle Mute">MUTE</button>
        </div>
        <div class="gev-audio-row">
          <label for="gev-master-vol">MASTER</label>
          <input type="range" id="gev-master-vol" min="0" max="100" value="85" />
          <span class="gev-vol-val" id="gev-master-val">85%</span>
        </div>
        <div class="gev-audio-row">
          <label for="gev-sfx-vol">SFX</label>
          <input type="range" id="gev-sfx-vol" min="0" max="100" value="80" />
          <span class="gev-vol-val" id="gev-sfx-val">80%</span>
        </div>
        <div class="gev-audio-row">
          <label for="gev-alert-vol">ALERTS</label>
          <input type="range" id="gev-alert-vol" min="0" max="100" value="100" />
          <span class="gev-vol-val" id="gev-alert-val">100%</span>
        </div>
        <div class="gev-audio-row">
          <label for="gev-ambiance-vol">AMBIANCE</label>
          <input type="range" id="gev-ambiance-vol" min="0" max="100" value="60" />
          <span class="gev-vol-val" id="gev-ambiance-val">60%</span>
        </div>
        <div class="gev-audio-test-row">
          <button class="gev-audio-test-btn" data-sfx="lock">TEST LOCK</button>
          <button class="gev-audio-test-btn" data-sfx="alert">TEST ALERT</button>
        </div>
      </div>
    `;

    this._bindEvents();

    if (this.container) {
      this.container.appendChild(this.root);
    }
  }

  _bindEvents() {
    if (!this.root) return;

    const toggleBtn = this.root.querySelector('.gev-audio-toggle-btn');
    const popup = this.root.querySelector('.gev-audio-popup');
    const muteBtn = this.root.querySelector('.gev-audio-mute-btn');
    const masterSlider = this.root.querySelector('#gev-master-vol');
    const masterVal = this.root.querySelector('#gev-master-val');
    const sfxSlider = this.root.querySelector('#gev-sfx-vol');
    const sfxVal = this.root.querySelector('#gev-sfx-val');
    const alertSlider = this.root.querySelector('#gev-alert-vol');
    const alertVal = this.root.querySelector('#gev-alert-val');
    const ambSlider = this.root.querySelector('#gev-ambiance-vol');
    const ambVal = this.root.querySelector('#gev-ambiance-val');

    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._isOpen = !this._isOpen;
      popup.hidden = !this._isOpen;
      toggleBtn.classList.toggle('active', this._isOpen);
    });

    muteBtn?.addEventListener('click', () => {
      const isMuted = !this.audioEngine.isMuted();
      this.audioEngine.setMuted(isMuted);
      muteBtn.textContent = isMuted ? 'UNMUTE' : 'MUTE';
      muteBtn.classList.toggle('muted', isMuted);
      if (!isMuted) {
        this.audioEngine.playClick();
      }
    });

    masterSlider?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      this.audioEngine.setMasterVolume(v / 100);
      masterVal.textContent = `${v}%`;
    });

    sfxSlider?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      this.audioEngine.setCategoryVolume('sfx', v / 100);
      sfxVal.textContent = `${v}%`;
    });

    alertSlider?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      this.audioEngine.setCategoryVolume('alerts', v / 100);
      alertVal.textContent = `${v}%`;
    });

    ambSlider?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      this.audioEngine.setCategoryVolume('ambiance', v / 100);
      ambVal.textContent = `${v}%`;
    });

    this.root.querySelectorAll('.gev-audio-test-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const sfx = e.target.dataset.sfx;
        if (sfx === 'lock') this.audioEngine.playLock();
        else if (sfx === 'alert') this.audioEngine.playAlert();
      });
    });

    document.addEventListener('click', (e) => {
      if (this._isOpen && !this.root.contains(e.target)) {
        this._isOpen = false;
        popup.hidden = true;
        toggleBtn?.classList.remove('active');
      }
    });
  }

  destroy() {
    this.root?.remove();
    this.root = null;
  }
}
