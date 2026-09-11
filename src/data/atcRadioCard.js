/**
 * @module atcRadioCard
 * @description Avionics COM1 Air Traffic Control (ATC) card UI component.
 * Renders tactical frequencies, flight phase badges, live audio playback controls,
 * and nearest airport proximity indicators.
 */

export class AtcRadioCard {
  /**
   * @param {object} params
   * @param {import('./atcRadio.js').AtcRadioSystem} params.atcRadio
   * @param {HTMLElement} [params.container=document.body]
   */
  constructor({ atcRadio, container = typeof document !== 'undefined' ? document.body : null }) {
    this.atcRadio = atcRadio;
    this.container = container;
    this.element = null;
    this._visible = false;
    this._unsubscribe = null;
    this._dom = {};
    this._lastAnnouncedIcao = null;
    this._lastAnnouncedFreq = null;

    if (typeof document !== 'undefined' && this.container) {
      this._buildDOM();
      this._attachEvents();
      this._unsubscribe = this.atcRadio.subscribe((state) => this.render(state));
    }
  }

  get visible() {
    return this._visible;
  }

  /**
   * Build the DOM hierarchy and cache element handles.
   * @private
   */
  _buildDOM() {
    let existing = document.getElementById('atc-radio-card');
    if (existing) {
      this.element = existing;
      this._cacheDomReferences();
      return;
    }

    const card = document.createElement('div');
    card.id = 'atc-radio-card';
    card.className = 'atc-radio-card';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Air Traffic Control COM1 Radio');
    card.setAttribute('tabindex', '-1');
    card.hidden = true;

    card.innerHTML = `
      <div class="atc-card-header">
        <div class="atc-card-title">
          <span class="atc-pulse-dot" aria-hidden="true"></span>
          <span id="atc-card-heading">COM1 · ATC RADIO</span>
        </div>
        <div class="atc-header-actions">
          <button id="atc-auto-btn" class="atc-pill-btn active" type="button" aria-pressed="true" title="Toggle Proximity Auto-Tune" aria-label="Toggle auto-tuning">AUTO</button>
          <button id="atc-close-btn" class="atc-close-btn" type="button" aria-label="Close ATC Radio (Esc)" title="Close (Esc)">✕</button>
        </div>
      </div>
      <div class="atc-card-body">
        <div class="atc-station-row">
          <div class="atc-airport-block">
            <strong id="atc-airport-label">KAUS · AUSTIN-BERGSTROM</strong>
            <span id="atc-distance-label">14.2 NM</span>
          </div>
          <div class="atc-frequency-block">
            <span id="atc-freq-type-label">TWR</span>
            <strong id="atc-frequency-display">121.000</strong>
            <small>MHz</small>
          </div>
        </div>

        <div class="atc-phase-bar">
          <span id="atc-phase-badge" class="atc-phase-badge">FINAL APPROACH</span>
          <span id="atc-status-chip" class="atc-status-chip">TUNED · LIVE</span>
        </div>

        <div class="atc-controls-row">
          <div class="atc-freq-selector" role="group" aria-label="Frequency selector">
            <button data-freq-type="tower" class="atc-freq-btn active" type="button" aria-pressed="true" aria-label="Tower frequency">TWR</button>
            <button data-freq-type="approach" class="atc-freq-btn" type="button" aria-pressed="false" aria-label="Approach control frequency">APP</button>
            <button data-freq-type="atis" class="atc-freq-btn" type="button" aria-pressed="false" aria-label="Automatic Terminal Information Service">ATIS</button>
            <button data-freq-type="ground" class="atc-freq-btn" type="button" aria-pressed="false" aria-label="Ground control frequency">GND</button>
          </div>
          <div class="atc-audio-controls">
            <button id="atc-audio-btn" class="atc-audio-toggle" type="button" aria-pressed="false" title="Toggle Live Audio" aria-label="Toggle live audio stream">
              <span id="atc-audio-icon">▶</span>
              <span id="atc-audio-text">LIVE</span>
            </button>
            <button id="atc-mute-btn" class="atc-mute-toggle" type="button" aria-pressed="false" title="Mute Radio" aria-label="Mute audio">MUTE</button>
          </div>
        </div>

        <div class="atc-volume-row">
          <label for="atc-volume-slider">VOL</label>
          <input id="atc-volume-slider" type="range" min="0" max="100" value="80" aria-label="ATC Radio volume" />
          <output id="atc-volume-output" for="atc-volume-slider">80%</output>
        </div>
      </div>
      <div id="atc-live-announcer" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
    `;

    this.container.appendChild(card);
    this.element = card;
    this._cacheDomReferences();
  }

  /**
   * Cache querySelector handles to eliminate DOM lookup churn on frames.
   * @private
   */
  _cacheDomReferences() {
    if (!this.element) return;
    this._dom = {
      airportLabel: this.element.querySelector('#atc-airport-label'),
      distanceLabel: this.element.querySelector('#atc-distance-label'),
      freqTypeLabel: this.element.querySelector('#atc-freq-type-label'),
      freqDisplay: this.element.querySelector('#atc-frequency-display'),
      phaseBadge: this.element.querySelector('#atc-phase-badge'),
      statusChip: this.element.querySelector('#atc-status-chip'),
      autoBtn: this.element.querySelector('#atc-auto-btn'),
      audioBtn: this.element.querySelector('#atc-audio-btn'),
      audioIcon: this.element.querySelector('#atc-audio-icon'),
      audioText: this.element.querySelector('#atc-audio-text'),
      muteBtn: this.element.querySelector('#atc-mute-btn'),
      volSlider: this.element.querySelector('#atc-volume-slider'),
      volOutput: this.element.querySelector('#atc-volume-output'),
      closeBtn: this.element.querySelector('#atc-close-btn'),
      liveAnnouncer: this.element.querySelector('#atc-live-announcer'),
      freqButtons: this.element.querySelectorAll('[data-freq-type]'),
    };
  }

  /**
   * Attach user interaction listeners.
   * @private
   */
  _attachEvents() {
    if (!this.element) return;

    // Close button
    this._dom.closeBtn?.addEventListener('click', () => this.hide());

    // Auto-tune toggle
    this._dom.autoBtn?.addEventListener('click', () => {
      this.atcRadio.setAutoTune(!this.atcRadio.autoTuneEnabled);
    });

    // Audio Play/Squelch toggle
    this._dom.audioBtn?.addEventListener('click', () => {
      this.atcRadio.toggleAudio();
    });

    // Mute toggle
    this._dom.muteBtn?.addEventListener('click', () => {
      this.atcRadio.audio.toggleMute();
    });

    // Volume slider
    this._dom.volSlider?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10) / 100;
      this.atcRadio.audio.setVolume(val);
      if (this._dom.volOutput) this._dom.volOutput.textContent = `${e.target.value}%`;
    });

    // Frequency selector buttons
    this._dom.freqButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-freq-type');
        this.atcRadio.selectFrequency(type);
      });
    });

    // Keyboard dismiss (Escape)
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
      }
    });
  }

  /**
   * Render state snapshot into cached DOM nodes.
   * Skips execution when card is not visible to prevent layout thrashing.
   * @param {object} [state=this.atcRadio.state]
   */
  render(state = this.atcRadio.state) {
    if (!this.element || !this._visible || this.element.hidden) return;

    const tune = state.tune || {};
    const airport = tune.airport;

    // Airport & distance
    if (this._dom.airportLabel) {
      this._dom.airportLabel.textContent = airport ? `${airport.icao} · ${airport.name}` : 'NO STATION IN RANGE';
    }
    if (this._dom.distanceLabel) {
      this._dom.distanceLabel.textContent = Number.isFinite(tune.distanceNm) ? `${tune.distanceNm.toFixed(1)} NM` : '-- NM';
    }

    // Frequency display
    if (this._dom.freqTypeLabel) {
      this._dom.freqTypeLabel.textContent = (tune.freqType || 'COM1').toUpperCase();
    }
    if (this._dom.freqDisplay) {
      this._dom.freqDisplay.textContent = tune.frequencyMHz || '121.500';
    }

    // Phase & Status
    if (this._dom.phaseBadge) {
      const phaseNames = {
        approach: 'FINAL APPROACH',
        surface: 'SURFACE / TAXI',
        departure: 'DEPARTURE CLIMB',
        enroute: 'EN-ROUTE CRUISE',
      };
      this._dom.phaseBadge.textContent = phaseNames[tune.phase] || 'MONITORING';
      this._dom.phaseBadge.setAttribute('data-phase', tune.phase || 'enroute');
    }

    if (this._dom.statusChip) {
      const isLive = state.audioState === 'playing';
      const isError = state.audioState === 'error';
      const statusText = isError
        ? 'STREAM OFFLINE'
        : (isLive ? 'LIVE AUDIO' : (tune.inRange ? 'TUNED' : 'SQUELCH STANDBY'));
      this._dom.statusChip.textContent = statusText;
      this._dom.statusChip.setAttribute('data-status', isError ? 'error' : (isLive ? 'live' : (tune.inRange ? 'tuned' : 'squelch')));
    }

    // Auto button state
    if (this._dom.autoBtn) {
      this._dom.autoBtn.classList.toggle('active', state.autoTune);
      this._dom.autoBtn.setAttribute('aria-pressed', String(Boolean(state.autoTune)));
    }

    // Audio Play button state
    if (this._dom.audioBtn) {
      const isPlaying = state.audioState === 'playing';
      this._dom.audioBtn.classList.toggle('active', isPlaying);
      this._dom.audioBtn.setAttribute('aria-pressed', String(isPlaying));
      if (this._dom.audioIcon) this._dom.audioIcon.textContent = isPlaying ? '■' : '▶';
      if (this._dom.audioText) this._dom.audioText.textContent = isPlaying ? 'ACTIVE' : 'LISTEN';
    }

    // Mute button
    if (this._dom.muteBtn) {
      this._dom.muteBtn.classList.toggle('active', state.muted);
      this._dom.muteBtn.setAttribute('aria-pressed', String(Boolean(state.muted)));
      this._dom.muteBtn.textContent = state.muted ? 'MUTED' : 'MUTE';
    }

    // Volume slider sync (guard against overriding active user drag)
    if (
      this._dom.volSlider &&
      (typeof document === 'undefined' || document.activeElement !== this._dom.volSlider) &&
      Math.round(state.volume * 100) !== parseInt(this._dom.volSlider.value, 10)
    ) {
      this._dom.volSlider.value = String(Math.round(state.volume * 100));
      if (this._dom.volOutput) this._dom.volOutput.textContent = `${this._dom.volSlider.value}%`;
    }

    // Highlight active frequency button & sync aria-pressed
    this._dom.freqButtons?.forEach((btn) => {
      const type = btn.getAttribute('data-freq-type');
      const isActive = type === tune.freqType;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });

    // Screen reader polite live announcement on discrete station change
    if (
      this._dom.liveAnnouncer &&
      (this._lastAnnouncedIcao !== airport?.icao || this._lastAnnouncedFreq !== tune.frequencyMHz)
    ) {
      this._lastAnnouncedIcao = airport?.icao || null;
      this._lastAnnouncedFreq = tune.frequencyMHz || null;
      if (airport && tune.frequencyMHz) {
        this._dom.liveAnnouncer.textContent = `Tuned to ${airport.name} ${tune.freqType || 'tower'} on ${tune.frequencyMHz} megahertz`;
      }
    }
  }

  /**
   * Reveal the ATC radio card on screen.
   */
  show() {
    this._visible = true;
    if (this.element) {
      this.element.hidden = false;
      this.render();
    }
  }

  /**
   * Hide the ATC radio card.
   */
  hide() {
    this._visible = false;
    if (this.element) {
      this.element.hidden = true;
    }
  }

  /**
   * Toggle ATC radio card visibility.
   */
  toggle() {
    if (this._visible) this.hide();
    else this.show();
  }

  /**
   * Clean up subscriptions and remove DOM element.
   */
  destroy() {
    this._unsubscribe?.();
    this.element?.remove();
    this.element = null;
    this._dom = {};
  }
}
