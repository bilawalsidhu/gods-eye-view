import {
  accentForVesselType,
  normalizeVesselType,
} from '../../data/vesselLabels.js';

/**
 * Format raw APRS telemetry into a concise tactical card detail line:
 * `TLM #<seq> · A: a1, a2, ... · D: <digitalBits>`
 * Units are not invented because APRS defines them in separate messages.
 * @param {Object|null|undefined} telemetry Raw telemetry object.
 * @returns {string} Formatted detail line or empty string if absent.
 */
export function formatTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return '';
  const parts = [];
  const seq = telemetry.sequence;
  if (seq !== null && seq !== undefined && Number.isFinite(Number(seq))) {
    parts.push(`TLM #${Number(seq)}`);
  } else {
    parts.push('TLM');
  }
  if (Array.isArray(telemetry.analog) && telemetry.analog.length > 0) {
    parts.push(`A: ${telemetry.analog.join(', ')}`);
  }
  if (telemetry.digitalBits) {
    parts.push(`D: ${String(telemetry.digitalBits).trim()}`);
  }
  return parts.length > 1 || parts[0] !== 'TLM' ? parts.join(' · ') : '';
}

/**
 * Compact summary for ambient cards when primary navigation metrics are absent.
 * @param {Object|null|undefined} telemetry
 * @returns {string}
 */
export function formatTelemetrySummary(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return '';
  const seq = telemetry.sequence;
  if (seq !== null && seq !== undefined && Number.isFinite(Number(seq))) {
    return `TLM #${Number(seq)}`;
  }
  if (
    (Array.isArray(telemetry.analog) && telemetry.analog.length > 0) ||
    telemetry.digitalBits
  ) {
    return 'TLM';
  }
  return '';
}

/**
 * Single-line telemetry readout formatted for the monospace HUD corner.
 * Uses HUD double-space metric separation.
 * @param {Object|null|undefined} telemetry
 * @returns {string}
 */
export function formatHudTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return '';
  const parts = [];
  const seq = telemetry.sequence;
  if (seq !== null && seq !== undefined && Number.isFinite(Number(seq))) {
    parts.push(`TLM: #${Number(seq)}`);
  } else {
    parts.push('TLM: --');
  }
  if (Array.isArray(telemetry.analog) && telemetry.analog.length > 0) {
    parts.push(`A: ${telemetry.analog.join(',')}`);
  }
  if (telemetry.digitalBits) {
    parts.push(`D: ${String(telemetry.digitalBits).trim()}`);
  }
  return parts.length > 1 || parts[0] !== 'TLM: --' ? parts.join('  ') : '';
}

export function createCards({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;

  function updateSelectedVesselHud(record) {
    const el = document.getElementById('hud-ais-vessel');
    if (!el) return;

    // Pinned vessels missing from recent refreshes get a stale marker
    const stale = (record.missedRefreshes || 0) > 0;
    el.classList.add('active');
    const isAprs = Boolean(
      record?.reference?.startsWith('aprs:') || record?.telemetry,
    );
    const idLabel = isAprs ? 'CALL' : 'MMSI';
    const lines = [
      `${isAprs ? 'APRS' : 'AIS'}: ${trimHudValue(record.name, 32)}`,
      `${trimHudValue(record.type || 'VESSEL', 24)}  SPD: ${formatSpeed(record.speed)}  HDG: ${formatHeading(record.heading ?? record.course)}`,
      `${idLabel}: ${record.mmsi || '--'}  ${formatPositionTime(record)}${stale ? '  · STALE' : ''}`,
    ];
    if (record.telemetry) {
      const tlmLine = formatHudTelemetry(record.telemetry);
      if (tlmLine) lines.push(tlmLine);
    }
    el.textContent = lines.join('\n');
  }

  function resetSelectedVesselHud() {
    const el = document.getElementById('hud-ais-vessel');
    if (!el) return;
    el.classList.remove('active');
    el.textContent = 'AIS: --';
  }

  function trimHudValue(value, maxLength) {
    const text = String(value || '--').trim() || '--';
    return text.length > maxLength
      ? `${text.slice(0, maxLength - 3)}...`
      : text;
  }

  /**
   * Card model for an ambient (decluttered-in) vessel — name title plus one
   * compact type/speed/heading detail line, anchored at the record's current
   * rendered position (height-datum caveat: no datum work here). Pure —
   * exported for unit tests.
   * @param {Object} record - Vessel record.
   * @returns {Object} vesselLabels entry.
   */

  function buildVesselCard(record) {
    const parts = [];
    const type = vesselTypeShort(record);
    if (type) parts.push(type);
    if (record.speed !== null && record.speed !== undefined)
      parts.push(formatSpeed(record.speed));
    const direction = record.heading ?? record.course;
    if (Number.isFinite(direction)) parts.push(`${Math.round(direction)}°`);
    if (parts.length === 0 && record.telemetry) {
      const summary = formatTelemetrySummary(record.telemetry);
      if (summary) parts.push(summary);
    }
    return {
      id: vesselOverlayEntryId(record),
      actionable: Boolean(record?.mmsi),
      position:
        components.rendering.getVisual(record).billboard?.position ||
        components.rendering.getVisual(record).position,
      gapPx: 10,
      accent: accentForVesselType(record.type),
      title: trimHudValue(displayVesselName(record), 26),
      details: parts.length ? [parts.join(' · ')] : [],
      selected: false,
      priority: components.rendering.labelPriority(record, null),
    };
  }

  /**
   * Card model for the click-selected vessel — the full-detail card, drawn last
   * (on top) and never distance-faded by the overlay. Pinned-but-vanished
   * vessels carry a STALE marker (mirrors the HUD readout). Pure — exported
   * for unit tests.
   * @param {Object} record - Selected vessel record.
   * @returns {Object} vesselLabels entry.
   */

  function buildSelectedVesselCard(record) {
    const direction = record.heading ?? record.course;
    const details = [
      [
        vesselTypeShort(record) || 'VESSEL',
        formatSpeed(record.speed),
        Number.isFinite(direction) ? `${Math.round(direction)}°` : '--°',
      ].join(' · '),
    ];
    const destination = String(record.destination || '').trim();
    if (destination) details.push(`→ ${trimHudValue(destination, 24)}`);
    const stale = (record.missedRefreshes || 0) > 0;
    const isAprs = Boolean(
      record?.reference?.startsWith('aprs:') || record?.telemetry,
    );
    const idLabel = isAprs ? 'CALL' : 'MMSI';
    details.push(
      `${idLabel} ${record.mmsi || '--'} · ${formatPositionTime(record)}${stale ? ' · STALE' : ''}`,
    );
    if (record.telemetry) {
      const tlmLine = formatTelemetry(record.telemetry);
      if (tlmLine) details.push(tlmLine);
    }
    return {
      id: vesselOverlayEntryId(record),
      actionable: Boolean(record?.mmsi),
      position:
        components.rendering.getVisual(record).billboard?.position ||
        components.rendering.getVisual(record).position,
      gapPx: 12,
      accent: accentForVesselType(record.type),
      title: trimHudValue(displayVesselName(record), 32),
      details,
      selected: true,
      priority: 100000,
    };
  }

  /** Stable overlay identity for MMSI-keyed and source-retained unkeyed rows. */

  function vesselOverlayEntryId(record) {
    const mmsi = String(record?.mmsi || '').trim();
    if (mmsi) return `vessel:${mmsi}`;
    const name = String(record?.name || 'VESSEL').trim() || 'VESSEL';
    const lat = Number.isFinite(record?.lat) ? record.lat.toFixed(5) : 'x';
    const lon = Number.isFinite(record?.lon) ? record.lon.toFixed(5) : 'x';
    return `vessel:unkeyed:${name}:${lat}:${lon}`;
  }

  /** Uppercased, card-width-bounded AIS type (empty string when unknown). */

  function vesselTypeShort(record) {
    return normalizeVesselType(record.type).toUpperCase().slice(0, 14);
  }

  /**
   * True when `screen` is at least `minSepPx` away from every accepted screen
   * position (greedy card-declutter accept test, mirroring the FIRMS pass).
   * Exported for unit tests.
   * @param {Array<{x: number, y: number}>} accepted - Accepted card positions.
   * @param {{x: number, y: number}} screen - Candidate window coordinates.
   * @param {number} minSepPx - Minimum separation in pixels.
   * @returns {boolean}
   */

  function cardScreenSeparated(accepted, screen, minSepPx) {
    const minSq = minSepPx * minSepPx;
    for (let i = 0; i < accepted.length; i += 1) {
      const dx = screen.x - accepted[i].x;
      const dy = screen.y - accepted[i].y;
      if (dx * dx + dy * dy < minSq) return false;
    }
    return true;
  }

  function displayVesselName(record) {
    const name = String(record.name || '').trim();
    if (name && name !== 'VESSEL' && name !== record.mmsi) return name;
    const isAprs = Boolean(
      record?.reference?.startsWith('aprs:') || record?.telemetry,
    );
    if (isAprs && record.mmsi) return record.mmsi;
    return record.mmsi ? `MMSI ${record.mmsi}` : 'VESSEL';
  }

  function formatSpeed(speed) {
    return speed === null ? '--KT' : `${speed.toFixed(1)}KT`;
  }

  function formatHeading(heading) {
    return Number.isFinite(heading) ? `${Math.round(heading)}DEG` : '--DEG';
  }

  function formatPositionTime(record) {
    if (!record.lastPositionUtc) return 'POS: LIVE';
    const date = new Date(record.lastPositionUtc);
    if (Number.isNaN(date.getTime())) return 'POS: LIVE';
    return `POS: ${date.toISOString().slice(11, 19)}Z`;
  }
  return {
    updateSelectedVesselHud,
    resetSelectedVesselHud,
    trimHudValue,
    buildVesselCard,
    buildSelectedVesselCard,
    vesselOverlayEntryId,
    vesselTypeShort,
    cardScreenSeparated,
    displayVesselName,
    formatSpeed,
    formatHeading,
    formatPositionTime,
    formatTelemetry,
    formatTelemetrySummary,
    formatHudTelemetry,
  };
}
