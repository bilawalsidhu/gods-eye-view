/**
 * Geofence UI Controls & Breach Banner.
 *
 * Provides dock button, zone manager popup, and real-time top-of-screen
 * tactical breach banners.
 */

export class GeofenceControls {
  /**
   * @param {object} options
   * @param {HTMLElement} [options.container]
   * @param {GeofenceEngine} options.engine
   * @param {GeofenceRenderer} [options.renderer]
   * @param {Cesium.Viewer} options.viewer
   */
  constructor({ container = null, engine, renderer = null, viewer } = {}) {
    this.container = container;
    this.engine = engine;
    this.renderer = renderer;
    this.viewer = viewer;

    this.root = null;
    this.popup = null;
    this.banner = null;
    this._isOpen = false;

    this._init();
  }

  _init() {
    this.engine.onAlert = (alert) => {
      this._showBreachBanner(alert);
      if (this.renderer) {
        this.renderer.flashBreach(alert.zone.id);
      }
    };

    if (typeof document !== 'undefined') {
      this._buildControls();
      this._buildBanner();
      if (this.renderer) {
        this.renderer.render(this.engine.getZones());
      }
    }
  }

  _buildControls() {
    this.root = document.createElement('div');
    this.root.className = 'gev-geofence-widget';
    this.root.innerHTML = `
      <button class="gev-geofence-toggle-btn" title="Tactical Perimeter Geofences" aria-label="Geofences">
        <span>🔲</span>
        <span class="gev-geofence-label">PERIMETER</span>
      </button>
      <div class="gev-geofence-popup" hidden>
        <div class="gev-geofence-header">
          <span>PERIMETER ZONES</span>
          <button class="gev-geofence-add-btn">+ ADD ZONE</button>
        </div>
        <div class="gev-geofence-list"></div>
      </div>
    `;

    const toggleBtn = this.root.querySelector('.gev-geofence-toggle-btn');
    this.popup = this.root.querySelector('.gev-geofence-popup');
    const addBtn = this.root.querySelector('.gev-geofence-add-btn');

    toggleBtn?.addEventListener('click', () => {
      this._isOpen = !this._isOpen;
      this.popup.hidden = !this._isOpen;
      toggleBtn.classList.toggle('active', this._isOpen);
      if (this._isOpen) this._renderZoneList();
    });

    addBtn?.addEventListener('click', () => {
      this._promptAddCurrentCameraZone();
    });

    if (this.container) {
      this.container.appendChild(this.root);
    }
  }

  _buildBanner() {
    this.banner = document.createElement('div');
    this.banner.className = 'gev-breach-banner';
    this.banner.style.display = 'none';
    document.body.appendChild(this.banner);
  }

  _showBreachBanner(alert) {
    if (!this.banner) return;
    const entityName =
      alert.entity?.callsign ||
      alert.entity?.name ||
      alert.entity?.id ||
      'CONTACT';
    const zoneName = alert.zone?.name || 'ZONE';

    this.banner.innerHTML = `
      <div class="gev-breach-alert">
        <span class="gev-breach-icon">⚠️</span>
        <span class="gev-breach-text">
          <strong>PERIMETER BREACH:</strong> ${entityName} entered ${zoneName}
        </span>
        <button class="gev-breach-dismiss">DISMISS</button>
      </div>
    `;
    this.banner.style.display = 'block';

    const dismissBtn = this.banner.querySelector('.gev-breach-dismiss');
    dismissBtn?.addEventListener('click', () => {
      this.banner.style.display = 'none';
    });

    setTimeout(() => {
      if (this.banner) this.banner.style.display = 'none';
    }, 6000);
  }

  _promptAddCurrentCameraZone() {
    // Get current camera target ground position
    let centerLat = 0;
    let centerLon = 0;
    if (this.viewer?.camera) {
      const ray = this.viewer.camera.getPickRay(
        new Cesium.Cartesian2(
          this.viewer.canvas.width / 2,
          this.viewer.canvas.height / 2,
        ),
      );
      const position = this.viewer.scene?.globe?.pick?.(ray, this.viewer.scene);
      if (position) {
        const carto = Cesium.Cartographic.fromCartesian(position);
        centerLat = (carto.latitude * 180) / Math.PI;
        centerLon = (carto.longitude * 180) / Math.PI;
      }
    }

    const zoneId = `zone-${Date.now()}`;
    const name = `Perimeter ${this.engine.getZones().length + 1}`;

    this.engine.addZone({
      id: zoneId,
      name,
      type: 'circle',
      center: { latDeg: centerLat, lonDeg: centerLon },
      radiusM: 50000,
      color: '#ff3366',
      alertLevel: 'critical',
      filter: 'all',
    });

    if (this.renderer) {
      this.renderer.render(this.engine.getZones());
    }
    this._renderZoneList();
  }

  _renderZoneList() {
    if (!this.popup) return;
    const listEl = this.popup.querySelector('.gev-geofence-list');
    if (!listEl) return;

    const zones = this.engine.getZones();
    if (!zones.length) {
      listEl.innerHTML =
        '<div style="font-size:10px;color:#8fa3b5;padding:8px;">No active perimeter zones.</div>';
      return;
    }

    listEl.innerHTML = zones
      .map(
        (z) => `
      <div class="gev-geofence-item" data-id="${z.id}">
        <span class="gev-geofence-item-name">${z.name}</span>
        <span class="gev-geofence-item-radius">${Math.round(z.radiusM / 1000)} km</span>
        <button class="gev-geofence-del-btn" title="Delete Zone">✕</button>
      </div>
    `,
      )
      .join('');

    listEl.querySelectorAll('.gev-geofence-del-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const item = e.target.closest('.gev-geofence-item');
        const id = item?.dataset?.id;
        if (id) {
          this.engine.removeZone(id);
          if (this.renderer) this.renderer.render(this.engine.getZones());
          this._renderZoneList();
        }
      });
    });
  }

  destroy() {
    this.root?.remove();
    this.banner?.remove();
  }
}
