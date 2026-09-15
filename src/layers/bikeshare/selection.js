import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
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
      (record?.stationId ? `Station ${record.stationId}` : 'Station');
    const bikes = Number.isFinite(record?.bikesAvailable)
      ? record.bikesAvailable
      : '?';
    const docks = Number.isFinite(record?.docksAvailable)
      ? record.docksAvailable
      : '?';
    const capacity = Number.isFinite(record?.capacity) ? record.capacity : '?';

    const lines = [
      stationLabel,
      `🚲 ${bikes} avail · ${docks} docks · ${capacity} cap`,
    ];

    // Append warnings for stations that are offline or partially non-operational
    const abnormal = [];
    if (record?.isInstalled === false) abnormal.push('⚠️ Not installed');
    if (record?.isRenting === false) abnormal.push('⚠️ Not renting');
    if (record?.isReturning === false) abnormal.push('⚠️ Not returning');
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
    const position = record?.point?.position;
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
   * Re-shows the hidden point primitive and removes the highlight entity.
   */

  function _clearSelection() {
    if (layerState._selectedKey) {
      const record = layerState._stationRenderMap.get(layerState._selectedKey);
      if (record?.point) {
        record.point.show = true;
      }
    }

    if (layerState._selectedEntity && layerState._viewer) {
      layerState._viewer.entities.remove(layerState._selectedEntity);
    }

    layerState._selectedKey = null;
    layerState._selectedEntity = null;
    layerState._overlayHost.clearSource(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID);
  }

  /**
   * Select a station by key: hides the original point primitive and adds a
   * highlighted cyan entity plus a protected shared-host availability card.
   * @param {string} key - Composite "cityId:stationId" key.
   */

  function _selectStation(key) {
    _clearSelection();

    const record = layerState._stationRenderMap.get(key);
    if (!record || !record.point?.position || !layerState._viewer) return;

    layerState._selectedKey = key;
    // Hide the base point so the highlight entity replaces it visually
    record.point.show = false;

    layerState._selectedEntity = layerState._viewer.entities.add({
      position: record.point.position,
      point: {
        pixelSize: 14,
        color: Cesium.Color.CYAN,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
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
   * @param {Cesium.Viewer} viewer - Cesium viewer instance.
   */

  function _installClickHandler(viewer) {
    if (layerState._clickHandler) return;

    layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    layerState._clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);

      if (picked) {
        // Clicking selected entity itself — ignore (don't deselect).
        if (picked.id === layerState._selectedEntity) return;

        // Check if the picked primitive or entity id matches a station key
        const primitive = picked.primitive;
        if (
          primitive &&
          typeof primitive.id === 'string' &&
          layerState._stationRenderMap.has(primitive.id)
        ) {
          _selectStation(primitive.id);
          return;
        }
        if (
          typeof picked.id === 'string' &&
          layerState._stationRenderMap.has(picked.id)
        ) {
          _selectStation(picked.id);
          return;
        }
      }

      // Clicked empty space — deselect.
      if (layerState._selectedKey) _clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

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
