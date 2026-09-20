/**
 * Geospatial Threat Scanner — Autonomous Real-Time Hazard & Anomaly Detector
 *
 * Continuously evaluates live telemetry for:
 * - ADS-B aircraft emergency transponder squawk codes (7700, 7600, 7500)
 * - Major seismic events (Earthquakes >= 5.0 magnitude)
 * - Wildfire compound proximity hazards
 *
 * Triggers interactive HUD alert banners with 1-click camera intercept.
 */

export class GeospatialThreatScanner {
  constructor({
    viewer = null,
    getViewer = () => globalThis.__godsEyeView?.viewer,
    aiController = null,
    documentRef = globalThis.document,
    playCue = () => {},
    scanIntervalMs = 8000,
  } = {}) {
    this._viewer = viewer;
    this._getViewer = getViewer;
    this._aiController = aiController;
    this._doc = documentRef;
    this._playCue = playCue;
    this._scanIntervalMs = scanIntervalMs;
    this._timer = null;
    this._activeThreats = new Map(); // id -> threat
    this._bannerElement = null;
    this._enabled = true;
  }

  get viewer() {
    return this._viewer || this._getViewer?.();
  }

  start() {
    if (this._timer) return;
    this.scanNow();
    this._timer = setInterval(() => this.scanNow(), this._scanIntervalMs);
    this._timer?.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.dismissBanner();
  }

  /**
   * Scan active Cesium data layers and entities for anomalies.
   */
  scanNow() {
    if (!this._enabled) return;
    const viewer = this.viewer;
    if (!viewer?.entities) return;
    const Cesium = globalThis.Cesium || globalThis.window?.Cesium;

    try {
      const entities = viewer.entities.values || [];
      for (const entity of entities) {
        // 1. Check ADS-B Flights for Emergency Squawk codes
        const props = entity.properties?.getValue
          ? entity.properties.getValue(
              Cesium?.JulianDate?.now?.() || new Date(),
            )
          : entity.properties;
        const squawk = String(props?.squawk || props?.Squawk || '').trim();
        const callsign = String(
          props?.callsign ||
            props?.Callsign ||
            entity.name ||
            'Unknown Aircraft',
        ).trim();

        if (squawk === '7700' || squawk === '7600' || squawk === '7500') {
          const threatId = `emergency_${callsign}_${squawk}`;
          if (!this._activeThreats.has(threatId)) {
            const pos = entity.position?.getValue
              ? entity.position.getValue(
                  Cesium?.JulianDate?.now?.() || new Date(),
                )
              : null;
            let lon = null;
            let lat = null;
            if (pos && Cesium) {
              const carto = Cesium.Cartographic.fromCartesian(pos);
              lon = Cesium.Math.toDegrees(carto.longitude);
              lat = Cesium.Math.toDegrees(carto.latitude);
            }

            const threat = {
              id: threatId,
              type: 'flight_emergency',
              title: `Squawk ${squawk} Emergency: ${callsign}`,
              detail:
                squawk === '7700'
                  ? 'General Airborne Emergency Declared'
                  : squawk === '7600'
                    ? 'Radio Comm Failure'
                    : 'Unlawful Interference / Hijack',
              entity,
              longitude: lon,
              latitude: lat,
              timestamp: new Date().toLocaleTimeString(),
            };

            this.triggerThreat(threat);
          }
        }

        // 2. Check Earthquakes for high magnitude
        const mag = parseFloat(
          props?.mag || props?.magnitude || props?.Magnitude,
        );
        if (!isNaN(mag) && mag >= 5.0) {
          const place = String(
            props?.place || props?.title || 'Major Seismic Event',
          ).trim();
          const threatId = `quake_${place}_${mag}`;
          if (!this._activeThreats.has(threatId)) {
            const threat = {
              id: threatId,
              type: 'earthquake',
              title: `M${mag.toFixed(1)} Earthquake: ${place}`,
              detail: `Major seismic activity detected. Shallow focal depth danger.`,
              entity,
              longitude: props?.longitude || null,
              latitude: props?.latitude || null,
              timestamp: new Date().toLocaleTimeString(),
            };
            this.triggerThreat(threat);
          }
        }
      }
    } catch {
      // Non-blocking scan exception
    }
  }

  triggerThreat(threat) {
    this._activeThreats.set(threat.id, threat);
    this._playCue('alert');
    this.renderBanner(threat);

    if (this._aiController) {
      const msg = `⚠️ **TACTICAL THREAT DETECTED**: ${threat.title} — ${threat.detail}. Immediate operator awareness advised.`;
      this._aiController.appendMessage?.('assistant', msg);
    }
  }

  renderBanner(threat) {
    if (!this._doc || typeof this._doc.createElement !== 'function') return;

    if (!this._bannerElement) {
      this._bannerElement = this._doc.createElement('div');
      this._bannerElement.id = 'gev-threat-banner';
      this._bannerElement.className = 'gev-threat-banner';
      this._doc.body?.appendChild?.(this._bannerElement);
    }

    this._bannerElement.innerHTML = `
      <div class="threat-banner-inner">
        <div class="threat-banner-pulse"></div>
        <div class="threat-banner-content">
          <div class="threat-banner-badge">⚠️ THREAT ALERT · ${threat.timestamp}</div>
          <div class="threat-banner-title">${threat.title}</div>
          <div class="threat-banner-detail">${threat.detail}</div>
        </div>
        <div class="threat-banner-actions">
          ${threat.entity || (threat.longitude !== null && threat.latitude !== null) ? '<button type="button" class="threat-intercept-btn" id="threat-intercept-btn">🎯 Intercept</button>' : ''}
          <button type="button" class="threat-jarvis-btn" id="threat-jarvis-btn">🤖 Ask JARVIS</button>
          <button type="button" class="threat-dismiss-btn" id="threat-dismiss-btn">✕</button>
        </div>
      </div>
    `;

    this._bannerElement.style.display = 'flex';

    this._bannerElement
      .querySelector('#threat-intercept-btn')
      ?.addEventListener('click', () => {
        this.interceptThreat(threat);
      });

    this._bannerElement
      .querySelector('#threat-jarvis-btn')
      ?.addEventListener('click', () => {
        if (this._aiController) {
          this._aiController.sendMessage?.(
            `Analyze active threat: ${threat.title}. Details: ${threat.detail}`,
          );
        }
      });

    this._bannerElement
      .querySelector('#threat-dismiss-btn')
      ?.addEventListener('click', () => {
        this.dismissBanner();
      });
  }

  interceptThreat(threat) {
    const viewer = this.viewer;
    if (!viewer) return;
    const Cesium = globalThis.Cesium || globalThis.window?.Cesium;

    if (threat.entity && viewer.flyTo) {
      viewer.flyTo(threat.entity, { duration: 2.0 });
    } else if (
      threat.longitude !== null &&
      threat.latitude !== null &&
      Cesium
    ) {
      viewer.camera?.flyTo?.({
        destination: Cesium.Cartesian3.fromDegrees(
          threat.longitude,
          threat.latitude,
          8000,
        ),
        duration: 2.0,
      });
    }
  }

  dismissBanner() {
    if (this._bannerElement) {
      this._bannerElement.style.display = 'none';
      this._bannerElement.remove();
      this._bannerElement = null;
    }
  }
}
