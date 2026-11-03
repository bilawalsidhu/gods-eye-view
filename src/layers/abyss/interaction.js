/**
 * Interaction handler for selecting ABYSS deep-sea features (vents, dives, tracks).
 */

import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';

export function createAbyssInteraction({
  viewer,
  screenSpaceEventHandlerFactory = (canvas) =>
    new Cesium.ScreenSpaceEventHandler(canvas),
  onSelect = () => {},
  onDeselect = () => {},
} = {}) {
  let _handler = null;
  let _enabled = false;
  let _selectedRecord = null;

  function init(targetViewer) {
    const v = targetViewer || viewer;
    if (!v?.scene?.canvas) return;

    if (_handler) {
      _handler.destroy();
      _handler = null;
    }

    _handler = screenSpaceEventHandlerFactory(v.scene.canvas);
    _handler.setInputAction((click) => {
      if (!isPointerFree() || !_enabled) return;

      const picked = v.scene.pick(click.position);
      const record = resolvePickedRecord(picked);

      if (record) {
        _selectedRecord = record;
        onSelect(record);
        flyToRecord(v, record);
      } else {
        if (_selectedRecord) {
          _selectedRecord = null;
          onDeselect();
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function resolvePickedRecord(picked) {
    if (!picked) return null;

    const entity = picked.id;
    if (entity?.__gevAbyssRecord) {
      return entity.__gevAbyssRecord;
    }

    const primitive = picked.primitive;
    if (primitive?.__gevAbyssRecord) {
      return primitive.__gevAbyssRecord;
    }

    return null;
  }

  function flyToRecord(v, record) {
    if (
      !v?.camera ||
      !Number.isFinite(record.lon) ||
      !Number.isFinite(record.lat)
    )
      return;

    const altitudeM = Math.max(
      80_000,
      Math.min(300_000, (record.depthM || 2000) * 40),
    );
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        record.lon,
        record.lat,
        altitudeM,
      ),
      duration: 1.5,
    });
  }

  function setEnabled(enabled) {
    _enabled = Boolean(enabled);
    if (!_enabled && _selectedRecord) {
      _selectedRecord = null;
      onDeselect();
    }
  }

  function clearSelection() {
    _selectedRecord = null;
    onDeselect();
  }

  function destroy() {
    if (_handler) {
      _handler.destroy();
      _handler = null;
    }
    _selectedRecord = null;
    _enabled = false;
  }

  return Object.freeze({
    init,
    setEnabled,
    clearSelection,
    destroy,
    getSelectedRecord: () => _selectedRecord,
  });
}
