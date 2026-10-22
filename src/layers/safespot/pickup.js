import * as Cesium from 'cesium';
import { toCartesianPositions } from './rendering.js';

/**
 * @module layers/safespot/pickup
 * @description Senior Pickup & Sheltered Walkway 3D visual simulation for SafeSpotSG
 * Evaluation Lab inside God's Eye View.
 *
 * Implements:
 * - Scored pickup candidates (LTA taxi stands, kerbside points) with rank badges and candidate pins.
 * - 1-to-many Dijkstra driving approach route (driver location -> selected pickup point).
 * - Senior walking path (senior location -> pickup point).
 * - Dynamic rain adaptation: When isRaining: true, prefer covered linkways (covered=yes)
 *   and penalize stairs, increasing shelteredPercentage.
 * - Display ranking reason, driver ETA, senior walking time, and sheltered percentage
 *   using inline SVG data URI billboard cards.
 *
 * STRICT INVARIANT: noCesiumLabels! No Cesium LabelCollection or entity labels.
 * Uses BillboardGraphics (inline SVG pin/badge icons) and PointGraphics with depth disable.
 */

export const PICKUP_COLORS = Object.freeze({
  WALK_SHELTERED: '#10b981', // High sheltered walk path (Emerald Green)
  WALK_UNSHELTERED: '#38bdf8', // Normal/direct walking path (Sky Cyan)
  DRIVE_APPROACH: '#f59e0b', // Driver approach route (Amber Gold)
  SENIOR_PIN: '#06b6d4', // Senior origin marker (Cyan)
  DRIVER_PIN: '#f59e0b', // Driver origin marker (Amber)
  RANK_GOLD: '#10b981', // Rank 1 (Top pick)
  RANK_SILVER: '#0284c7', // Rank 2
  RANK_BRONZE: '#8b5cf6', // Rank 3
  RANK_DEFAULT: '#64748b', // Rank 4+
  CARD_BG: '#0f172a', // Billboard HUD background (Slate 900)
  CARD_BORDER: '#38bdf8', // Billboard HUD border
});

/** Encode SVG text as a data URL */
export function svgToDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate SVG Rank Badge pin data URI.
 * @param {number} rank 1-based rank number
 * @param {number} [shelteredPct=0] Sheltered percentage (0-100)
 * @param {boolean} [isSelected=false]
 * @returns {string} SVG data URI
 */
export function createRankBadgeSvg(rank, shelteredPct = 0, isSelected = false) {
  let mainColor = PICKUP_COLORS.RANK_DEFAULT;
  if (rank === 1) mainColor = PICKUP_COLORS.RANK_GOLD;
  else if (rank === 2) mainColor = PICKUP_COLORS.RANK_SILVER;
  else if (rank === 3) mainColor = PICKUP_COLORS.RANK_BRONZE;

  const strokeColor = isSelected ? '#ffffff' : '#e2e8f0';
  const strokeWidth = isSelected ? 2 : 1;
  const shadowFilter = isSelected
    ? `<filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
         <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#ffffff" flood-opacity="0.7"/>
       </filter>`
    : `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
         <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.6"/>
       </filter>`;
  const filterAttr = isSelected ? 'filter="url(#glow)"' : 'filter="url(#shadow)"';

  return svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50">
      <defs>${shadowFilter}</defs>
      <path ${filterAttr} fill="${mainColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}"
        d="M20 2 C10 2 2 10 2 20 C2 31 20 48 20 48 C20 48 38 31 38 20 C38 10 30 2 20 2 Z"/>
      <circle cx="20" cy="18" r="12" fill="#0a0e17" fill-opacity="0.92" stroke="${strokeColor}" stroke-width="0.75"/>
      <text x="20" y="22" text-anchor="middle" font-family="'JetBrains Mono', 'Inter', monospace"
        font-size="12" font-weight="800" fill="#f8fafc">#${rank}</text>
      ${
        shelteredPct > 0
          ? `<rect x="5" y="34" width="30" height="11" rx="4" fill="#0a0e17" fill-opacity="0.94" stroke="#38bdf8" stroke-width="0.8"/>
             <text x="20" y="42" text-anchor="middle" font-family="'JetBrains Mono', monospace"
               font-size="7.5" font-weight="700" fill="#38bdf8">${shelteredPct}%</text>`
          : ''
      }
    </svg>
  `);
}

/**
 * Generate SVG Info Card Billboard data URI.
 * Renders HUD metadata card above selected pickup point without Cesium labels.
 * @param {object} candidate
 * @param {boolean} [isRaining=false]
 * @returns {string} SVG data URI
 */
export function createCandidateInfoCardSvg(candidate, isRaining = false) {
  if (!candidate) return '';
  const rank = candidate.rank ?? 1;
  const rawName = candidate.name || `Pickup Point #${rank}`;
  const truncatedName = rawName.length > 28 ? rawName.slice(0, 26) + '…' : rawName;
  const name = escapeXml(truncatedName);
  const walkSec = candidate.seniorWalkSeconds || 0;
  const walkMin = Math.floor(walkSec / 60);
  const walkRemainderSec = walkSec % 60;
  const walkStr = walkMin > 0 ? `${walkMin}m ${walkRemainderSec}s` : `${walkSec}s`;

  const driveSec = candidate.driverEtaSeconds ?? candidate.driveSeconds ?? 0;
  const driveMin = Math.floor(driveSec / 60);
  const driveStr = driveMin > 0 ? `${driveMin} min` : `${driveSec}s`;

  const sheltered = candidate.shelteredPercentage ?? 0;
  const score = candidate.score ?? '—';
  const reasonRaw = candidate.rankingReason || (candidate.reasons && candidate.reasons[0]) || 'Optimal approach point';
  const truncatedReason = reasonRaw.length > 36 ? reasonRaw.slice(0, 34) + '…' : reasonRaw;
  const reason = escapeXml(truncatedReason);

  const weatherBadge = isRaining ? 'RAIN ADAPTED' : 'DRY OPTIMAL';
  const weatherColor = isRaining ? '#38bdf8' : '#eab308';
  const borderColor = candidate.barrierFree ? '#10b981' : '#38bdf8';
  const pointTypeLabel = candidate.type === 'taxi_stand' ? 'TAXI STAND' : 'KERBSIDE';

  return svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="248" height="82" viewBox="0 0 248 82">
      <defs>
        <filter id="cardShadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000000" flood-opacity="0.72"/>
        </filter>
        <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#111827"/>
          <stop offset="100%" stop-color="#0a0e17"/>
        </linearGradient>
      </defs>
      <rect filter="url(#cardShadow)" x="1" y="1" width="246" height="80" rx="6"
        fill="#0a0e17" fill-opacity="0.94" stroke="${borderColor}" stroke-width="1"/>
      <rect x="1.5" y="1.5" width="245" height="22" rx="5" fill="url(#headerGrad)"/>
      <line x1="1" y1="24" x2="247" y2="24" stroke="#1e293b" stroke-width="1"/>
      <!-- Header -->
      <rect x="8" y="6" width="18" height="13" rx="3" fill="#10b981" fill-opacity="0.2" stroke="#10b981" stroke-width="0.8"/>
      <text x="17" y="15.5" text-anchor="middle" font-family="'JetBrains Mono', monospace"
        font-size="8.5" font-weight="800" fill="#10b981">#${rank}</text>
      <text x="31" y="15.5" font-family="'Inter', system-ui, -apple-system, sans-serif"
        font-size="9.5" font-weight="700" fill="#f8fafc">${name}</text>
      <rect x="174" y="6" width="66" height="13" rx="3" fill="#0f172a" stroke="${weatherColor}" stroke-width="0.75"/>
      <circle cx="181" cy="12.5" r="2" fill="${weatherColor}"/>
      <text x="210" y="15" text-anchor="middle" font-family="'JetBrains Mono', monospace"
        font-size="6.8" font-weight="700" fill="${weatherColor}">${weatherBadge}</text>
      <!-- Metrics Row 1 -->
      <text x="10" y="39" font-family="'Inter', system-ui, sans-serif"
        font-size="8.5" font-weight="600" fill="#94a3b8">WALK</text>
      <text x="40" y="39" font-family="'JetBrains Mono', monospace"
        font-size="9" font-weight="700" fill="#38bdf8">${walkStr} (${sheltered}% roof)</text>
      <text x="172" y="39" font-family="'Inter', system-ui, sans-serif"
        font-size="8.5" font-weight="600" fill="#94a3b8">ETA</text>
      <text x="194" y="39" font-family="'JetBrains Mono', monospace"
        font-size="9" font-weight="700" fill="#f59e0b">${driveStr}</text>
      <!-- Metrics Row 2 -->
      <text x="10" y="55" font-family="'Inter', system-ui, sans-serif"
        font-size="8.5" font-weight="600" fill="#94a3b8">SCORE</text>
      <text x="46" y="55" font-family="'JetBrains Mono', monospace"
        font-size="9" font-weight="700" fill="#10b981">${score} pts</text>
      <rect x="166" y="46.5" width="74" height="12" rx="2.5" fill="#1e1b4b" fill-opacity="0.55" stroke="#8b5cf6" stroke-width="0.6"/>
      <text x="203" y="55" text-anchor="middle" font-family="'JetBrains Mono', monospace"
        font-size="7.5" font-weight="700" fill="#c4b5fd">${pointTypeLabel}</text>
      <!-- Metrics Row 3 -->
      <text x="10" y="71" font-family="'Inter', system-ui, sans-serif"
        font-size="8" fill="#cbd5e1">${reason}</text>
    </svg>
  `);
}

/**
 * Generate SVG Senior Origin Pin.
 * @returns {string} SVG data URI
 */
export function createSeniorPinSvg() {
  return svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="38" height="48" viewBox="0 0 38 48">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.6"/>
        </filter>
      </defs>
      <path filter="url(#shadow)" fill="#06b6d4" stroke="#ffffff" stroke-width="2"
        d="M19 2 C9.6 2 2 9.6 2 19 C2 31 19 46 19 46 C19 46 36 31 36 19 C36 9.6 28.4 2 19 2 Z"/>
      <circle cx="19" cy="18" r="10" fill="#ffffff"/>
      <!-- Senior walking stick icon -->
      <circle cx="19" cy="13" r="2.5" fill="#0891b2"/>
      <path fill="none" stroke="#0891b2" stroke-width="1.8" stroke-linecap="round"
        d="M19 16 L19 21 L16 25 M19 21 L22 25 M16 19 L14 26"/>
    </svg>
  `);
}

/**
 * Generate SVG Driver Origin Pin.
 * @returns {string} SVG data URI
 */
export function createDriverPinSvg() {
  return svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="38" height="48" viewBox="0 0 38 48">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.6"/>
        </filter>
      </defs>
      <path filter="url(#shadow)" fill="#f59e0b" stroke="#ffffff" stroke-width="2"
        d="M19 2 C9.6 2 2 9.6 2 19 C2 31 19 46 19 46 C19 46 36 31 36 19 C36 9.6 28.4 2 19 2 Z"/>
      <circle cx="19" cy="18" r="10" fill="#ffffff"/>
      <!-- Car / Taxi icon -->
      <path fill="#d97706" d="M14 19 L15 15 C15.3 14.2 16 14 17 14 L21 14 C22 14 22.7 14.2 23 15 L24 19 L25 19 C25.5 19 26 19.5 26 20 L26 22 C26 22.5 25.5 23 25 23 L25 24 C25 24.5 24.5 25 24 25 L23 25 C22.5 25 22 24.5 22 24 L22 23 L16 23 L16 24 C16 24.5 15.5 25 15 25 L14 25 C13.5 25 13 24.5 13 24 L13 23 L13 20 C13 19.5 13.5 19 14 19 Z M16 21 C16.5 21 17 20.5 17 20 C17 19.5 16.5 19 16 19 C15.5 19 15 19.5 15 20 C15 20.5 15.5 21 16 21 Z M22 21 C22.5 21 23 20.5 23 20 C23 19.5 22.5 19 22 19 C21.5 19 21 19.5 21 20 C21 20.5 21.5 21 22 21 Z"/>
    </svg>
  `);
}

/**
 * SafeSpot Senior Pickup Simulation 3D Cesium Renderer.
 */
export class SafeSpotPickupRenderer {
  constructor(viewer) {
    this._viewer = viewer;
    this._dataSource = new Cesium.CustomDataSource('safespot-pickup-simulation');
    this._attached = false;
    this._simulationData = null;
    this._selectedCandidateId = null;
    this._activePositions = [];
  }

  /** Attach data source to viewer */
  attach() {
    if (!this._viewer || this._attached) return;
    if (!this._viewer.dataSources.contains(this._dataSource)) {
      this._viewer.dataSources.add(this._dataSource);
    }
    this._attached = true;
    this._dataSource.show = true;
  }

  /** Detach data source from viewer */
  detach() {
    if (!this._viewer || !this._attached) return;
    this._dataSource.show = false;
    this._attached = false;
  }

  /** Clear all simulation entities */
  clear() {
    this._dataSource.entities.removeAll();
    this._activePositions = [];
  }

  /** Destroy renderer and remove data source */
  destroy() {
    this.detach();
    this.clear();
    if (this._viewer && !this._viewer.isDestroyed()) {
      try {
        this._viewer.dataSources.remove(this._dataSource, true);
      } catch {
        // ignore
      }
    }
    this._viewer = null;
    this._simulationData = null;
    this._selectedCandidateId = null;
  }

  /**
   * Render full pickup simulation result with candidates, walking route, and driver approach.
   * @param {object} simulationData Result from simulatePickup / /api/safespot/pickup-sim
   * @param {object} [options]
   * @param {string} [options.selectedCandidateId] Candidate ID to select (defaults to top candidate)
   * @param {{ lat: number, lng: number }} [options.seniorLocation]
   * @param {{ lat: number, lng: number }} [options.driverLocation]
   */
  renderPickupSimulation(simulationData, {
    selectedCandidateId = null,
    seniorLocation = null,
    driverLocation = null,
  } = {}) {
    this.clear();
    if (!simulationData) return;
    this._simulationData = simulationData;

    const rawCandidates = simulationData.candidates || [];
    if (rawCandidates.length === 0) return;

    // Attach ranks
    const candidates = rawCandidates.map((c, idx) => ({ ...c, rank: idx + 1 }));

    // Determine active candidate
    if (selectedCandidateId && candidates.some((c) => c.id === selectedCandidateId)) {
      this._selectedCandidateId = selectedCandidateId;
    } else {
      this._selectedCandidateId = candidates[0].id;
    }

    const selected = candidates.find((c) => c.id === this._selectedCandidateId) || candidates[0];
    const isRaining = Boolean(simulationData.isRaining || simulationData.weather?.isRaining);

    const entities = this._dataSource.entities;
    const allPositions = [];

    // Senior Origin Pin
    const seniorPos = seniorLocation ||
      (selected.walkingPath?.[0] ? { lng: selected.walkingPath[0][0], lat: selected.walkingPath[0][1] } : null) ||
      (selected.walkPath?.[0] ? { lng: selected.walkPath[0].lng, lat: selected.walkPath[0].lat } : null);

    if (seniorPos) {
      const seniorCartesian = Cesium.Cartesian3.fromDegrees(seniorPos.lng, seniorPos.lat, 0);
      allPositions.push(seniorCartesian);
      entities.add({
        id: 'safespot:pickup:senior-origin',
        name: 'Senior Current Location',
        position: seniorCartesian,
        billboard: {
          image: createSeniorPinSvg(),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scale: 1.0,
          scaleByDistance: new Cesium.NearFarScalar(1200, 1.0, 18000, 0.35),
        },
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromCssColorString(PICKUP_COLORS.SENIOR_PIN),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }

    // Driver Origin Pin
    const driverPos = driverLocation ||
      (selected.drivePath?.[0] ? { lng: selected.drivePath[0].lng, lat: selected.drivePath[0].lat } : null);

    if (driverPos) {
      const driverCartesian = Cesium.Cartesian3.fromDegrees(driverPos.lng, driverPos.lat, 0);
      allPositions.push(driverCartesian);
      entities.add({
        id: 'safespot:pickup:driver-origin',
        name: 'Driver Current Location',
        position: driverCartesian,
        billboard: {
          image: createDriverPinSvg(),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scale: 1.0,
          scaleByDistance: new Cesium.NearFarScalar(1200, 1.0, 18000, 0.35),
        },
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromCssColorString(PICKUP_COLORS.DRIVER_PIN),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }

    // Render All Scored Candidates (Pins and Rank Badges)
    candidates.forEach((cand) => {
      const cLat = Number(cand.location?.lat ?? cand.lat);
      const cLng = Number(cand.location?.lng ?? cand.lng);
      if (!Number.isFinite(cLat) || !Number.isFinite(cLng)) return;

      const candCartesian = Cesium.Cartesian3.fromDegrees(cLng, cLat, 0);
      allPositions.push(candCartesian);
      const isCandSelected = cand.id === selected.id;

      entities.add({
        id: `safespot:pickup:candidate:${cand.id}`,
        name: `${cand.name || `Pickup #${cand.rank}`} (Rank ${cand.rank})`,
        position: candCartesian,
        billboard: {
          image: createRankBadgeSvg(cand.rank, cand.shelteredPercentage, isCandSelected),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scale: isCandSelected ? 1.15 : 0.95,
          scaleByDistance: new Cesium.NearFarScalar(1200, 1.0, 18000, 0.35),
        },
        point: {
          pixelSize: isCandSelected ? 12 : 8,
          color: Cesium.Color.fromCssColorString(
            cand.rank === 1 ? PICKUP_COLORS.RANK_GOLD : PICKUP_COLORS.RANK_SILVER,
          ),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });

    // Render Routes for Selected Candidate
    // 1. Senior Walking Path (Dynamic Rain & Covered Linkways Adaptation)
    const walkCoords = selected.walkingPath || selected.walkPath || [];
    const walkPositions = toCartesianPositions(walkCoords);
    if (walkPositions.length >= 2) {
      allPositions.push(...walkPositions);
      const isHighlySheltered = (selected.shelteredPercentage || 0) >= 80;
      const walkColor = isHighlySheltered
        ? Cesium.Color.fromCssColorString(PICKUP_COLORS.WALK_SHELTERED)
        : Cesium.Color.fromCssColorString(PICKUP_COLORS.WALK_UNSHELTERED);

      entities.add({
        id: 'safespot:pickup:senior-walk-route',
        name: `Senior Walking Route (${selected.shelteredPercentage}% Sheltered)`,
        polyline: {
          positions: walkPositions,
          width: 6,
          material: new Cesium.PolylineDashMaterialProperty({
            color: walkColor,
            dashLength: isRaining && isHighlySheltered ? 8.0 : 16.0,
          }),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    }

    // 2. Driver 1-to-Many Dijkstra Approach Route
    const driveCoords = selected.drivePath || (driverPos && selected.location ? [driverPos, selected.location] : []);
    const drivePositions = toCartesianPositions(driveCoords);
    if (drivePositions.length >= 2) {
      allPositions.push(...drivePositions);
      entities.add({
        id: 'safespot:pickup:driver-approach-route',
        name: `Driver Approach Route (ETA: ${selected.driverEtaSeconds ?? selected.driveSeconds ?? 0}s)`,
        polyline: {
          positions: drivePositions,
          width: 7,
          material: Cesium.Color.fromCssColorString(PICKUP_COLORS.DRIVE_APPROACH).withAlpha(0.95),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    }

    // 3. Info Card Billboard above Selected Candidate (100% label-free SVG HUD)
    const selLat = Number(selected.location?.lat ?? selected.lat);
    const selLng = Number(selected.location?.lng ?? selected.lng);
    if (Number.isFinite(selLat) && Number.isFinite(selLng)) {
      entities.add({
        id: 'safespot:pickup:info-card',
        name: `Selected Pickup: ${selected.name}`,
        position: Cesium.Cartesian3.fromDegrees(selLng, selLat, 0),
        billboard: {
          image: createCandidateInfoCardSvg(selected, isRaining),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -62),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scale: 1.0,
          scaleByDistance: new Cesium.NearFarScalar(1000, 1.0, 14000, 0.0),
          translucencyByDistance: new Cesium.NearFarScalar(2500, 1.0, 12000, 0.0),
        },
      });
    }

    this._activePositions = allPositions;

    if (this._viewer && typeof this._viewer.scene?.requestRender === 'function') {
      this._viewer.scene.requestRender();
    }
  }

  /**
   * Switch active candidate selection.
   * @param {string} candidateId
   */
  selectCandidate(candidateId) {
    if (!this._simulationData) return;
    this.renderPickupSimulation(this._simulationData, {
      selectedCandidateId: candidateId,
    });
  }

  /**
   * Retrieve currently selected candidate object.
   * @returns {object|null}
   */
  getSelectedCandidate() {
    if (!this._simulationData?.candidates) return null;
    return (
      this._simulationData.candidates.find((c) => c.id === this._selectedCandidateId) ||
      this._simulationData.candidates[0] ||
      null
    );
  }

  /**
   * Fly camera to encompass pickup candidates, senior, and driver.
   */
  flyToPickupArea() {
    if (!this._viewer || this._activePositions.length === 0) return;
    try {
      const boundingSphere = Cesium.BoundingSphere.fromPoints(this._activePositions);
      this._viewer.camera.flyToBoundingSphere(boundingSphere, {
        duration: 1.5,
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), boundingSphere.radius * 2.4),
      });
    } catch (err) {
      console.warn('[SafeSpotPickupRenderer] flyToPickupArea error:', err);
    }
  }
}
