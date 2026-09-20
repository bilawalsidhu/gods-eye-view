/**
 * Drone Recon Controller — Autonomous Tactical Flyover & Orbital SITREP
 *
 * Provides:
 * - Low-altitude orbital sweep around any landmark, city, or coordinates
 * - Live HUD reconnaissance reticle overlay with compass heading & altitude
 * - Automated JARVIS tactical SITREP commentary via TTS
 */

export class DroneReconController {
  constructor({
    viewer = null,
    getViewer = () => globalThis.__godsEyeView?.viewer,
    aiController = null,
    playCue = () => {},
  } = {}) {
    this._viewer = viewer;
    this._getViewer = getViewer;
    this._aiController = aiController;
    this._playCue = playCue;
    this._active = false;
    this._reconTarget = null;
    this._orbitListener = null;
    this._currentHeading = 0;
    this._orbitSpeed = 0.005; // radians per frame
    this._hudElement = null;
  }

  get viewer() {
    return this._viewer || this._getViewer?.();
  }

  isActive() {
    return this._active;
  }

  /**
   * Start an autonomous reconnaissance sweep over a target location or coordinates.
   * @param {Object} options
   * @param {string} options.targetName - Landmark or city name
   * @param {number} [options.longitude]
   * @param {number} [options.latitude]
   * @param {number} [options.altitude=850]
   * @param {boolean} [options.narrate=true]
   */
  async startRecon({
    targetName = 'Target Objective',
    longitude = null,
    latitude = null,
    altitude = 850,
    narrate = true,
  } = {}) {
    this.stop();

    const viewer = this.viewer;
    if (!viewer) return { ok: false, error: 'Cesium viewer not available' };

    this._active = true;
    this._reconTarget = { targetName, longitude, latitude, altitude };
    this._playCue('recon');

    // Create or show HUD Telemetry Reticle
    this._createHudOverlay(targetName, altitude);

    // If explicit coordinates are not provided, query geocoder/search or fallback
    let lon = longitude;
    let lat = latitude;

    if (lon === null || lat === null) {
      // Geocode common tactical targets or use current camera center
      const defaults = {
        tokyo: { lon: 139.7454, lat: 35.6586 },
        'tokyo tower': { lon: 139.7454, lat: 35.6586 },
        paris: { lon: 2.2945, lat: 48.8584 },
        'eiffel tower': { lon: 2.2945, lat: 48.8584 },
        london: { lon: -0.1276, lat: 51.5074 },
        'new york': { lon: -73.9855, lat: 40.7484 },
        dubai: { lon: 55.2744, lat: 25.1972 },
        'burj khalifa': { lon: 55.2744, lat: 25.1972 },
        singapore: { lon: 103.8519, lat: 1.2902 },
        taiwan: { lon: 121.5654, lat: 25.033 },
        suez: { lon: 32.5599, lat: 29.9668 },
        hormuz: { lon: 56.456, lat: 26.5667 },
      };
      const key = (targetName || '').toLowerCase().trim();
      const matched = Object.keys(defaults).find((k) => key.includes(k));
      if (matched) {
        lon = defaults[matched].lon;
        lat = defaults[matched].lat;
      } else {
        // Fallback to camera center position
        const Cesium = globalThis.Cesium || globalThis.window?.Cesium;
        const cameraPos = viewer.camera?.positionCartographic;
        if (cameraPos && Cesium) {
          lon = Cesium.Math.toDegrees(cameraPos.longitude);
          lat = Cesium.Math.toDegrees(cameraPos.latitude);
        } else {
          lon = 139.7454;
          lat = 35.6586; // Tokyo default
        }
      }
    }

    this._reconTarget.longitude = lon;
    this._reconTarget.latitude = lat;

    const Cesium = globalThis.Cesium || globalThis.window?.Cesium;
    if (Cesium && viewer.camera) {
      const center = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
      const pitch = Cesium.Math.toRadians(-28.0);
      const range = altitude * 1.6;

      viewer.camera.flyTo?.({
        destination: Cesium.Cartesian3.fromDegrees(
          lon,
          lat - 0.008,
          altitude * 1.5,
        ),
        orientation: {
          heading: this._currentHeading,
          pitch,
          roll: 0.0,
        },
        duration: 2.4,
        complete: () => {
          if (!this._active) return;
          // Engage continuous 360° orbit
          this._orbitListener = () => {
            if (!this._active) return;
            this._currentHeading += this._orbitSpeed;
            if (this._currentHeading > Math.PI * 2)
              this._currentHeading -= Math.PI * 2;

            viewer.camera.lookAt?.(
              center,
              new Cesium.HeadingPitchRange(
                this._currentHeading,
                Cesium.Math.toRadians(-30.0),
                range,
              ),
            );

            this._updateHudTelemetry();
          };
          viewer.scene?.preUpdate?.addEventListener?.(this._orbitListener);
        },
      });
    }

    // Trigger AI Tactical SITREP commentary
    if (narrate && this._aiController) {
      const sitrepMsg = `🛰️ **RECON SQUADRON DISPATCHED**: Low-altitude autonomous orbit initiated over **${targetName}** (Coords: ${lat.toFixed(4)}°, ${lon.toFixed(4)}° · Alt: ${altitude}m). Sensor array scanning active airspace and surface telemetry.`;
      this._aiController.appendMessage?.('assistant', sitrepMsg);
      this._aiController.speak?.(
        `Reconnaissance orbit engaged over ${targetName}. Sensors online and scanning target telemetry.`,
      );
    }

    return { ok: true, target: targetName, longitude: lon, latitude: lat };
  }

  stop() {
    if (!this._active) return;
    this._active = false;

    const viewer = this.viewer;
    if (viewer && this._orbitListener) {
      viewer.scene?.preUpdate?.removeEventListener?.(this._orbitListener);
      this._orbitListener = null;
      try {
        viewer.camera?.lookAtTransform?.(
          window.Cesium?.Matrix4?.IDENTITY || [
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
          ],
        );
      } catch {}
    }

    if (this._hudElement) {
      this._hudElement.remove();
      this._hudElement = null;
    }

    if (this._aiController) {
      this._aiController.appendMessage?.(
        'assistant',
        '🛰️ **RECON SQUADRON STANDDOWN**: Orbit disengaged. Standard camera control restored.',
      );
    }
  }

  _createHudOverlay(targetName, altitude) {
    if (typeof document === 'undefined') return;
    if (this._hudElement) this._hudElement.remove();

    const hud = document.createElement('div');
    hud.id = 'gev-recon-hud';
    hud.className = 'gev-recon-hud';
    hud.innerHTML = `
      <div class="recon-reticle-box">
        <div class="recon-reticle-ring"></div>
        <div class="recon-reticle-crosshair"></div>
      </div>
      <div class="recon-telemetry-card">
        <div class="recon-status-badge">● RECON FLIGHT ACTIVE</div>
        <div class="recon-target-name">${targetName}</div>
        <div class="recon-telemetry-row">
          <span>ALT: <strong id="recon-alt-val">${altitude}m</strong></span>
          <span>HDG: <strong id="recon-hdg-val">000°</strong></span>
        </div>
        <button type="button" class="recon-abort-btn" id="recon-abort-btn">✕ Disengage Recon</button>
      </div>
    `;

    document.body.appendChild(hud);
    hud
      .querySelector('#recon-abort-btn')
      ?.addEventListener('click', () => this.stop());
    this._hudElement = hud;
  }

  _updateHudTelemetry() {
    if (!this._hudElement) return;
    const hdgEl = this._hudElement.querySelector('#recon-hdg-val');
    if (hdgEl) {
      const degrees = Math.round((this._currentHeading * 180) / Math.PI) % 360;
      hdgEl.textContent = `${String(degrees).padStart(3, '0')}°`;
    }
  }
}
