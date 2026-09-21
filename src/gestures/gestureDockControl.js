import { VisionGestureController } from './visionGestures.js';

/**
 * Creates and mounts the Gesture Dock Control and Cybernetic Vision PiP HUD.
 * @param {Object} options
 * @param {Object} options.viewer - Cesium viewer instance
 * @param {HTMLElement} [options.container] - Container to append dock button to (defaults to #command-dock)
 * @returns {{ controller: VisionGestureController, toggleBtn: HTMLElement, pipEl: HTMLElement, destroy: Function }}
 */
export function createGestureDockControl({
  viewer = null,
  container = null,
} = {}) {
  if (typeof document === 'undefined') {
    return {
      controller: new VisionGestureController({ viewer }),
      toggleBtn: null,
      pipEl: null,
      destroy: () => {},
    };
  }

  // 1. Build Cybernetic PiP HUD
  let pipEl = document.getElementById('gev-gesture-vision-hud');
  if (!pipEl) {
    pipEl = document.createElement('div');
    pipEl.id = 'gev-gesture-vision-hud';
    pipEl.className = 'hidden';
    pipEl.innerHTML = `
      <div class="pip-header">
        <div class="pip-title-wrap">
          <span class="pip-radar-dot"></span>
          <span class="pip-title">AI NEURAL MOTION</span>
        </div>
        <div class="pip-controls">
          <button class="pip-btn pip-min-btn" type="button" title="Minimize PiP">_</button>
          <button class="pip-btn pip-close-btn" type="button" title="Close Gesture Camera">✕</button>
        </div>
      </div>
      <div class="pip-viewport">
        <video class="pip-video" playsinline muted></video>
        <canvas class="pip-canvas" width="240" height="180"></canvas>
      </div>
      <div class="pip-footer">
        <span class="pip-gesture-badge">👁️ STANDBY</span>
        <span class="pip-fps-value">-- FPS</span>
      </div>
    `;
    document.body.appendChild(pipEl);
  }

  const videoEl = pipEl.querySelector('.pip-video');
  const canvasEl = pipEl.querySelector('.pip-canvas');
  const minBtn = pipEl.querySelector('.pip-min-btn');
  const closeBtn = pipEl.querySelector('.pip-close-btn');

  // Dragging support for PiP
  const header = pipEl.querySelector('.pip-header');
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  header?.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pip-btn')) return;
    isDragging = true;
    dragOffset.x = e.clientX - pipEl.offsetLeft;
    dragOffset.y = e.clientY - pipEl.offsetTop;
    header.setPointerCapture?.(e.pointerId);
  });

  header?.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    pipEl.style.left = `${Math.max(10, Math.min(window.innerWidth - pipEl.offsetWidth - 10, e.clientX - dragOffset.x))}px`;
    pipEl.style.top = `${Math.max(10, Math.min(window.innerHeight - pipEl.offsetHeight - 10, e.clientY - dragOffset.y))}px`;
    pipEl.style.right = 'auto';
    pipEl.style.bottom = 'auto';
  });

  const stopDrag = (e) => {
    isDragging = false;
    header.releasePointerCapture?.(e.pointerId);
  };
  header?.addEventListener('pointerup', stopDrag);
  header?.addEventListener('pointercancel', stopDrag);

  // Minimize toggle
  minBtn?.addEventListener('click', () => {
    pipEl.classList.toggle('minimized');
    minBtn.textContent = pipEl.classList.contains('minimized') ? '□' : '_';
  });

  // 2. Vision Gesture Controller
  const controller = new VisionGestureController({ viewer });

  // 3. Build Dock Button
  let toggleBtn = document.getElementById('gev-gesture-toggle');
  if (!toggleBtn) {
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'gev-gesture-toggle';
    toggleBtn.type = 'button';
    toggleBtn.title = 'Toggle AI Neural Hand & Face Gesture Control';
    toggleBtn.setAttribute('aria-pressed', 'false');
    toggleBtn.innerHTML = `<span class="gesture-icon">🖐️</span> <span class="gesture-label">GESTURE</span>`;

    const targetContainer =
      container || document.getElementById('command-dock') || document.body;

    if (targetContainer) {
      const locationBar = document.getElementById('location-bar');
      if (locationBar && targetContainer.contains(locationBar)) {
        targetContainer.insertBefore(toggleBtn, locationBar);
      } else {
        targetContainer.appendChild(toggleBtn);
      }
    }
  }

  const toggleHandler = async () => {
    if (controller.active) {
      controller.stop();
      toggleBtn.classList.remove('active', 'loading', 'error');
      toggleBtn.setAttribute('aria-pressed', 'false');
      toggleBtn.innerHTML = `<span class="gesture-icon">🖐️</span> <span class="gesture-label">GESTURE</span>`;
    } else {
      try {
        toggleBtn.classList.remove('error');
        toggleBtn.classList.add('loading');
        toggleBtn.innerHTML = `<span class="gesture-icon">⏳</span> <span class="gesture-label">LOADING AI...</span>`;
        await controller.start({ videoEl, canvasEl, pipContainer: pipEl });
        toggleBtn.classList.remove('loading');
        toggleBtn.classList.add('active');
        toggleBtn.setAttribute('aria-pressed', 'true');
        toggleBtn.innerHTML = `<span class="gesture-icon">🖐️</span> <span class="gesture-label">GESTURE ON</span>`;
      } catch (err) {
        console.warn('[GestureDock] Activation failed:', err);
        toggleBtn.classList.remove('loading', 'active');
        toggleBtn.classList.add('error');
        toggleBtn.setAttribute('aria-pressed', 'false');
        toggleBtn.innerHTML = `<span class="gesture-icon">⚠️</span> <span class="gesture-label">RETRY GESTURE</span>`;
      }
    }
  };

  toggleBtn.addEventListener('click', toggleHandler);

  closeBtn?.addEventListener('click', () => {
    if (controller.active) {
      controller.stop();
      toggleBtn.classList.remove('active', 'loading', 'error');
      toggleBtn.setAttribute('aria-pressed', 'false');
      toggleBtn.innerHTML = `<span class="gesture-icon">🖐️</span> <span class="gesture-label">GESTURE</span>`;
    }
  });

  return {
    controller,
    toggleBtn,
    pipEl,
    destroy() {
      controller.stop();
      toggleBtn?.removeEventListener('click', toggleHandler);
      toggleBtn?.remove();
      pipEl?.remove();
    },
  };
}
