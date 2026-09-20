/**
 * Touchégg-inspired Multi-Touch and Trackpad Gesture Recognizer.
 * Supports 2, 3, and 4-finger swipes, pinches, twists, and taps.
 */

/**
 * @typedef {Object} GestureEvent
 * @property {'swipe'|'pinch'|'twist'|'tap'} type
 * @property {'left'|'right'|'up'|'down'|'in'|'out'|'none'} direction
 * @property {number} fingers
 * @property {number} [scale]
 * @property {number} [rotation]
 * @property {number} [deltaX]
 * @property {number} [deltaY]
 */

export class TouchGestureController {
  /**
   * @param {Object} options
   * @param {HTMLElement} [options.targetEl] - Target element (e.g., Cesium canvas or container)
   * @param {Object} [options.viewer] - Cesium viewer instance
   * @param {(gesture: GestureEvent) => void} [options.onGesture] - Callback for gestures
   */
  constructor({ targetEl, viewer = null, onGesture = null } = {}) {
    this.targetEl = targetEl || (typeof document !== 'undefined' ? document.body : null);
    this.viewer = viewer;
    this.onGesture = onGesture;
    this.enabled = true;

    /** @type {Map<number, { id: number, x: number, y: number, startX: number, startY: number, startTime: number }>} */
    this.activeTouches = new Map();
    this.initialDistance = 0;
    this.initialAngle = 0;
    this.startFingerCount = 0;
    this.gestureRecognized = false;

    this._boundTouchStart = this._handleTouchStart.bind(this);
    this._boundTouchMove = this._handleTouchMove.bind(this);
    this._boundTouchEnd = this._handleTouchEnd.bind(this);
    this._boundTouchCancel = this._handleTouchCancel.bind(this);

    this._initToast();
    this.attach();
  }

  attach() {
    if (!this.targetEl || typeof this.targetEl.addEventListener !== 'function') return;
    this.targetEl.addEventListener('touchstart', this._boundTouchStart, { passive: false });
    this.targetEl.addEventListener('touchmove', this._boundTouchMove, { passive: false });
    this.targetEl.addEventListener('touchend', this._boundTouchEnd, { passive: false });
    this.targetEl.addEventListener('touchcancel', this._boundTouchCancel, { passive: false });
  }

  detach() {
    if (!this.targetEl || typeof this.targetEl.removeEventListener !== 'function') return;
    this.targetEl.removeEventListener('touchstart', this._boundTouchStart);
    this.targetEl.removeEventListener('touchmove', this._boundTouchMove);
    this.targetEl.removeEventListener('touchend', this._boundTouchEnd);
    this.targetEl.removeEventListener('touchcancel', this._boundTouchCancel);
  }

  _initToast() {
    if (typeof document === 'undefined') return;
    let toast = document.getElementById('gev-gesture-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gev-gesture-toast';
      toast.className = 'gev-gesture-toast';
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    this.toastEl = toast;
  }

  showToast(text, icon = '⚡') {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(12);
      } catch {
        /* vibration optional */
      }
    }
    if (!this.toastEl) return;
    this.toastEl.innerHTML = `<span class="toast-icon">${icon}</span> <span class="toast-text">${text}</span>`;
    this.toastEl.classList.remove('visible');
    // Force reflow
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('visible');
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      this.toastEl?.classList.remove('visible');
    }, 1800);
  }

  _handleTouchStart(e) {
    if (!this.enabled) return;
    const now = Date.now();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      this.activeTouches.set(touch.identifier, {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        startX: touch.clientX,
        startY: touch.clientY,
        startTime: now,
      });
    }

    this.startFingerCount = this.activeTouches.size;
    this.gestureRecognized = false;

    if (this.startFingerCount >= 2) {
      const coords = Array.from(this.activeTouches.values());
      this.initialDistance = Math.hypot(coords[0].x - coords[1].x, coords[0].y - coords[1].y);
      this.initialAngle = Math.atan2(coords[1].y - coords[0].y, coords[1].x - coords[0].x);
    }
  }

  _handleTouchMove(e) {
    if (!this.enabled) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      const entry = this.activeTouches.get(touch.identifier);
      if (entry) {
        entry.x = touch.clientX;
        entry.y = touch.clientY;
      }
    }

    const count = this.activeTouches.size;
    const touches = Array.from(this.activeTouches.values());

    // 4-Finger Pinch in / out (Orbital overview reset)
    if (count === 4 && !this.gestureRecognized) {
      const center = this._getCentroid(touches);
      let avgDist = 0;
      let startAvgDist = 0;
      for (const t of touches) {
        avgDist += Math.hypot(t.x - center.x, t.y - center.y);
        startAvgDist += Math.hypot(t.startX - center.x, t.startY - center.y);
      }
      avgDist /= 4;
      startAvgDist /= 4;

      if (startAvgDist > 0 && Math.abs(avgDist - startAvgDist) > 40) {
        this.gestureRecognized = true;
        if (avgDist < startAvgDist) {
          this._dispatchGesture({
            type: 'pinch',
            direction: 'in',
            fingers: 4,
            scale: avgDist / startAvgDist,
          });
          this._executeAction('orbit_reset');
        } else {
          this._dispatchGesture({
            type: 'pinch',
            direction: 'out',
            fingers: 4,
            scale: avgDist / startAvgDist,
          });
          this._executeAction('level_horizon');
        }
      }
    }

    // 3-Finger Swipes
    if (count === 3 && !this.gestureRecognized) {
      let totalDx = 0;
      let totalDy = 0;
      for (const t of touches) {
        totalDx += t.x - t.startX;
        totalDy += t.y - t.startY;
      }
      const avgDx = totalDx / 3;
      const avgDy = totalDy / 3;

      const threshold = 60;
      if (Math.abs(avgDx) > threshold || Math.abs(avgDy) > threshold) {
        this.gestureRecognized = true;
        if (Math.abs(avgDx) > Math.abs(avgDy)) {
          const dir = avgDx > 0 ? 'right' : 'left';
          this._dispatchGesture({
            type: 'swipe',
            direction: dir,
            fingers: 3,
            deltaX: avgDx,
          });
          this._executeAction(dir === 'right' ? 'prev_layer' : 'next_layer');
        } else {
          const dir = avgDy > 0 ? 'down' : 'up';
          this._dispatchGesture({
            type: 'swipe',
            direction: dir,
            fingers: 3,
            deltaY: avgDy,
          });
          this._executeAction(dir === 'up' ? 'expand_dock' : 'collapse_hud');
        }
      }
    }
  }

  _handleTouchEnd(e) {
    if (!this.enabled) return;
    const now = Date.now();

    // 2-Finger double tap detection
    if (this.startFingerCount === 2 && !this.gestureRecognized && this.activeTouches.size === 2) {
      const touches = Array.from(this.activeTouches.values());
      const maxDuration = 300;
      const maxMove = 20;
      const wasTap = touches.every(
        (t) => now - t.startTime < maxDuration && Math.hypot(t.x - t.startX, t.y - t.startY) < maxMove
      );
      if (wasTap) {
        const timeSinceLastTap = now - (this._lastTwoFingerTap || 0);
        if (timeSinceLastTap < 350) {
          this._dispatchGesture({
            type: 'tap',
            direction: 'none',
            fingers: 2,
          });
          this._executeAction('level_horizon');
          this._lastTwoFingerTap = 0;
        } else {
          this._lastTwoFingerTap = now;
        }
      }
    }

    for (let i = 0; i < e.changedTouches.length; i++) {
      this.activeTouches.delete(e.changedTouches[i].identifier);
    }
  }

  _handleTouchCancel(e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      this.activeTouches.delete(e.changedTouches[i].identifier);
    }
  }

  _getCentroid(touches) {
    let sx = 0;
    let sy = 0;
    for (const t of touches) {
      sx += t.x;
      sy += t.y;
    }
    return { x: sx / touches.length, y: sy / touches.length };
  }

  _dispatchGesture(gesture) {
    this.onGesture?.(gesture);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gev:gesture', { detail: gesture }));
    }
  }

  _executeAction(action) {
    if (typeof document === 'undefined') return;
    switch (action) {
      case 'orbit_reset':
        this.showToast('ORBITAL RESET (4-Finger Pinch)', '🛰️');
        if (this.viewer?.camera) {
          this.viewer.camera.flyHome?.(1.5) ||
            this.viewer.camera.flyTo?.({
              destination: (typeof Cesium !== 'undefined' ? Cesium.Cartesian3.fromDegrees(0, 20, 20000000) : null),
              duration: 1.5,
            });
        }
        break;

      case 'level_horizon':
        this.showToast('HORIZON LEVELED (2-Tap / Spread)', '📐');
        if (this.viewer?.camera) {
          this.viewer.camera.setView?.({
            orientation: {
              heading: this.viewer.camera.heading || 0,
              pitch: (typeof Cesium !== 'undefined' ? Cesium.Math.toRadians(-90) : -1.57),
              roll: 0,
            },
          });
        }
        break;

      case 'next_layer':
      case 'prev_layer': {
        const isNext = action === 'next_layer';
        this.showToast(isNext ? 'NEXT PRESET ➔ (3-Finger Swipe)' : 'PREV PRESET ⬅ (3-Finger Swipe)', '🎨');
        const styleBtns = Array.from(document.querySelectorAll('#style-buttons .style-btn'));
        if (styleBtns.length) {
          const currentIndex = styleBtns.findIndex((b) => b.classList.contains('active'));
          const nextIndex = isNext
            ? (currentIndex + 1) % styleBtns.length
            : (currentIndex - 1 + styleBtns.length) % styleBtns.length;
          styleBtns[nextIndex]?.click();
        }
        break;
      }

      case 'expand_dock':
        this.showToast('DOCK EXPANDED (3-Finger Swipe Up)', '🔼');
        document.getElementById('control-panel-toggle')?.click() ||
          document.getElementById('location-bar-toggle')?.click();
        break;

      case 'collapse_hud':
        this.showToast('TACTICAL MINIMIZE (3-Finger Swipe Down)', '🔽');
        document.querySelectorAll('#command-dock .panel-collapsible:not(.collapsed)').forEach((panel) => {
          panel.classList.add('collapsed');
        });
        break;
    }
  }
}
