/**
 * 4D Timeline Scrubber UI.
 *
 * Provides a sci-fi temporal playback bar allowing operators to scrub back
 * up to 24 hours in time, replay at 1x–8x speeds, and jump to instant historical offsets.
 */

import { getTacticalAudio } from '../audio/tacticalAudio.js';

export class TimelineScrubber {
  /**
   * @param {object} options
   * @param {HTMLElement} [options.container]
   * @param {TimelineCache} options.cache
   * @param {(entities: Array<object> | null, timestampMs: number, isLive: boolean) => void} options.onScrub
   * @param {TacticalAudioEngine} [options.audioEngine]
   */
  constructor({
    container = null,
    cache,
    onScrub = null,
    audioEngine = null,
  } = {}) {
    this.container = container;
    this.cache = cache;
    this.onScrub = onScrub;
    this.audioEngine = audioEngine || getTacticalAudio();

    this.root = null;
    this.isPlaying = false;
    this.playSpeed = 1;
    this.currentTimeMs = Date.now();
    this.isLive = true;

    this._animInterval = null;
    this._sliderEl = null;
    this._clockEl = null;

    this._init();
  }

  _init() {
    if (typeof document === 'undefined') return;

    this.root = document.createElement('div');
    this.root.className = 'gev-timeline-bar hidden';
    this.root.innerHTML = `
      <div class="gev-timeline-top">
        <div class="gev-timeline-controls">
          <button class="gev-timeline-btn" id="gev-tl-play">▶ PLAY</button>
          <button class="gev-timeline-btn" id="gev-tl-speed">1×</button>
          <button class="gev-timeline-btn active" id="gev-tl-live">LIVE</button>
          <button class="gev-timeline-btn" data-offset="900000">-15M</button>
          <button class="gev-timeline-btn" data-offset="3600000">-1H</button>
          <button class="gev-timeline-btn" data-offset="21600000">-6H</button>
          <button class="gev-timeline-btn" data-offset="86400000">-24H</button>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="gev-timeline-clock" id="gev-tl-clock">ZULU 00:00:00Z</div>
          <button class="gev-timeline-btn" id="gev-tl-close" title="Close Timeline Replay" style="padding: 1px 6px;">✕</button>
        </div>
      </div>
      <div class="gev-timeline-slider-row">
        <span class="gev-timeline-preset-tag">-24H</span>
        <input type="range" class="gev-timeline-slider" id="gev-tl-slider" min="0" max="1000" value="1000" />
        <span class="gev-timeline-preset-tag">LIVE</span>
      </div>
    `;

    this._sliderEl = this.root.querySelector('#gev-tl-slider');
    this._clockEl = this.root.querySelector('#gev-tl-clock');

    this._bindEvents();
    this._updateClock(Date.now());

    const closeBtn = this.root.querySelector('#gev-tl-close');
    closeBtn?.addEventListener('click', () => this.hide());

    if (this.container) {
      this.container.appendChild(this.root);
    } else {
      document.body.appendChild(this.root);
    }
  }

  show() {
    this.root?.classList.remove('hidden');
    this.audioEngine?.playClick();
  }

  hide() {
    this.root?.classList.add('hidden');
    this.seekLive();
  }

  toggle(show = undefined) {
    const willShow =
      show !== undefined
        ? Boolean(show)
        : this.root?.classList.contains('hidden');
    if (willShow) {
      this.show();
    } else {
      this.hide();
    }
    return willShow;
  }

  _bindEvents() {
    const playBtn = this.root.querySelector('#gev-tl-play');
    const speedBtn = this.root.querySelector('#gev-tl-speed');
    const liveBtn = this.root.querySelector('#gev-tl-live');

    playBtn?.addEventListener('click', () => {
      this.isPlaying = !this.isPlaying;
      playBtn.textContent = this.isPlaying ? '❚❚ PAUSE' : '▶ PLAY';
      playBtn.classList.toggle('active', this.isPlaying);
      this.audioEngine.playClick();
      if (this.isPlaying) {
        this.isLive = false;
        liveBtn?.classList.remove('active');
        this._startPlayback();
      } else {
        this._stopPlayback();
      }
    });

    speedBtn?.addEventListener('click', () => {
      const speeds = [1, 2, 4, 8];
      const nextIdx = (speeds.indexOf(this.playSpeed) + 1) % speeds.length;
      this.playSpeed = speeds[nextIdx];
      speedBtn.textContent = `${this.playSpeed}×`;
      this.audioEngine.playClick();
    });

    liveBtn?.addEventListener('click', () => {
      this.seekLive();
    });

    this.root.querySelectorAll('[data-offset]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const offsetMs = Number(e.target.dataset.offset);
        this.seekOffset(offsetMs);
      });
    });

    this._sliderEl?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      this.audioEngine.playClick();

      if (val >= 995) {
        this.seekLive();
        return;
      }

      this.isLive = false;
      liveBtn?.classList.remove('active');

      const range = this.cache.getTimeRange();
      const totalSpan = Math.max(60000, range.endMs - range.startMs);
      const targetTime = range.startMs + (val / 1000) * totalSpan;

      this._seekTo(targetTime);
    });
  }

  seekLive() {
    this.isLive = true;
    this.isPlaying = false;
    this._stopPlayback();

    const liveBtn = this.root?.querySelector('#gev-tl-live');
    const playBtn = this.root?.querySelector('#gev-tl-play');
    liveBtn?.classList.add('active');
    if (playBtn) {
      playBtn.textContent = '▶ PLAY';
      playBtn.classList.remove('active');
    }
    if (this._sliderEl) this._sliderEl.value = '1000';

    this.audioEngine.playRelease();
    this.currentTimeMs = Date.now();
    this._updateClock(this.currentTimeMs);
    this.onScrub?.(null, this.currentTimeMs, true);
  }

  seekOffset(offsetMs) {
    this.isLive = false;
    const targetTime = Date.now() - offsetMs;
    this._seekTo(targetTime);
  }

  _seekTo(timestampMs) {
    this.currentTimeMs = timestampMs;
    this._updateClock(timestampMs);

    // Sync slider position
    const range = this.cache.getTimeRange();
    const totalSpan = Math.max(60000, range.endMs - range.startMs);
    const pct = Math.max(
      0,
      Math.min(
        1000,
        Math.round(((timestampMs - range.startMs) / totalSpan) * 1000),
      ),
    );
    if (this._sliderEl) this._sliderEl.value = String(pct);

    const entities = this.cache.getEntitiesAtTime(timestampMs);
    this.onScrub?.(entities, timestampMs, false);
  }

  _startPlayback() {
    this._stopPlayback();
    this._animInterval = setInterval(() => {
      if (!this.isPlaying) return;
      const stepMs = 1000 * this.playSpeed;
      const nextTime = this.currentTimeMs + stepMs;

      if (nextTime >= Date.now()) {
        this.seekLive();
      } else {
        this._seekTo(nextTime);
      }
    }, 250);
  }

  _stopPlayback() {
    if (this._animInterval) {
      clearInterval(this._animInterval);
      this._animInterval = null;
    }
  }

  _updateClock(timestampMs) {
    if (!this._clockEl) return;
    const d = new Date(timestampMs);
    const zulu = d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
    this._clockEl.textContent = this.isLive ? `LIVE ${zulu}` : `REPLAY ${zulu}`;
  }

  destroy() {
    this._stopPlayback();
    this.root?.remove();
  }
}
