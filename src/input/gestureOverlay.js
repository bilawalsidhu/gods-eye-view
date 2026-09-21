/**
 * Gesture Overlay Renderer.
 *
 * Draws neon skeletal hand tracking feedback onto a corner PiP canvas and
 * manages floating active gesture badges.
 */

const SKELETON_CONNECTIONS = Object.freeze([
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4], // Thumb
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8], // Index
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12], // Middle
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16], // Ring
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20], // Pinky
]);

export class GestureOverlay {
  /**
   * @param {object} [options]
   * @param {HTMLElement} [options.container=document.body]
   * @param {() => void} [options.onClose]
   * @param {(gestureName: string) => void} [options.onSimulate]
   */
  constructor({ container = null, onClose = null, onSimulate = null } = {}) {
    this.container =
      container || (typeof document !== 'undefined' ? document.body : null);
    this.onClose = onClose;
    this.onSimulate = onSimulate;
    this.root = null;
    this.videoEl = null;
    this.canvas = null;
    this.ctx = null;
    this.badgeEl = null;
    this.modeEl = null;
    this._visible = false;
    this._activeGestureTimer = null;
    this._initDom();
  }

  get videoElement() {
    return this.videoEl;
  }

  _initDom() {
    if (typeof document === 'undefined' || !this.container) return;

    this.root = document.createElement('div');
    this.root.className = 'gev-gesture-pip hidden';
    this.root.innerHTML = `
      <div class="gev-gesture-pip-header">
        <div class="gev-gesture-header-title">
          <span class="gev-gesture-status-dot"></span>
          <span class="gev-gesture-title-text">GESTURE CONSOLE</span>
        </div>
        <div class="gev-gesture-header-meta">
          <span class="gev-gesture-mode-chip">CAM READY</span>
          <button class="gev-gesture-pip-close" title="Close Gesture Console">✕</button>
        </div>
      </div>
      <div class="gev-gesture-canvas-wrapper">
        <video class="gev-gesture-video" autoplay playsinline muted></video>
        <canvas class="gev-gesture-canvas" width="300" height="190"></canvas>
        <div class="gev-gesture-badge" hidden>LOOKING FOR HAND...</div>
        <div class="gev-gesture-hud-brackets" aria-hidden="true">
          <span class="gev-bracket tl"></span>
          <span class="gev-bracket tr"></span>
          <span class="gev-bracket bl"></span>
          <span class="gev-bracket br"></span>
        </div>
      </div>
      <div class="gev-gesture-deck">
        <button class="gev-sim-btn gev-gesture-card" data-gesture="PEACE_SIGN" title="Peace / V: Cockpit View">
          <span class="gev-gesture-card-icon">✌️</span>
          <div class="gev-gesture-card-body">
            <span class="gev-gesture-card-title">COCKPIT</span>
            <span class="gev-gesture-card-sub">Peace · Toggle View</span>
          </div>
          <kbd class="gev-gesture-card-kbd">V</kbd>
        </button>
        <button class="gev-sim-btn gev-gesture-card" data-gesture="FIST" title="Fist: Lock / Orbit Target">
          <span class="gev-gesture-card-icon">✊</span>
          <div class="gev-gesture-card-body">
            <span class="gev-gesture-card-title">LOCK</span>
            <span class="gev-gesture-card-sub">Fist · Target / Orbit</span>
          </div>
          <kbd class="gev-gesture-card-kbd">L</kbd>
        </button>
        <button class="gev-sim-btn gev-gesture-card" data-gesture="OPEN_PALM" title="Open Palm: Reset Globe">
          <span class="gev-gesture-card-icon">🖐️</span>
          <div class="gev-gesture-card-body">
            <span class="gev-gesture-card-title">GLOBE</span>
            <span class="gev-gesture-card-sub">Palm · Reset Overview</span>
          </div>
          <kbd class="gev-gesture-card-kbd">G</kbd>
        </button>
        <button class="gev-sim-btn gev-gesture-card" data-gesture="HANG_LOOSE" title="Shaka: Intel Dossier">
          <span class="gev-gesture-card-icon">🤙</span>
          <div class="gev-gesture-card-body">
            <span class="gev-gesture-card-title">DOSSIER</span>
            <span class="gev-gesture-card-sub">Shaka · Target Dossier</span>
          </div>
          <kbd class="gev-gesture-card-kbd">D</kbd>
        </button>
        <button class="gev-sim-btn gev-gesture-card" data-gesture="THUMBS_UP" title="Thumbs Up: Cycle Visual Presets">
          <span class="gev-gesture-card-icon">👍</span>
          <div class="gev-gesture-card-body">
            <span class="gev-gesture-card-title">PRESET</span>
            <span class="gev-gesture-card-sub">Thumbs · Cycle Style</span>
          </div>
          <kbd class="gev-gesture-card-kbd">P</kbd>
        </button>
      </div>
    `;

    this.videoEl = this.root.querySelector('.gev-gesture-video');
    this.canvas = this.root.querySelector('.gev-gesture-canvas');
    this.ctx = this.canvas?.getContext('2d') || null;
    this.badgeEl = this.root.querySelector('.gev-gesture-badge');
    this.modeEl = this.root.querySelector('.gev-gesture-mode-chip');

    const closeBtn = this.root.querySelector('.gev-gesture-pip-close');
    closeBtn?.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });

    this.root.querySelectorAll('.gev-sim-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const gesture = btn.getAttribute('data-gesture');
        if (gesture) {
          this.highlightGesture(gesture);
          this.onSimulate?.(gesture);
        }
      });
    });

    this.container.appendChild(this.root);
  }

  show() {
    this._visible = true;
    this.root?.classList.remove('hidden');
  }

  hide() {
    this._visible = false;
    this.root?.classList.add('hidden');
    this.clear();
  }

  clear() {
    if (!this.ctx || !this.canvas) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.badgeEl) this.badgeEl.hidden = true;
  }

  /**
   * Highlight recognized or clicked gesture card in the G-Tab deck.
   * @param {string} gestureName
   */
  highlightGesture(gestureName) {
    if (!this.root || !gestureName) return;
    this.root.querySelectorAll('.gev-sim-btn').forEach((btn) => {
      if (btn.getAttribute('data-gesture') === gestureName) {
        btn.classList.add('active');
        clearTimeout(this._activeGestureTimer);
        this._activeGestureTimer = setTimeout(() => {
          btn.classList.remove('active');
        }, 700);
      } else {
        btn.classList.remove('active');
      }
    });
  }

  /**
   * Display offline / manual fallback status when camera is unavailable.
   */
  setCameraError(message = '') {
    if (!this._visible) return;
    if (this.modeEl) {
      this.modeEl.textContent = 'MANUAL MODE';
      this.modeEl.classList.add('error');
    }
    if (this.badgeEl) {
      this.badgeEl.hidden = false;
      this.badgeEl.textContent = 'CAM OFFLINE · CLICK CARDS TO TEST';
      this.badgeEl.style.background = 'rgba(255, 60, 60, 0.4)';
      this.badgeEl.style.borderColor = '#ff3c3c';
      this.badgeEl.style.color = '#ffffff';
    }
    if (this.ctx && this.canvas) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.fillStyle = 'rgba(6, 16, 26, 0.95)';
      this.ctx.fillRect(0, 0, w, h);
      this.ctx.fillStyle = '#00f0ff';
      this.ctx.font = 'bold 11px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('MANUAL GESTURE CONSOLE', w / 2, h / 2 - 10);
      this.ctx.fillStyle = '#8fa3b5';
      this.ctx.font = '10px monospace';
      this.ctx.fillText(
        'Click gesture cards below to trigger',
        w / 2,
        h / 2 + 10,
      );
    }
  }

  /**
   * Draw smoothed hand landmarks and update gesture badge.
   * @param {Array<{x: number, y: number}>} landmarks
   * @param {string} gestureName
   */
  renderLandmarks(landmarks, gestureName = '') {
    if (!this._visible || !this.ctx || !this.canvas) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    // Clear canvas so underlying live mirrored video shows through!
    ctx.clearRect(0, 0, w, h);

    if (this.modeEl && !this.modeEl.classList.contains('error')) {
      this.modeEl.textContent = 'TRACKING LIVE';
    }

    if (!landmarks || landmarks.length < 21) {
      if (this.badgeEl) {
        this.badgeEl.hidden = false;
        this.badgeEl.textContent = 'LOOKING FOR HAND...';
        this.badgeEl.style.background = 'rgba(0, 240, 255, 0.2)';
        this.badgeEl.style.borderColor = 'rgba(0, 240, 255, 0.5)';
        this.badgeEl.style.color = '#ffffff';
      }
      return;
    }

    // Mirror horizontally so it feels natural like a mirror
    const pts = landmarks.map((lm) => {
      const lx = lm.x !== undefined ? lm.x : lm[0] !== undefined ? lm[0] : 0;
      const ly = lm.y !== undefined ? lm.y : lm[1] !== undefined ? lm[1] : 0;
      return {
        x: (1 - lx) * w,
        y: ly * h,
      };
    });

    // Draw skeletal lines with neon cybernetic styling
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 8;

    for (const [i, j] of SKELETON_CONNECTIONS) {
      const p1 = pts[i];
      const p2 = pts[j];
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    // Draw joints and fingertips
    ctx.shadowBlur = 4;
    pts.forEach((pt, idx) => {
      const isTip =
        idx === 4 || idx === 8 || idx === 12 || idx === 16 || idx === 20;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isTip ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isTip ? '#ffffff' : '#00f0ff';
      ctx.fill();
      if (isTip) {
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });

    // Update active gesture badge
    if (this.badgeEl) {
      this.badgeEl.hidden = false;
      if (gestureName && gestureName !== 'NONE') {
        this.badgeEl.textContent = `⚡ ${gestureName.replace(/_/g, ' ')}`;
        this.badgeEl.style.background = 'rgba(0, 255, 170, 0.35)';
        this.badgeEl.style.borderColor = '#00ffaa';
        this.badgeEl.style.color = '#ffffff';
        this.highlightGesture(gestureName);
      } else {
        this.badgeEl.textContent = 'HAND DETECTED';
        this.badgeEl.style.background = 'rgba(0, 240, 255, 0.25)';
        this.badgeEl.style.borderColor = '#00f0ff';
        this.badgeEl.style.color = '#ffffff';
      }
    }
  }

  destroy() {
    clearTimeout(this._activeGestureTimer);
    this.root?.remove();
    this.root = null;
    this.videoEl = null;
    this.canvas = null;
    this.ctx = null;
    this.badgeEl = null;
    this.modeEl = null;
  }
}
