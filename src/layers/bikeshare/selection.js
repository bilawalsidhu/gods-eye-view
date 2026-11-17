import { t } from '../../i18n/index.js';
import { inputFor } from '../../input/dispatcher.js';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  SELECTED_POINT_STYLE,
} from './policy.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Build a multi-line text label for the selected station popup.
   * Shows station name, availability counts, and any abnormal operational flags.
   * @param {Object} record - Render record from _stationRenderMap.
   * @returns {string} Newline-delimited source text for the selected host card.
   */

  function buildSelectionLabel(record) {
    const stationName = String(record?.stationName || '').trim();
    const stationLabel =
      stationName ||
      (record?.stationId
        ? t('Station {id}', { id: record.stationId })
        : t('Station'));
    const bikes = Number.isFinite(record?.bikesAvailable)
      ? record.bikesAvailable
      : '?';
    const docks = Number.isFinite(record?.docksAvailable)
      ? record.docksAvailable
      : '?';
    const capacity = Number.isFinite(record?.capacity) ? record.capacity : '?';

    const lines = [
      stationLabel,
      t('🚲 {bikes} avail · {docks} docks · {capacity} cap', {
        bikes,
        docks,
        capacity,
      }),
    ];

    // Append warnings for stations that are offline or partially non-operational
    const abnormal = [];
    if (record?.isInstalled === false) abnormal.push(t('⚠️ Not installed'));
    if (record?.isRenting === false) abnormal.push(t('⚠️ Not renting'));
    if (record?.isReturning === false) abnormal.push(t('⚠️ Not returning'));
    if (abnormal.length > 0) {
      lines.push(abnormal.join(' · '));
    }

    return lines.join('\n');
  }

  /**
   * Build the protected selected-station entry from source-owned copy.
   * @param {string} key Stable city/station composite key.
   * @param {Object} record Bikeshare render record.
   * @returns {Object|null}
   */

  function createBikeshareSelectedOverlayEntry(key, record) {
    const position = record?.position;
    if (!key || !position) return null;
    const [title, ...details] = buildSelectionLabel(record).split('\n');
    return {
      id: String(key),
      position,
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER,
      title,
      details,
      accent: '#00ffff',
      interactive: false,
      anchorRadiusPx: 9,
      minAnchorGapPx: 11,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    };
  }

  /**
   * Clear the current station selection.
   * Shows the station's own dot again and removes the highlight.
   */

  function _clearSelection() {
    const key = layerState._selectedKey;
    layerState._selectedKey = null;
    const record = key ? layerState._stationRenderMap.get(key) : null;
    if (record?.position)
      layerState._stationSet?.upsert([parts.rendering.stationItem(record)]);
    if (layerState._selectedSet?.size()) layerState._selectedSet.clear();
    layerState._overlayHost.clearSource(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID);
  }

  /**
   * Select a station by key: hides its own dot and draws a highlighted cyan
   * one in its place, plus a protected shared-host availability card.
   * @param {string} key - Composite "cityId:stationId" key.
   */

  function _selectStation(key) {
    _clearSelection();

    const record = layerState._stationRenderMap.get(key);
    if (!record || !record.position || !layerState._stationSet) return;

    layerState._selectedKey = key;
    // Hide the base dot so the highlight replaces it visually
    layerState._stationSet.upsert([parts.rendering.stationItem(record)]);
    layerState._selectedSet?.set([
      { id: 'selected', pos: record.position, ...SELECTED_POINT_STYLE },
    ]);
    const entry = createBikeshareSelectedOverlayEntry(key, record);
    if (entry) {
      layerState._overlayHost.setEntries(
        BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
        [entry],
        BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
    }
  }

  /**
   * Install a screen-space click handler for station selection/deselection.
   * Also registers a global keydown listener for Escape-to-deselect.
   * Idempotent — does nothing if a handler is already installed.
   * @param {object} viewer - The viewer the layer draws on.
   */

  function _installClickHandler(viewer) {
    if (layerState._clickSubscription) return;

    layerState._clickSubscription = inputFor(viewer).onClick((event) => {
      const hit = event.drawHit;

      if (hit) {
        // Clicking the selected highlight itself — ignore (don't deselect).
        if (hit.set === layerState._selectedSet?.id) return;

        // A station dot of this layer's own set
        if (
          hit.set === layerState._stationSet?.id &&
          layerState._stationRenderMap.has(hit.id)
        ) {
          _selectStation(hit.id);
          return;
        }
      }

      // Clicked anything else — deselect.
      if (layerState._selectedKey) _clearSelection();
    });

    document.addEventListener('keydown', _onKeyDown);
  }

  /**
   * Global keydown handler — deselects the current station on Escape.
   * @param {KeyboardEvent} e - Keyboard event.
   */

  function _onKeyDown(e) {
    if (e.key === 'Escape' && layerState._selectedKey) {
      _clearSelection();
    }
  }
  return {
    buildSelectionLabel,
    createBikeshareSelectedOverlayEntry,
    _clearSelection,
    _selectStation,
    _installClickHandler,
    _onKeyDown,
  };
}
