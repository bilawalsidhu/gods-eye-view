/**
 * Radial Context Wheel (Sci-Fi Right-Click Tactical Menu).
 *
 * Appears on right-click over any tracked Cesium entity (flight, vessel,
 * satellite, military asset, earthquake, fire) and provides 8 instant actions.
 */

import { getTacticalAudio } from '../audio/tacticalAudio.js';

export const RADIAL_ACTIONS = Object.freeze([
  { id: 'lock', label: 'LOCK', icon: '🎯', angleDeg: -90 },
  { id: 'chase', label: 'CHASE', icon: '📹', angleDeg: -45 },
  { id: 'cockpit', label: 'COCKPIT', icon: '✈️', angleDeg: 0 },
  { id: 'cctv', label: 'CCTV', icon: '🎥', angleDeg: 45 },
  { id: 'trajectory', label: 'TRAJECTORY', icon: '📐', angleDeg: 90 },
  { id: 'inspect', label: 'INSPECT', icon: '🔍', angleDeg: 135 },
  { id: 'watchlist', label: 'WATCH', icon: '⭐', angleDeg: 180 },
  { id: 'dismiss', label: 'DISMISS', icon: '✖', angleDeg: -135 },
]);

export class RadialMenu {
  /**
   * @param {object} options
   * @param {Cesium.Viewer} options.viewer
   * @param {(action: string, entity: any, context: object) => void} [options.onAction]
   * @param {TacticalAudioEngine} [options.audioEngine]
   */
  constructor({ viewer = null, onAction = null, audioEngine = null } = {}) {
    this.viewer = viewer;
    this.onAction = onAction;
    this.audioEngine = audioEngine || getTacticalAudio();
    this.overlay = null;
    this.menuEl = null;
    this._isOpen = false;
    this._currentEntity = null;
    this._keydownListener = (e) => {
      if (e.key === 'Escape' && this._isOpen) {
        this.close();
      }
    };
  }

  /**
   * Bind right-click interception to the Cesium viewer canvas or container.
   */
  bind(container = this.viewer?.container) {
    if (!container) return;
    container.addEventListener('contextmenu', (event) => {
      // If right click was on a Cesium canvas or viewport
      const canvas = this.viewer?.canvas;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

      // Check if an entity is picked
      let picked = null;
      try {
        if (this.viewer?.scene) {
          picked = this.viewer.scene.pick(new Cesium.Cartesian2(x, y));
        }
      } catch {}

      const entity = picked?.id || picked?.primitive?.id || picked;
      if (entity) {
        event.preventDefault();
        event.stopPropagation();
        this.open({
          clientX: event.clientX,
          clientY: event.clientY,
          entity,
        });
      }
    });

    window.addEventListener('keydown', this._keydownListener);
  }

  /**
   * Open the radial menu at the given client coordinates for a target entity.
   */
  open({ clientX, clientY, entity }) {
    this.close();
    this._currentEntity = entity;
    this._isOpen = true;

    const doc = globalThis.document;
    if (!doc) return;

    this.audioEngine.playClick();

    this.overlay = doc.createElement('div');
    this.overlay.className = 'gev-radial-menu-overlay';

    // Clamp coordinates to prevent clipping
    const radius = 100;
    const padding = 150;
    const x = Math.max(padding, Math.min(window.innerWidth - padding, clientX));
    const y = Math.max(padding, Math.min(window.innerHeight - padding, clientY));

    this.menuEl = doc.createElement('div');
    this.menuEl.className = 'gev-radial-menu';
    this.menuEl.style.left = `${x}px`;
    this.menuEl.style.top = `${y}px`;

    // Center target entity info
    const center = doc.createElement('div');
    center.className = 'gev-radial-center';

    const entityName =
      entity?.name ||
      entity?.id ||
      entity?._id ||
      (typeof entity === 'string' ? entity : 'TARGET');
    const entityType =
      entity?.properties?.type?.getValue?.() ||
      entity?.entityType ||
      'CONTACT';

    center.innerHTML = `
      <div class="gev-radial-center-id" title="${entityName}">${String(entityName).slice(0, 10)}</div>
      <div class="gev-radial-center-type">${String(entityType).slice(0, 10)}</div>
    `;
    this.menuEl.appendChild(center);

    // Render radial action buttons in a ring
    RADIAL_ACTIONS.forEach((action, i) => {
      const rad = (action.angleDeg * Math.PI) / 180;
      const itemX = Math.round(Math.cos(rad) * radius);
      const itemY = Math.round(Math.sin(rad) * radius);

      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'gev-radial-item';
      btn.dataset.action = action.id;
      btn.setAttribute('title', action.label);
      btn.setAttribute('aria-label', action.label);
      btn.style.transform = `translate(${itemX}px, ${itemY}px) scale(0.6)`;
      btn.style.opacity = '0';

      btn.innerHTML = `
        <span class="gev-radial-icon">${action.icon}</span>
        <span class="gev-radial-label">${action.label}</span>
      `;

      btn.addEventListener('mouseenter', () => {
        this.audioEngine.playClick();
      });

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleAction(action.id);
      });

      this.menuEl.appendChild(btn);

      // Staggered fan-out animation
      setTimeout(() => {
        if (this._isOpen && btn) {
          btn.style.transform = `translate(${itemX}px, ${itemY}px) scale(1)`;
          btn.style.opacity = '1';
        }
      }, 25 * i);
    });

    this.overlay.appendChild(this.menuEl);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    doc.body.appendChild(this.overlay);
  }

  _handleAction(actionId) {
    const entity = this._currentEntity;
    this.close();

    if (actionId === 'dismiss') {
      this.audioEngine.playRelease();
      return;
    }

    this.audioEngine.playLock();

    if (typeof this.onAction === 'function') {
      this.onAction(actionId, entity, { viewer: this.viewer });
    }
  }

  close() {
    if (!this._isOpen) return;
    this._isOpen = false;
    this._currentEntity = null;
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
      this.menuEl = null;
    }
  }

  destroy() {
    this.close();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._keydownListener);
    }
  }
}
