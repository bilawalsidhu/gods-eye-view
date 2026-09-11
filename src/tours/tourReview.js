/**
 * Tour Review panel: beat scrubber + framing readout for agent/human QA.
 * Enable via ?tourReview=1 or the Review control next to Surprise Me.
 * @module tours/tourReview
 */

function wantsReviewUi() {
  try {
    return new URLSearchParams(window.location.search).has('tourReview')
      || window.localStorage?.getItem('gev.tourReview') === '1';
  } catch {
    return false;
  }
}

export class TourReviewPanel {
  /**
   * @param {import('./tourEngine.js').TourEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.root = document.getElementById('tour-review');
    if (!this.root) {
      this.root = document.createElement('div');
      this.root.id = 'tour-review';
      this.root.className = 'tour-review';
      this.root.hidden = true;
      document.body.appendChild(this.root);
    }
    this.root.innerHTML = `
      <div class="tour-review-head">
        <div class="tour-review-kicker">TOUR REVIEW</div>
        <button type="button" id="tour-review-close" title="Close">×</button>
      </div>
      <div class="tour-review-row">
        <select id="tour-review-tour" aria-label="Tour"></select>
        <button type="button" id="tour-review-load">Load</button>
      </div>
      <div class="tour-review-readout" id="tour-review-readout">No tour loaded</div>
      <div class="tour-review-beats" id="tour-review-beats"></div>
      <div class="tour-review-actions">
        <button type="button" id="tour-review-prev">Prev</button>
        <button type="button" id="tour-review-apply">Apply camera</button>
        <button type="button" id="tour-review-next">Next</button>
      </div>
    `;
    this.tourSelect = this.root.querySelector('#tour-review-tour');
    this.beatsEl = this.root.querySelector('#tour-review-beats');
    this.readoutEl = this.root.querySelector('#tour-review-readout');
    this.root.querySelector('#tour-review-close').addEventListener('click', () => this.hide());
    this.root.querySelector('#tour-review-load').addEventListener('click', () => { void this._loadSelected(); });
    this.root.querySelector('#tour-review-prev').addEventListener('click', () => { void this._step(-1); });
    this.root.querySelector('#tour-review-next').addEventListener('click', () => { void this._step(1); });
    this.root.querySelector('#tour-review-apply').addEventListener('click', () => {
      void this.engine.previewBeat(this.engine.beatIndex || 0);
    });
    this._bindToggle();
    engine.subscribe((status) => this._onStatus(status));
    if (wantsReviewUi()) this.show();
    void this._refreshTourList();
  }

  _bindToggle() {
    const host = document.getElementById('location-pills');
    let btn = document.getElementById('tour-review-btn');
    if (!btn && host) {
      btn = document.createElement('button');
      btn.id = 'tour-review-btn';
      btn.type = 'button';
      btn.className = 'location-pill location-pill-review';
      btn.textContent = 'Tour Review';
      btn.title = 'Open beat framing review';
      host.appendChild(btn);
    }
    if (btn) {
      btn.addEventListener('click', () => {
        if (this.root.hidden) this.show();
        else this.hide();
      });
    }
  }

  show() {
    this.root.hidden = false;
    document.body.classList.add('tour-review-open');
    try { window.localStorage?.setItem('gev.tourReview', '1'); } catch { /* ignore */ }
    void this._refreshTourList();
  }

  hide() {
    this.root.hidden = true;
    document.body.classList.remove('tour-review-open');
  }

  async _refreshTourList() {
    const tours = await this.engine.listTours().catch(() => []);
    const list = Array.isArray(tours) ? tours : [];
    const current = this.tourSelect.value;
    this.tourSelect.innerHTML = list.map((tour) => {
      const id = tour.id || tour.tourId || '';
      const label = tour.title || tour.city || id;
      return `<option value="${escapeAttr(id)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (current) this.tourSelect.value = current;
  }

  async _loadSelected() {
    const id = this.tourSelect.value;
    if (!id) return;
    const result = await this.engine.loadForReview(id);
    if (!result?.ok) {
      this.readoutEl.textContent = result?.error || 'Failed to load tour';
      return;
    }
    this._renderBeats();
    await this.engine.previewBeat(0);
  }

  _renderBeats() {
    const beats = this.engine.tour?.beats || [];
    this.beatsEl.innerHTML = beats.map((beat, index) => {
      const cam = beat.camera || {};
      const meta = cam.mode === 'flyTo'
        ? `alt ${cam.alt ?? '—'} · pitch ${cam.pitch ?? '—'}`
        : `range ${cam.rangeM ?? '—'} · h ${cam.buildingHeight ?? '—'}`;
      return `<button type="button" class="tour-review-beat" data-index="${index}">
        <span class="tour-review-beat-idx">${index + 1}</span>
        <span class="tour-review-beat-body">
          <strong>${escapeHtml(beat.title || beat.id || `Beat ${index + 1}`)}</strong>
          <em>${escapeHtml(beat.kind || '')} · ${escapeHtml(cam.mode || '')}</em>
          <small>${escapeHtml(meta)}</small>
        </span>
      </button>`;
    }).join('');
    this.beatsEl.querySelectorAll('.tour-review-beat').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.getAttribute('data-index'));
        void this.engine.previewBeat(index);
      });
    });
  }

  async _step(delta) {
    if (!this.engine.tour?.beats?.length) return;
    const next = Math.max(0, Math.min(this.engine.tour.beats.length - 1, (this.engine.beatIndex || 0) + delta));
    await this.engine.previewBeat(next);
  }

  _onStatus(status) {
    const review = typeof window !== 'undefined' ? window.__gevTourReview : null;
    const beat = this.engine.tour?.beats?.[status?.beatIndex ?? 0];
    const cam = beat?.camera || review?.camera || {};
    if (this.engine.tour && this.beatsEl.children.length !== (this.engine.tour.beats?.length || 0)) {
      this._renderBeats();
    }
    this.beatsEl.querySelectorAll('.tour-review-beat').forEach((btn, index) => {
      btn.classList.toggle('is-active', index === (status?.beatIndex ?? review?.beatIndex));
    });
    if (!this.engine.tour) {
      this.readoutEl.textContent = 'No tour loaded';
      return;
    }
    const lines = [
      `${this.engine.tour.title || this.engine.tour.id} · beat ${(status?.beatIndex ?? 0) + 1}/${this.engine.tour.beats.length}`,
      `${beat?.kind || '?'} · ${cam.mode || '?'} · ${review?.status || (status?.reviewing ? 'review' : status?.running ? 'playing' : 'idle')}`,
      `lat ${fmt(cam.lat ?? beat?.place?.lat)} lon ${fmt(cam.lon ?? beat?.place?.lon)}`,
      cam.mode === 'flyTo'
        ? `alt ${fmt(cam.alt)} pitch ${fmt(cam.pitch)} heading ${fmt(cam.heading)}`
        : `rangeM ${fmt(cam.rangeM)} pitch ${fmt(cam.pitch)} heading ${fmt(cam.heading)} height ${fmt(cam.buildingHeight)}`,
    ];
    this.readoutEl.textContent = lines.join('\n');
  }
}

function fmt(value) {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(4).replace(/\.?0+$/, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
