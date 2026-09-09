/**
 * Progress popup + idle Surprise Me control for guided tours.
 * Gallery by default: prev/next/stop + Autoplay + Camera shot cycle.
 * Pause only when Autoplay is on.
 * @module tours/tourPopup
 */

export class TourPopup {
  /**
   * @param {import('./tourEngine.js').TourEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.root = document.getElementById('tour-popup');
    if (!this.root) {
      this.root = document.createElement('div');
      this.root.id = 'tour-popup';
      this.root.className = 'tour-popup';
      this.root.hidden = true;
      document.body.appendChild(this.root);
    }
    this.root.innerHTML = `
      <div class="tour-popup-kicker">GUIDED TOUR</div>
      <div class="tour-popup-title" id="tour-popup-title">Tour</div>
      <div class="tour-popup-beat" id="tour-popup-beat">0 / 0</div>
      <div class="tour-popup-status" id="tour-popup-status" hidden></div>
      <div class="tour-popup-progress" id="tour-popup-progress" aria-hidden="true"><div id="tour-popup-progress-fill"></div></div>
      <div class="tour-popup-controls">
        <button type="button" id="tour-prev" title="Previous beat">&#x23EE;</button>
        <button type="button" id="tour-next" title="Next beat">&#x23ED;</button>
        <button type="button" id="tour-stop" title="Stop">&#x23F9;</button>
        <button type="button" id="tour-playpause" class="tour-popup-pause" title="Pause Autoplay" hidden>&#x23F8;</button>
      </div>
      <div class="tour-popup-toggles">
        <button type="button" id="tour-camera-shot" class="tour-popup-camera" title="Cycle camera shot">Camera</button>
        <button type="button" id="tour-autoplay" class="tour-popup-autoplay" aria-pressed="false">Autoplay</button>
      </div>
    `;
    this.titleEl = this.root.querySelector('#tour-popup-title');
    this.beatEl = this.root.querySelector('#tour-popup-beat');
    this.statusEl = this.root.querySelector('#tour-popup-status');
    this.fillEl = this.root.querySelector('#tour-popup-progress-fill');
    this.progressEl = this.root.querySelector('#tour-popup-progress');
    this.playPauseBtn = this.root.querySelector('#tour-playpause');
    this.autoplayBtn = this.root.querySelector('#tour-autoplay');
    this.cameraBtn = this.root.querySelector('#tour-camera-shot');
    this.root.querySelector('#tour-prev').addEventListener('click', () => { void this.engine.prev(); });
    this.root.querySelector('#tour-next').addEventListener('click', () => { void this.engine.next(); });
    this.root.querySelector('#tour-stop').addEventListener('click', () => this.engine.stop('Stopped'));
    this.playPauseBtn.addEventListener('click', () => {
      if (this.engine.paused) void this.engine.resume();
      else this.engine.pause('Paused');
    });
    this.autoplayBtn.addEventListener('click', () => {
      void this.engine.setAutoplay(!this.engine.autoplay);
    });
    this.cameraBtn.addEventListener('click', () => {
      void this.engine.cycleCameraShot();
    });
    this.progressEl.addEventListener('click', (event) => {
      const total = this.engine.tour?.beats?.length || 0;
      if (total < 2) return;
      const rect = this.progressEl.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const index = Math.min(total - 1, Math.floor(t * total));
      void this.engine.seekTo(index, { wrap: false });
    });

    this._onKeyDown = (event) => this._handleKeys(event);
    document.addEventListener('keydown', this._onKeyDown);

    this._bindSurprise();
    engine.subscribe((status) => this.render(status));
  }

  _handleKeys(event) {
    if (!this.engine.running) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void this.engine.prev();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      void this.engine.next();
    }
  }

  _bindSurprise() {
    const host = document.getElementById('location-pills');
    let btn = document.getElementById('tour-surprise-btn');
    if (!btn && host) {
      btn = document.createElement('button');
      btn.id = 'tour-surprise-btn';
      btn.type = 'button';
      btn.className = 'location-pill location-pill-surprise';
      btn.textContent = 'Surprise Me';
      btn.title = 'Play a random saved tour';
      host.appendChild(btn);
    }
    if (btn) {
      btn.addEventListener('click', () => {
        void this.engine.random();
      });
    }
  }

  render(status) {
    const running = !!status?.running;
    this.root.hidden = !running;
    document.body.classList.toggle('tour-playback-mode', running);
    if (!running) return;
    const total = Math.max(1, status.beatCount || 1);
    const index = Math.max(0, status.beatIndex || 0);
    this.titleEl.textContent = status.beatTitle || status.title || 'Tour';
    this.beatEl.textContent = `${index + 1} / ${total}`;
    const pct = ((index + 0.5) / total) * 100;
    if (this.fillEl) this.fillEl.style.width = `${Math.max(4, Math.min(100, pct))}%`;

    const approaching = String(status.approachStatus || '').trim();
    this.statusEl.hidden = !approaching;
    this.statusEl.textContent = approaching;

    const shotName = status.shotLabel || 'Camera';
    this.cameraBtn.textContent = shotName;
    this.cameraBtn.title = `Camera shot: ${shotName} — click to cycle`;

    const autoplay = !!status.autoplay;
    this.autoplayBtn.setAttribute('aria-pressed', autoplay ? 'true' : 'false');
    this.autoplayBtn.classList.toggle('is-on', autoplay);
    this.autoplayBtn.textContent = autoplay ? 'Autoplay on' : 'Autoplay';
    this.playPauseBtn.hidden = !autoplay;
    this.playPauseBtn.innerHTML = status.paused ? '&#x25B6;' : '&#x23F8;';
    this.playPauseBtn.title = status.paused ? 'Resume Autoplay' : 'Pause Autoplay';
  }
}
