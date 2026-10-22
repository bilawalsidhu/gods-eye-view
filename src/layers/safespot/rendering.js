import * as Cesium from 'cesium';

/**
 * @module layers/safespot/rendering
 * @description Cesium 3D visual rendering for SafeSpotSG Evaluation Lab.
 *
 * Implements:
 * - Simultaneous side-by-side rendering of SafeSpot Engine and Google/reference route polylines.
 * - Cesium.ClassificationType.BOTH with clampToGround: true for 3D Tiles draping.
 * - Per-edge speed and delay heatmaps (free-flow green, moderate amber, delayed crimson).
 * - >35m divergence markers: highlight spatial separation spans, place 3D alert markers
 *   at divergence start, peak maximum separation, and re-convergence.
 *
 * STRICT INVARIANT: noCesiumLabels! No Cesium LabelCollection or entity labels.
 * Uses BillboardGraphics (inline SVG pin/badge icons) and PointGraphics with depth disable.
 */

// Route & Heatmap Color Palette
export const ROUTE_COLORS = Object.freeze({
  REFERENCE: '#2563eb', // Google / Reference Route (Azure Blue)
  SAFESPOT_DEFAULT: '#06b6d4', // SafeSpot Default Route (Cyan)
  MODEL_BASELINE: '#94a3b8', // Baseline Heuristic (Slate Gray)
  MODEL_CALIBRATED: '#06b6d4', // Calibrated Parametric Optimizer (Cyan)
  MODEL_SPEEDBAND: '#a855f7', // LTA SpeedBand Hybrid (Purple)
  SPEED_FREE: '#10b981', // Free-flow or residual < 5 km/h (Emerald Green)
  SPEED_MODERATE: '#f59e0b', // Moderate delay or residual 5-15 km/h (Amber)
  SPEED_DELAY: '#ef4444', // Congested / Delay or residual > 15 km/h (Crimson)
  DIVERGENCE_SPAN: '#f97316', // Divergent span highlight (Vibrant Orange)
  DIVERGENCE_MARKER_START: '#f59e0b',
  DIVERGENCE_MARKER_PEAK: '#ef4444',
  DIVERGENCE_MARKER_END: '#10b981',
});

/** Encode SVG text as a data URL */
function svgToDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}

// Marker Billboard Icons (100% label-free SVG graphics)
const ICONS = Object.freeze({
  // Divergence peak alert icon (>35m max separation badge)
  ALERT_PEAK: svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="42" viewBox="0 0 36 42">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.5"/>
        </filter>
      </defs>
      <path filter="url(#shadow)" fill="#ef4444" stroke="#ffffff" stroke-width="2" d="M18 2 C9.163 2 2 9.163 2 18 C2 28 18 40 18 40 C18 40 34 28 34 18 C34 9.163 26.837 2 18 2 Z"/>
      <path fill="#ffffff" d="M16.5 10 h3 v9 h-3 Z M16.5 21 h3 v3 h-3 Z"/>
    </svg>
  `),

  // Divergence start marker icon (split route warning)
  DIVERGE_START: svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="14" fill="#f59e0b" stroke="#ffffff" stroke-width="2"/>
      <path fill="#ffffff" d="M12 22 L12 15 L8 15 L16 7 L24 15 L20 15 L20 22 Z"/>
    </svg>
  `),

  // Re-convergence marker icon (join / merge success)
  RECONVERGE: svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="14" fill="#10b981" stroke="#ffffff" stroke-width="2"/>
      <path fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" d="M9 16 l5 5 l9 -9"/>
    </svg>
  `),

  // Origin pin (A)
  PIN_ORIGIN: svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
      <path fill="#10b981" stroke="#ffffff" stroke-width="2" d="M15 2 C7.82 2 2 7.82 2 15 C2 24.5 15 36 15 36 C15 36 28 24.5 28 15 C28 7.82 22.18 2 15 2 Z"/>
      <circle cx="15" cy="15" r="5" fill="#ffffff"/>
    </svg>
  `),

  // Destination pin (B)
  PIN_DEST: svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
      <path fill="#ef4444" stroke="#ffffff" stroke-width="2" d="M15 2 C7.82 2 2 7.82 2 15 C2 24.5 15 36 15 36 C15 36 28 24.5 28 15 C28 7.82 22.18 2 15 2 Z"/>
      <circle cx="15" cy="15" r="5" fill="#ffffff"/>
    </svg>
  `),
});

/**
 * Determine edge heatmap color from speed, delay, and speedRatio.
 * @param {number} [speedKmh]
 * @param {number} [delaySeconds]
 * @param {number} [speedRatio]
 * @returns {Cesium.Color}
 */
export function getSpeedColor(speedKmh, delaySeconds = 0, speedRatio = null) {
  if (typeof speedRatio === 'number') {
    if (speedRatio >= 0.75) return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_FREE);
    if (speedRatio >= 0.5) return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_MODERATE);
    return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_DELAY);
  }
  if (delaySeconds >= 10 || (typeof speedKmh === 'number' && speedKmh < 25)) {
    return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_DELAY);
  }
  if (delaySeconds >= 5 || (typeof speedKmh === 'number' && speedKmh < 45)) {
    return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_MODERATE);
  }
  return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_FREE);
}

/**
 * Determine residual speed heatmap color (<5 km/h green, 5-15 km/h amber, >15 km/h crimson).
 * @param {number} residualSpeedKmh Absolute residual speed error in km/h
 * @returns {Cesium.Color}
 */
export function getResidualSpeedColor(residualSpeedKmh) {
  const error = Math.abs(Number(residualSpeedKmh) || 0);
  if (error < 5.0) return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_FREE);
  if (error <= 15.0) return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_MODERATE);
  return Cesium.Color.fromCssColorString(ROUTE_COLORS.SPEED_DELAY);
}

/**
 * Convert heterogeneous coordinate representations to Cesium Cartesian3 array.
 * Supports: [[lng, lat, alt], ...], [{lat, lng}, ...], [{lat, lon}, ...]
 * @param {Array} coords
 * @returns {Array<Cesium.Cartesian3>}
 */
export function toCartesianPositions(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  const positions = [];

  for (const item of coords) {
    if (Array.isArray(item) && item.length >= 2) {
      const lng = Number(item[0]);
      const lat = Number(item[1]);
      const alt = Number(item[2] || 0);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        positions.push(Cesium.Cartesian3.fromDegrees(lng, lat, alt));
      }
    } else if (item && typeof item === 'object') {
      const lat = Number(item.lat);
      const lng = Number(item.lng ?? item.lon);
      const alt = Number(item.alt || 0);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        positions.push(Cesium.Cartesian3.fromDegrees(lng, lat, alt));
      }
    }
  }

  return positions;
}

/**
 * Extract single coordinate object { lat, lng } from point representation.
 */
function toLatLng(coord) {
  if (!coord) return null;
  if (Array.isArray(coord) && coord.length >= 2) {
    return { lng: Number(coord[0]), lat: Number(coord[1]) };
  }
  if (typeof coord === 'object') {
    return {
      lat: Number(coord.lat),
      lng: Number(coord.lng ?? coord.lon),
    };
  }
  return null;
}

/**
 * SafeSpot 3D Cesium Route & Divergence Renderer.
 */
export class SafeSpotRouteRenderer {
  constructor(viewer) {
    this._viewer = viewer;
    this._dataSource = new Cesium.CustomDataSource('safespot-evaluation-lab');
    this._attached = false;
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

  /** Clear all rendered route entities and markers */
  clear() {
    this._dataSource.entities.removeAll();
    this._activePositions = [];
  }

  /** Complete destruction */
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
  }

  /**
   * Render side-by-side SafeSpot Engine and Google reference routes,
   * speed/delay heatmaps, and >35m divergence markers.
   *
   * @param {object} corridorData Data from /api/safespot/corridor-diff
   * @param {object} [options]
   * @param {boolean} [options.showHeatmap=true]
   * @param {boolean} [options.showDivergence=true]
   * @param {boolean} [options.showGoogleReference=true]
   */
  renderCorridorDiff(corridorData, {
    model = 'calibrated',
    showHeatmap = true,
    showDivergence = true,
    showGoogleReference = true,
  } = {}) {
    this.clear();
    if (!corridorData) return;

    const entities = this._dataSource.entities;
    const safeSpot = corridorData.safespotRoute || corridorData.safeSpot || {};
    const reference = corridorData.referenceRoute || corridorData.reference || {};
    const divergence = corridorData.divergence || corridorData.comparison || {};

    const ssPositions = toCartesianPositions(safeSpot.coordinates);
    const refPositions = toCartesianPositions(reference.coordinates);

    this._activePositions = ssPositions.length > 0 ? ssPositions : refPositions;

    // 1. Google / Reference Route 3D Polyline (Azure Blue drape)
    if (showGoogleReference && refPositions.length >= 2) {
      entities.add({
        id: 'safespot:reference-route',
        name: 'Reference Route (Google Routes / OSRM)',
        polyline: {
          positions: refPositions,
          width: 7,
          material: Cesium.Color.fromCssColorString(ROUTE_COLORS.REFERENCE).withAlpha(0.9),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    }

    // 2. SafeSpot Engine Route (Side-by-Side Drape)
    if (ssPositions.length >= 2) {
      const edges = safeSpot.edges || safeSpot.edgeHeatmap || [];

      if (showHeatmap && edges.length > 0) {
        // Render per-edge residual/speed/delay heatmap segments
        edges.forEach((edge, idx) => {
          const edgeCoords = edge.coordinates || [
            safeSpot.coordinates[idx] || safeSpot.coordinates[0],
            safeSpot.coordinates[idx + 1] || safeSpot.coordinates[safeSpot.coordinates.length - 1],
          ];
          const edgePositions = toCartesianPositions(edgeCoords);
          if (edgePositions.length >= 2) {
            const edgeColor = typeof edge.residualSpeedKmh === 'number'
              ? getResidualSpeedColor(edge.residualSpeedKmh)
              : getSpeedColor(edge.speedKmh, edge.delaySeconds, edge.speedRatio);
            entities.add({
              id: `safespot:edge:${edge.edgeId || idx}`,
              name: edge.name ? `SafeSpot: ${edge.name}` : `SafeSpot Edge ${idx}`,
              polyline: {
                positions: edgePositions,
                width: 9,
                material: edgeColor,
                clampToGround: true,
                classificationType: Cesium.ClassificationType.BOTH,
              },
            });
          }
        });
      } else {
        // Base SafeSpot polyline with model-specific color
        const modelColor =
          model === 'baseline'
            ? ROUTE_COLORS.MODEL_BASELINE
            : model === 'speedband'
              ? ROUTE_COLORS.MODEL_SPEEDBAND
              : ROUTE_COLORS.MODEL_CALIBRATED;

        entities.add({
          id: 'safespot:engine-route',
          name: `SafeSpot Engine Route (${model})`,
          polyline: {
            positions: ssPositions,
            width: 9,
            material: Cesium.Color.fromCssColorString(modelColor).withAlpha(0.95),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
      }

      // Add Origin (A) and Destination (B) Pin Badges
      const originCoord = toLatLng(safeSpot.coordinates[0]);
      const destCoord = toLatLng(safeSpot.coordinates[safeSpot.coordinates.length - 1]);

      if (originCoord) {
        entities.add({
          id: 'safespot:pin:origin',
          name: 'Route Origin',
          position: Cesium.Cartesian3.fromDegrees(originCoord.lng, originCoord.lat, 0),
          billboard: {
            image: ICONS.PIN_ORIGIN,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scale: 1.0,
          },
        });
      }

      if (destCoord) {
        entities.add({
          id: 'safespot:pin:destination',
          name: 'Route Destination',
          position: Cesium.Cartesian3.fromDegrees(destCoord.lng, destCoord.lat, 0),
          billboard: {
            image: ICONS.PIN_DEST,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scale: 1.0,
          },
        });
      }
    }

    // 3. Divergence Highlighting & 3D Alert Markers (>35m spatial separation)
    if (showDivergence && (divergence.isDivergent || divergence.divergenceDetected)) {
      const spans = divergence.divergentSpans || [];

      spans.forEach((span, idx) => {
        const startPoint = toLatLng(span.startCoord || span.startLocation);
        const endPoint = toLatLng(span.endCoord || span.endLocation);
        const maxSep = span.maxSeparationMeters || divergence.maxSeparationMeters || 0;

        // Place 3D Marker at Divergence Start
        if (startPoint) {
          entities.add({
            id: `safespot:divergence:${idx}:start`,
            name: `Divergence Start (Span ${idx + 1})`,
            position: Cesium.Cartesian3.fromDegrees(startPoint.lng, startPoint.lat, 0),
            billboard: {
              image: ICONS.DIVERGE_START,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              scale: 0.9,
            },
            point: {
              pixelSize: 12,
              color: Cesium.Color.fromCssColorString(ROUTE_COLORS.DIVERGENCE_MARKER_START),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        }

        // Place 3D Peak Separation Marker (specifically highlights >2km for Novena-MBS and >1km for Toa Payoh)
        let peakCoord = null;
        if (startPoint && endPoint) {
          // Midpoint of span or approximate peak
          peakCoord = {
            lng: (startPoint.lng + endPoint.lng) / 2,
            lat: (startPoint.lat + endPoint.lat) / 2,
          };
        } else if (startPoint) {
          peakCoord = startPoint;
        }

        if (peakCoord) {
          entities.add({
            id: `safespot:divergence:${idx}:peak`,
            name: `Max Spatial Separation: ${Math.round(maxSep)}m`,
            position: Cesium.Cartesian3.fromDegrees(peakCoord.lng, peakCoord.lat, 0),
            billboard: {
              image: ICONS.ALERT_PEAK,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              scale: 1.1,
            },
            point: {
              pixelSize: 14,
              color: Cesium.Color.fromCssColorString(ROUTE_COLORS.DIVERGENCE_MARKER_PEAK),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        }

        // Place 3D Marker at Re-convergence Point
        if (endPoint) {
          entities.add({
            id: `safespot:divergence:${idx}:end`,
            name: `Re-convergence Point (Span ${idx + 1})`,
            position: Cesium.Cartesian3.fromDegrees(endPoint.lng, endPoint.lat, 0),
            billboard: {
              image: ICONS.RECONVERGE,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              scale: 0.9,
            },
            point: {
              pixelSize: 12,
              color: Cesium.Color.fromCssColorString(ROUTE_COLORS.DIVERGENCE_MARKER_END),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        }

        // Draped divergence corridor highlight polyline
        if (startPoint && endPoint) {
          entities.add({
            id: `safespot:divergence:${idx}:span-line`,
            name: `Divergent Span: ±${Math.round(maxSep)}m separation`,
            polyline: {
              positions: toCartesianPositions([
                [startPoint.lng, startPoint.lat, 0],
                [peakCoord.lng, peakCoord.lat, 0],
                [endPoint.lng, endPoint.lat, 0],
              ]),
              width: 4,
              material: new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.fromCssColorString(ROUTE_COLORS.DIVERGENCE_SPAN),
                dashLength: 16.0,
              }),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
          });
        }
      });
    }

    if (this._viewer && typeof this._viewer.scene?.requestRender === 'function') {
      this._viewer.scene.requestRender();
    }
  }

  /** Fly camera to focus on the active corridor */
  flyToActiveCorridor() {
    if (!this._viewer || this._activePositions.length === 0) return;
    try {
      const boundingSphere = Cesium.BoundingSphere.fromPoints(this._activePositions);
      this._viewer.camera.flyToBoundingSphere(boundingSphere, {
        duration: 1.5,
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), boundingSphere.radius * 2.2),
      });
    } catch (err) {
      console.warn('[SafeSpotRenderer] flyToActiveCorridor error:', err);
    }
  }
}
