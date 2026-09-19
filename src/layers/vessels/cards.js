import {
  accentForVesselType,
  normalizeVesselType,
} from '../../data/vesselLabels.js';

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
    el.textContent = [
      `AIS: ${trimHudValue(record.name, 32)}`,
      `${trimHudValue(record.type || 'VESSEL', 24)}  SPD: ${formatSpeed(record.speed)}  HDG: ${formatHeading(record.heading ?? record.course)}`,
      `MMSI: ${record.mmsi || '--'}  ${formatPositionTime(record)}${stale ? '  · STALE' : ''}`,
    ].join('\n');
  }

  function resetSelectedVesselHud() {
    const el = document.getElementById('hud-ais-vessel');
    if (!el) return;
    el.classList.remove('active');
    el.textContent = 'AIS: --';
    const narrative = document.getElementById('hud-ais-narrative');
    if (narrative) {
      narrative.textContent = '';
      narrative.classList.remove('active');
    }
  }

  /**
   * Renders the plain-language account beneath the AIS readout.
   *
   * Arrives asynchronously after selection, so it must tolerate being called
   * for a vessel the operator has already clicked away from — the caller
   * passes the mmsi it was fetched for and a stale one is dropped.
   */
  function setSelectedVesselNarrative(mmsi, payload) {
    const el = document.getElementById('hud-ais-narrative');
    if (!el) return;
    if (!payload || !payload.headline) {
      el.textContent = '';
      el.classList.remove('active');
      return;
    }
    const cargo = payload.cargo ? `CARGO: ${payload.cargo}` : '';
    const origin = payload.origin ? `FROM: ${payload.origin}` : '';
    const lines = [
      payload.headline,
      origin,
      payload.heading,
      cargo,
      payload.why,
    ].filter(Boolean);
    if (payload.caveats?.length) lines.push(`· ${payload.caveats.join(' · ')}`);
    el.dataset.mmsi = String(mmsi || '');
    el.textContent = lines.join('\n');
    el.classList.add('active');
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
    const eta = String(record.eta || '').trim();
    if (destination)
      details.push(
        `→ ${trimHudValue(destination, 24)}${eta ? ` · ETA ${eta}` : ''}`,
      );
    else if (eta) details.push(`ETA ${eta}`);
    const loading = formatLoadState(record);
    if (loading) details.push(loading);
    const status = String(record.navStatusText || '').trim();
    if (status) details.push(trimHudValue(status, 28));
    const registry = formatRegistry(record);
    if (registry) details.push(registry);
    // Sanctions last before the identity line: it is the line that changes
    // what an operator does next, so it must not be pushed off by detail.
    const sanctions = formatSanctions(record);
    if (sanctions) details.push(sanctions);
    const estimate = formatEstimate(record);
    if (estimate) details.push(estimate);
    const stale = (record.missedRefreshes || 0) > 0;
    details.push(
      `MMSI ${record.mmsi || '--'} · ${formatPositionTime(record)}${stale ? ' · STALE' : ''}`,
    );
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
    return record.mmsi ? `MMSI ${record.mmsi}` : 'VESSEL';
  }

  function formatSpeed(speed) {
    return speed === null ? '--KT' : `${speed.toFixed(1)}KT`;
  }

  /**
   * Draught line for the selected card: the measured number always, plus the
   * laden/ballast call only once the vessel's own observed range supports one.
   * Cargo itself is never on the AIS wire — this is the nearest honest proxy.
   */
  function formatLoadState(record) {
    const draught = record.draught;
    if (!Number.isFinite(draught) || draught <= 0) return '';
    const state = String(record.loadState || '').trim();
    const suffix = state && state !== 'UNKNOWN' ? ` · ${state}` : '';
    return `DRAUGHT ${draught.toFixed(1)}M${suffix}`;
  }

  /** Flag state, with the IMO number when the hull broadcasts a valid one. */
  function formatRegistry(record) {
    const flag = String(record.flag || '').trim();
    const imo = String(record.imo || '').trim();
    const parts = [];
    if (flag) parts.push(trimHudValue(flag.toUpperCase(), 18));
    if (imo && record.imoValid !== false) parts.push(`IMO ${imo}`);
    return parts.join(' · ');
  }

  /**
   * Sanctions line. The matched identifier is shown alongside the verdict:
   * an IMO hit is an identity match, a name hit is a coincidence until proven
   * otherwise, and an operator needs to see which one they have.
   */
  function formatSanctions(record) {
    if (!record.sanctioned) return '';
    const programs = String(record.sanctionPrograms || '').trim();
    const confidence = String(record.sanctionConfidence || '').trim();
    const qualifier = confidence === 'IMO' ? '' : ` (${confidence} MATCH)`;
    return trimHudValue(
      `⚠ SANCTIONED${qualifier}${programs ? `: ${programs}` : ''}`,
      36,
    );
  }

  /**
   * Estimate line for a dead-reckoned contact.
   *
   * States plainly that this is not an observation, how old the last real fix
   * is, and — when the vessel fell silent inside an area the feed can still
   * hear — that it went dark rather than out of range.
   */
  function formatEstimate(record) {
    if (!record.estimated) return '';
    const age = formatElapsed(record.estAgeSec);
    const confidence = Number.isFinite(record.estConfidence)
      ? ` ${Math.round(record.estConfidence * 100)}%`
      : '';
    const holding = record.estMoved ? '' : ' HOLDING';
    const gap = record.gapKind === 'DARK' ? ' · ⚠ WENT DARK' : '';
    return trimHudValue(`EST +${age}${confidence}${holding}${gap}`, 36);
  }

  /** Compact elapsed time: "47m", "4h 12m". */
  function formatElapsed(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
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
    setSelectedVesselNarrative,
    trimHudValue,
    buildVesselCard,
    buildSelectedVesselCard,
    vesselOverlayEntryId,
    vesselTypeShort,
    cardScreenSeparated,
    displayVesselName,
    formatSpeed,
    formatHeading,
    formatLoadState,
    formatRegistry,
    formatSanctions,
    formatEstimate,
    formatElapsed,
    formatPositionTime,
  };
}
