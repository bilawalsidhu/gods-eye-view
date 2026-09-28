import {
  accentForVesselType,
  normalizeVesselType,
} from '../../data/vesselLabels.js';

/** Public vessel register the selected-vessel card links out to. */
export const VESSEL_LISTING_LABEL = 'VESSELFINDER';
/** Hotkey that opens the selected vessel's listing (case-insensitive). */
export const VESSEL_LISTING_KEY = 'L';
const VESSEL_LISTING_BASE_URL = 'https://www.vesselfinder.com/vessels/details/';

/**
 * VesselFinder listing URL for one AIS record, keyed by its 9-digit MMSI.
 * Pure — exported for unit tests. Returns null for unkeyed or malformed ids so
 * callers never open a page that cannot resolve to one hull.
 * @param {Object} record - Vessel record.
 * @returns {string|null}
 */
export function vesselListingUrl(record) {
  const mmsi = String(record?.mmsi || '').trim();
  if (!/^\d{9}$/.test(mmsi)) return null;
  return `${VESSEL_LISTING_BASE_URL}${mmsi}`;
}

export function createCards({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  // HUD readouts that already forward clicks to the listing opener.
  const hudListingBound = new WeakSet();

  /** True when the host supplied a way to open external pages. */
  function canOpenListing() {
    return typeof services?.openExternal === 'function';
  }

  /**
   * Open the VesselFinder listing for `record` (default: the selected vessel)
   * in a new tab. Inert without an MMSI or without an `openExternal` service.
   * @param {Object} [record] - Vessel record; defaults to the selection.
   * @returns {boolean} True when a page was opened.
   */
  function openSelectedVesselListing(record = state.selectedRecord) {
    const url = vesselListingUrl(record);
    if (!url || !canOpenListing()) return false;
    services.openExternal(url);
    return true;
  }

  function listingAvailable(record) {
    return canOpenListing() && vesselListingUrl(record) !== null;
  }

  function bindHudListingClick(el) {
    if (hudListingBound.has(el) || typeof el.addEventListener !== 'function')
      return;
    el.addEventListener('click', () => {
      openSelectedVesselListing();
    });
    hudListingBound.add(el);
  }

  function updateSelectedVesselHud(record) {
    const el = document.getElementById('hud-ais-vessel');
    if (!el) return;

    // Pinned vessels missing from recent refreshes get a stale marker
    const stale = (record.missedRefreshes || 0) > 0;
    const listing = listingAvailable(record);
    el.classList.add('active');
    el.classList.toggle?.('has-listing', listing);
    const lines = [
      `AIS: ${trimHudValue(record.name, 32)}`,
      `${trimHudValue(record.type || 'VESSEL', 24)}  SPD: ${formatSpeed(record.speed)}  HDG: ${formatHeading(record.heading ?? record.course)}`,
      `MMSI: ${record.mmsi || '--'}  ${formatPositionTime(record)}${stale ? '  · STALE' : ''}`,
    ];
    if (listing) {
      lines.push(`↗ ${VESSEL_LISTING_LABEL} (${VESSEL_LISTING_KEY})`);
      el.title = `Open ${displayVesselName(record)} on VesselFinder`;
      bindHudListingClick(el);
    } else {
      el.title = '';
    }
    el.textContent = lines.join('\n');
  }

  function resetSelectedVesselHud() {
    const el = document.getElementById('hud-ais-vessel');
    if (!el) return;
    el.classList.remove('active');
    el.classList.remove('has-listing');
    el.title = '';
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
    details.push(
      `MMSI ${record.mmsi || '--'} · ${formatPositionTime(record)}${stale ? ' · STALE' : ''}`,
    );
    // Listing click-through: the L key (or the HUD readout) opens VesselFinder.
    if (listingAvailable(record))
      details.push(`↗ ${VESSEL_LISTING_LABEL} · ${VESSEL_LISTING_KEY}`);
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
    openSelectedVesselListing,
    vesselListingUrl,
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
  };
}
