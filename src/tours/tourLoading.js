/**
 * Full-screen locked loading overlay for tour generate / first camera move.
 * @module tours/tourLoading
 */

export class TourLoadingOverlay {
  constructor() {
    this.root = document.getElementById('tour-loading');
    if (!this.root) {
      this.root = document.createElement('div');
      this.root.id = 'tour-loading';
      this.root.className = 'tour-loading';
      this.root.hidden = true;
      this.root.setAttribute('role', 'alertdialog');
      this.root.setAttribute('aria-modal', 'true');
      this.root.setAttribute('aria-live', 'polite');
      document.body.appendChild(this.root);
    }
    this.root.innerHTML = `
      <div class="tour-loading-card">
        <div class="tour-loading-kicker">GUIDED TOUR</div>
        <div class="tour-loading-title" id="tour-loading-title">Preparing tour</div>
        <div class="tour-loading-status" id="tour-loading-status">Please wait…</div>
        <div class="tour-loading-bar" aria-hidden="true">
          <div class="tour-loading-bar-fill" id="tour-loading-bar-fill"></div>
        </div>
        <div class="tour-loading-pct" id="tour-loading-pct">0%</div>
      </div>
    `;
    this.titleEl = this.root.querySelector('#tour-loading-title');
    this.statusEl = this.root.querySelector('#tour-loading-status');
    this.fillEl = this.root.querySelector('#tour-loading-bar-fill');
    this.pctEl = this.root.querySelector('#tour-loading-pct');
    this._active = false;
    this._block = (event) => {
      if (!this._active) return;
      // Allow Escape only if we expose cancel later; for now trap pointer/keys.
      if (event.type === 'keydown' && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    };
  }

  get active() {
    return this._active;
  }

  show({ title = 'Preparing tour', status = 'Please wait…', progress = 0.05 } = {}) {
    this._active = true;
    this.root.hidden = false;
    document.body.classList.add('tour-loading-lock');
    document.addEventListener('keydown', this._block, true);
    this.update({ title, status, progress });
  }

  update({ title, status, progress } = {}) {
    if (title != null && this.titleEl) this.titleEl.textContent = title;
    if (status != null && this.statusEl) this.statusEl.textContent = status;
    if (Number.isFinite(progress) && this.fillEl) {
      const pct = Math.max(0, Math.min(1, progress));
      this.fillEl.style.width = `${Math.round(pct * 100)}%`;
      if (this.pctEl) this.pctEl.textContent = `${Math.round(pct * 100)}%`;
    }
  }

  hide() {
    this._active = false;
    this.root.hidden = true;
    document.body.classList.remove('tour-loading-lock');
    document.removeEventListener('keydown', this._block, true);
  }
}

let _shared = null;
export function getTourLoadingOverlay() {
  if (!_shared) _shared = new TourLoadingOverlay();
  return _shared;
}
