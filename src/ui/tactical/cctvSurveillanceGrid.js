/**
 * CCTV Surveillance Grid — Tactical Multi-Camera Picture-in-Picture (PiP) Wall
 *
 * Allows operators to monitor up to 4 live CCTV camera feeds simultaneously
 * in a floating tactical HUD dock with instant 1-click camera intercept.
 */

export class CctvSurveillanceGrid {
  constructor({
    viewer = null,
    getViewer = () => globalThis.__godsEyeView?.viewer,
    documentRef = globalThis.document,
    playCue = () => {},
  } = {}) {
    this._viewer = viewer;
    this._getViewer = getViewer;
    this._doc = documentRef;
    this._playCue = playCue;
    this._feeds = new Map(); // id -> camera object
    this._maxFeeds = 4;
    this._gridElement = null;
    this._minimized = false;
  }

  get viewer() {
    return this._viewer || this._getViewer?.();
  }

  get feeds() {
    return Array.from(this._feeds.values());
  }

  /**
   * Add a CCTV camera feed to the surveillance grid.
   * @param {Object} camera
   * @param {string} camera.id
   * @param {string} camera.name
   * @param {string} [camera.streamUrl]
   * @param {string} [camera.imageUrl]
   * @param {number} [camera.longitude]
   * @param {number} [camera.latitude]
   * @param {string} [camera.agency]
   * @param {string} [camera.city]
   */
  addFeed(camera) {
    if (!camera || !camera.id) return false;

    // Limit to maxFeeds; replace oldest if full
    if (this._feeds.size >= this._maxFeeds && !this._feeds.has(camera.id)) {
      const firstKey = this._feeds.keys().next().value;
      this._feeds.delete(firstKey);
    }

    this._feeds.set(camera.id, {
      id: camera.id,
      name: camera.name || `CCTV #${camera.id}`,
      streamUrl: camera.streamUrl || camera.url || camera.imageUrl || '',
      imageUrl: camera.imageUrl || camera.streamUrl || '',
      longitude: camera.longitude ?? camera.lon ?? null,
      latitude: camera.latitude ?? camera.lat ?? null,
      agency: camera.agency || 'Traffic Recon',
      city: camera.city || '',
      addedAt: new Date().toLocaleTimeString(),
    });

    this._playCue('data');
    this.render();
    return true;
  }

  removeFeed(cameraId) {
    if (!this._feeds.has(cameraId)) return false;
    this._feeds.delete(cameraId);
    if (this._feeds.size === 0) {
      this.close();
    } else {
      this.render();
    }
    return true;
  }

  clearAll() {
    this._feeds.clear();
    this.close();
  }

  render() {
    if (!this._doc || typeof this._doc.createElement !== 'function') return;

    if (!this._gridElement) {
      this._gridElement = this._doc.createElement('div');
      this._gridElement.id = 'cctv-pip-grid';
      this._gridElement.className = 'cctv-pip-grid';
      this._doc.body?.appendChild?.(this._gridElement);
    }

    const count = this._feeds.size;
    if (count === 0) {
      this._gridElement.style.display = 'none';
      return;
    }

    this._gridElement.style.display = 'flex';
    this._gridElement.className = `cctv-pip-grid grid-count-${Math.min(count, 4)} ${this._minimized ? 'minimized' : ''}`;

    const feedCardsHtml = Array.from(this._feeds.values())
      .map((feed) => {
        const hasCoords = feed.longitude !== null && feed.latitude !== null;
        const mediaTag =
          feed.streamUrl && feed.streamUrl.endsWith('.mp4')
            ? `<video src="${feed.streamUrl}" autoplay loop muted playsinline class="cctv-pip-video"></video>`
            : feed.imageUrl
              ? `<img src="${feed.imageUrl}" alt="${feed.name}" class="cctv-pip-img" onerror="this.src='/fallback-cctv.svg'" />`
              : `<div class="cctv-pip-placeholder"><span>LIVE FEED ACTIVE</span></div>`;

        return `
          <div class="cctv-pip-card" data-cctv-id="${feed.id}">
            <div class="cctv-pip-card-header">
              <span class="cctv-pip-badge">● LIVE</span>
              <span class="cctv-pip-name" title="${feed.name}">${feed.name}</span>
              <div class="cctv-pip-actions">
                ${hasCoords ? `<button type="button" class="cctv-pip-fly-btn" data-fly-id="${feed.id}" title="Fly globe to camera location">🎯</button>` : ''}
                <button type="button" class="cctv-pip-close-card" data-close-id="${feed.id}" title="Remove feed">✕</button>
              </div>
            </div>
            <div class="cctv-pip-viewport">
              ${mediaTag}
              <div class="cctv-pip-watermark">${feed.addedAt} · ${feed.agency}</div>
            </div>
          </div>
        `;
      })
      .join('');

    this._gridElement.innerHTML = `
      <div class="cctv-pip-header">
        <div class="cctv-pip-title-wrap">
          <span class="cctv-pip-pulse"></span>
          <span class="cctv-pip-title">SURVEILLANCE GRID (${count}/${this._maxFeeds})</span>
        </div>
        <div class="cctv-pip-header-controls">
          <button type="button" class="cctv-pip-minimize-btn" title="${this._minimized ? 'Expand Grid' : 'Minimize Grid'}">
            ${this._minimized ? '▢' : '—'}
          </button>
          <button type="button" class="cctv-pip-close-all-btn" title="Close All Feeds">✕</button>
        </div>
      </div>
      <div class="cctv-pip-body" ${this._minimized ? 'hidden' : ''}>
        ${feedCardsHtml}
      </div>
    `;

    // Bind event delegation
    this._gridElement
      .querySelector('.cctv-pip-minimize-btn')
      ?.addEventListener('click', () => {
        this._minimized = !this._minimized;
        this.render();
      });

    this._gridElement
      .querySelector('.cctv-pip-close-all-btn')
      ?.addEventListener('click', () => {
        this.clearAll();
      });

    this._gridElement
      .querySelectorAll('.cctv-pip-close-card')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeFeed(btn.dataset.closeId);
        });
      });

    this._gridElement.querySelectorAll('.cctv-pip-fly-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const feed = this._feeds.get(btn.dataset.flyId);
        if (feed && feed.longitude !== null && feed.latitude !== null) {
          this.flyToFeed(feed);
        }
      });
    });
  }

  flyToFeed(feed) {
    const viewer = this.viewer;
    const Cesium = globalThis.Cesium || globalThis.window?.Cesium;
    if (!viewer || !Cesium || !feed) return;
    viewer.camera?.flyTo?.({
      destination: Cesium.Cartesian3.fromDegrees(
        feed.longitude,
        feed.latitude,
        600,
      ),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-35),
        roll: 0,
      },
      duration: 1.8,
    });
  }

  close() {
    if (this._gridElement) {
      this._gridElement.style.display = 'none';
      this._gridElement.remove();
      this._gridElement = null;
    }
  }
}
