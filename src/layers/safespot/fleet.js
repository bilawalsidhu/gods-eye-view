import * as Cesium from 'cesium';

/**
 * @module layers/safespot/fleet
 * @description 3D Autonomous Test Fleet (CAR-xxxx & BUS-xxxx) & Full-Singapore Road
 * Network Coverage Renderer for SafeSpotSG Evaluation Lab.
 *
 * Features:
 * - Real-time 60fps interpolation of 50 autonomous test Cars and Buses along directed
 *   road carriageways (strictly obeying one-way vs two-way carriageways and turn restrictions).
 * - Left-hand traffic lane offset on two-way roads so opposing vehicles travel in separate lanes.
 * - High-DPI SVG tactical callout badges ("CAR-0001 · 54km/h · 1W", "BUS-0002 · 42km/h · 2W")
 *   with zero Cesium labels (strict `noCesiumLabels` compliance).
 * - Full integration with God's Eye View's `getDetectableObjects()` screen-space detection
 *   bracket overlay so `CAR-xxxx` and `BUS-xxxx` appear in the HUD detection system.
 * - 3D draped road coverage tracks highlighting covered one-way carriageways vs two-way carriageways.
 */

export const FLEET_COLORS = Object.freeze({
  CAR_MARKER: '#10b981', // Emerald Green for Autonomous Test Cars
  BUS_MARKER: '#f59e0b', // Amber Gold for Autonomous Test Buses
  TRACK_ONEWAY: '#06b6d4', // Cyan for Covered One-Way Carriageways
  TRACK_TWOWAY: '#10b981', // Emerald for Covered Two-Way Carriageways
  TRACK_BUS: '#f59e0b', // Amber for Covered Bus Corridors
});

function svgToDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}

/**
 * Create a high-DPI crisp SVG vehicle marker + callout tag (noCesiumLabels compliant).
 */
function buildVehicleBadgeSvg(id, vehicleType, speedKmh, oneway) {
  const isBus = vehicleType === 'BUS';
  const accent = isBus ? '#f59e0b' : '#10b981';
  const bg = isBus ? 'rgba(28, 18, 6, 0.92)' : 'rgba(6, 22, 18, 0.92)';
  const cwTag = oneway ? '1W' : '2W';
  const labelText = `${id} · ${Math.round(speedKmh)}km/h · ${cwTag}`;

  return svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="168" height="54" viewBox="0 0 168 54">
      <!-- Tactical Callout Box -->
      <rect x="4" y="2" width="160" height="24" rx="4" fill="${bg}" stroke="${accent}" stroke-width="1.5"/>
      <rect x="4" y="2" width="6" height="24" rx="2" fill="${accent}"/>
      <text x="16" y="18" fill="#f8fafc" font-family="JetBrains Mono, Consolas, monospace" font-size="11.5" font-weight="700" letter-spacing="0.3">${labelText}</text>
      <!-- Leader Stalk -->
      <line x1="84" y1="26" x2="84" y2="36" stroke="${accent}" stroke-width="1.5"/>
      <!-- Vehicle Chassis Icon on Road Track -->
      <circle cx="84" cy="42" r="8.5" fill="${accent}" stroke="#ffffff" stroke-width="2"/>
      <circle cx="84" cy="42" r="3.5" fill="#0f172a"/>
    </svg>
  `);
}

const rad = (d) => (d * Math.PI) / 180;

/**
 * Offset a coordinate by `offsetMeters` perpendicular to `bearingDeg`.
 * In Singapore (left-hand traffic), two-way roads offset 2.2m to the LEFT (bearing - 90°).
 */
export function applyCarriagewayOffset(lat, lng, bearingDeg, oneway) {
  if (oneway) return { lat, lng };
  const leftBearingRad = rad((bearingDeg - 90 + 360) % 360);
  const offsetMeters = 2.2;
  const dLat = (offsetMeters * Math.cos(leftBearingRad)) / 110574.0;
  const dLng = (offsetMeters * Math.sin(leftBearingRad)) / (111319.5 * Math.cos(rad(lat)));
  return {
    lat: lat + dLat,
    lng: lng + dLng,
  };
}

export class SafeSpotFleetSimulator {
  constructor(viewer) {
    this._viewer = viewer;
    this._dataSource = new Cesium.CustomDataSource('safespot-autonomous-fleet');
    this._attached = false;
    this._running = true;
    this._speedMultiplier = 10; // Default 10x simulation speed
    this._vehicles = new Map();
    this._coverageStats = {
      coveredEdges: 0,
      totalDrivableEdges: 229433,
      coveragePct: 0,
      isComplete: false,
      coveredOneWayEdges: 0,
      coveredTwoWayEdges: 0,
      activeCars: 36,
      activeBuses: 14,
      totalVehicles: 50,
    };
    this._animTimer = null;
    this._lastFrameTime = 0;
    this._renderedTrackIds = new Set();
  }

  get isRunning() {
    return this._running;
  }

  get speedMultiplier() {
    return this._speedMultiplier;
  }

  get coverageStats() {
    return this._coverageStats;
  }

  attach() {
    if (!this._viewer || this._attached) return;
    if (!this._viewer.dataSources.contains(this._dataSource)) {
      this._viewer.dataSources.add(this._dataSource);
    }
    this._attached = true;
    this._dataSource.show = true;
    this._startAnimationLoop();
  }

  detach() {
    this._stopAnimationLoop();
    if (!this._viewer || !this._attached) return;
    this._dataSource.show = false;
    this._attached = false;
  }

  setRunning(running) {
    this._running = Boolean(running);
    if (this._running && this._attached) {
      this._startAnimationLoop();
    } else {
      this._stopAnimationLoop();
    }
  }

  setSpeedMultiplier(mult) {
    this._speedMultiplier = Math.max(1, Math.min(250, Number(mult) || 10));
  }

  cycleSpeedMultiplier() {
    const speeds = [1, 10, 50, 200];
    const idx = speeds.indexOf(this._speedMultiplier);
    this._speedMultiplier = speeds[(idx + 1) % speeds.length];
    return this._speedMultiplier;
  }

  clearTracks() {
    const entities = this._dataSource.entities;
    for (const tid of this._renderedTrackIds) {
      const ent = entities.getById(tid);
      if (ent) entities.remove(ent);
    }
    this._renderedTrackIds.clear();
  }

  clearAll() {
    this._dataSource.entities.removeAll();
    this._vehicles.clear();
    this._renderedTrackIds.clear();
  }

  destroy() {
    this.detach();
    this.clearAll();
    if (this._viewer && !this._viewer.isDestroyed?.()) {
      try {
        this._viewer.dataSources.remove(this._dataSource, true);
      } catch {
        // ignore
      }
    }
    this._viewer = null;
  }

  /**
   * Ingest fleet simulation state from `/api/safespot/fleet-sim`.
   */
  ingestFleetState(payload) {
    if (!payload) return;
    if (payload.coverage) {
      this._coverageStats = { ...this._coverageStats, ...payload.coverage };
    }

    const entities = this._dataSource.entities;

    // 1. Render newly covered road carriageway tracks in 3D
    const segments = payload.coveredSegmentsSample || [];
    const maxTracksInScene = 900;
    for (const seg of segments) {
      const trackId = `safespot:track:${seg.edgeId}`;
      if (this._renderedTrackIds.has(trackId)) continue;
      if (!Array.isArray(seg.coords) || seg.coords.length < 2) continue;

      if (this._renderedTrackIds.size >= maxTracksInScene) {
        const oldestId = this._renderedTrackIds.values().next().value;
        if (oldestId) {
          const oldEnt = entities.getById(oldestId);
          if (oldEnt) entities.remove(oldEnt);
          this._renderedTrackIds.delete(oldestId);
        }
      }

      const [c0, c1] = seg.coords;
      const colorCss =
        seg.vehicleType === 'BUS'
          ? FLEET_COLORS.TRACK_BUS
          : seg.oneway
            ? FLEET_COLORS.TRACK_ONEWAY
            : FLEET_COLORS.TRACK_TWOWAY;

      entities.add({
        id: trackId,
        name: `${seg.name || 'Road'} (${seg.oneway ? 'One-Way Carriageway' : 'Two-Way Carriageway'})`,
        polyline: {
          positions: [
            Cesium.Cartesian3.fromDegrees(c0[0], c0[1], 0),
            Cesium.Cartesian3.fromDegrees(c1[0], c1[1], 0),
          ],
          width: seg.oneway ? 4.5 : 3.5,
          material: Cesium.Color.fromCssColorString(colorCss).withAlpha(0.78),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
      this._renderedTrackIds.add(trackId);
    }

    // 2. Update or spawn the 50 autonomous test Cars & Buses
    const vehicles = payload.vehicles || [];
    for (let i = 0; i < vehicles.length; i++) {
      const vData = vehicles[i];
      if (!Array.isArray(vData.waypoints) || vData.waypoints.length === 0) continue;

      let state = this._vehicles.get(vData.id);
      const wp0 = vData.waypoints[0];
      const offsetPos = applyCarriagewayOffset(wp0.fromLat, wp0.fromLng, wp0.bearing, wp0.oneway);
      const initialCartesian = Cesium.Cartesian3.fromDegrees(offsetPos.lng, offsetPos.lat, 1.5);

      if (!state) {
        const badgeUri = buildVehicleBadgeSvg(
          vData.id,
          vData.vehicleType,
          wp0.speedKmh,
          wp0.oneway
        );
        const entity = entities.add({
          id: `safespot:vehicle:${vData.id}`,
          name: `${vData.id} (${vData.serviceLabel || vData.vehicleType})`,
          position: initialCartesian,
          billboard: {
            image: badgeUri,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scale: 0.88,
          },
        });

        state = {
          id: vData.id,
          vehicleType: vData.vehicleType,
          serviceLabel: vData.serviceLabel,
          depotName: vData.depotName,
          status: vData.status || 'covering',
          waypoints: vData.waypoints,
          wpIndex: 0,
          wpProgressSec: Number(vData.progressSec) || 0,
          lat: offsetPos.lat,
          lng: offsetPos.lng,
          bearing: wp0.bearing,
          speedKmh: wp0.speedKmh,
          oneway: wp0.oneway,
          roadName: wp0.roadName,
          position: initialCartesian,
          entity,
          lastBadgeKey: `${Math.round(wp0.speedKmh / 5)}|${wp0.oneway ? 1 : 0}`,
        };
        this._vehicles.set(vData.id, state);
      } else {
        // The server is authoritative: its waypoint list starts at the edge the
        // vehicle is on right now, with `progressSec` elapsed along it.
        state.waypoints = vData.waypoints;
        state.wpIndex = 0;
        state.wpProgressSec = Number(vData.progressSec) || 0;
        state.status = vData.status || state.status;
      }
    }

    this._viewer?.scene?.requestRender?.();
  }

  _startAnimationLoop() {
    if (this._animTimer || !this._running) return;
    this._lastFrameTime = Date.now();
    this._animTimer = setInterval(() => {
      if (!this._attached || !this._running) return;
      const now = Date.now();
      const dtSec = Math.min(0.25, Math.max(0.016, (now - this._lastFrameTime) / 1000));
      this._lastFrameTime = now;
      this.stepAnimation(dtSec);
    }, 50); // 20 Hz smooth interpolation tick
  }

  _stopAnimationLoop() {
    if (this._animTimer) {
      clearInterval(this._animTimer);
      this._animTimer = null;
    }
  }

  /**
   * Advance each vehicle smoothly along its directed road track waypoints.
   */
  stepAnimation(dtSec = 0.05) {
    if (this._vehicles.size === 0) return;
    // Same clock as the server: wall seconds × speed multiplier.
    const simDeltaSec = dtSec * this._speedMultiplier;

    for (const v of this._vehicles.values()) {
      const wps = v.waypoints;
      if (!wps || wps.length === 0) continue;

      if (v.wpIndex >= wps.length) v.wpIndex = wps.length - 1;
      let wp = wps[v.wpIndex];
      v.wpProgressSec += simDeltaSec;

      while (v.wpProgressSec >= (wp.durationSec || 1.5)) {
        if (v.wpIndex >= wps.length - 1) {
          // Out of planned track: hold at the end of the last edge until the
          // next server tick extends the route. Never loop back over driven edges.
          v.wpProgressSec = wp.durationSec || 1.5;
          break;
        }
        v.wpProgressSec -= wp.durationSec || 1.5;
        v.wpIndex += 1;
        wp = wps[v.wpIndex];
      }

      const frac = Math.max(0, Math.min(1, v.wpProgressSec / Math.max(0.4, wp.durationSec || 1.5)));
      const rawLat = wp.fromLat + (wp.toLat - wp.fromLat) * frac;
      const rawLng = wp.fromLng + (wp.toLng - wp.fromLng) * frac;
      const offset = applyCarriagewayOffset(rawLat, rawLng, wp.bearing, wp.oneway);

      v.lat = offset.lat;
      v.lng = offset.lng;
      v.bearing = wp.bearing;
      v.speedKmh = wp.speedKmh;
      v.oneway = wp.oneway;
      v.roadName = wp.roadName;
      v.position = Cesium.Cartesian3.fromDegrees(offset.lng, offset.lat, 1.5);

      if (v.entity) {
        v.entity.position = v.position;
        const badgeKey = `${Math.round(wp.speedKmh / 5)}|${wp.oneway ? 1 : 0}`;
        if (badgeKey !== v.lastBadgeKey && v.entity.billboard) {
          v.lastBadgeKey = badgeKey;
          v.entity.billboard.image = buildVehicleBadgeSvg(
            v.id,
            v.vehicleType,
            wp.speedKmh,
            wp.oneway
          );
        }
      }
    }

    this._viewer?.scene?.requestRender?.();
  }

  /**
   * Expose autonomous test Cars and Buses (`CAR-xxxx` & `BUS-xxxx`) to God's Eye View's
   * screen-space Detection Overlay (`getDetectableObjects`).
   */
  getDetectableObjects(options = {}) {
    if (!this._attached || this._vehicles.size === 0) return [];
    const all = Array.from(this._vehicles.values());
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : all.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.floor(all.length / maxCount));
    const start = seed % stride;

    const result = [];
    for (let i = start; i < all.length; i += stride) {
      const v = all[i];
      if (!v.position) continue;
      const cw = v.oneway ? '1-WAY' : '2-WAY';
      result.push({
        position: v.position,
        bracketHalfWidth: 12,
        bracketHalfHeight: 12,
        sourceId: v.id,
        id: v.id,
        type: 'VEH',
        klass: v.vehicleType === 'BUS' ? `SAFESPOT BUS · ${cw}` : `SAFESPOT CAR · ${cw}`,
        metric: `${Math.round(v.speedKmh)} KM/H · ${(v.roadName || 'SG').slice(0, 14).toUpperCase()}`,
        tier: v.vehicleType === 'BUS' ? 'bus' : 'free',
      });
      if (result.length >= maxCount) break;
    }
    return result;
  }
}
