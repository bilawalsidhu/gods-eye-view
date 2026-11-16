import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  aircraftLayerModelSpec,
  aircraftModelSpecCacheKey,
} from '../flights/modelSpec.js';
import { isEmergency } from '../../data/aircraftEmergency.js';
import {
  MODEL_HEADING_OFFSET_DEG,
  BILLBOARD_SCALE,
  GROUND_SCALE,
  MIL_ICON_COLOR,
  TRACKED_ICON_COLOR,
  EMERGENCY_ICON_COLOR,
  MODEL_WHITE,
} from './policy.js';
import * as policy from './policy.js';
import { createAircraftModels } from '../../data/aircraftModelLayer.js';

export function createRendering({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { tr3bIconKind } = services.aircraftPresentation;

  /** The fleet model an aircraft draws with, by its type and emitter category
   *  (shared with the flights layer), in this layer's own tint. */
  function _modelSpec(meta) {
    const key = aircraftModelSpecCacheKey(meta);
    let spec = flightState._specCache.get(key);
    if (spec) return spec;
    const base = aircraftLayerModelSpec(meta);
    spec = Object.freeze({
      ...base,
      headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
    });
    // Not cached before the model set loads: the answer changes once it has.
    if (spec.model) flightState._specCache.set(key, spec);
    return spec;
  }

  /** Fleet icon scale: per-class scale, ×GROUND_SCALE while grounded. */

  function _fleetBillboardScale(icao24) {
    const meta = flightState.records.data.get(icao24);
    return (
      BILLBOARD_SCALE *
      (CLASS_SCALE_2D[meta?.klass] || 1) *
      (meta?.onGround ? GROUND_SCALE : 1)
    );
  }

  /** Sprite kind for one contact's icon. Identity for every aircraft except
   *  the ones the operator converted into a TR-3B (Easter egg), which draw the
   *  black-triangle glyph — its thermal-reactive variant while an IR style owns
   *  the scene. Routing EVERY `aircraftIcon()` call through this is what makes a
   *  conversion survive the poll reconciler and the two-tier raster swap. */

  const _iconKind = (icao24, klass) =>
    tr3bIconKind(icao24, klass, { hot: flightState._irBoost });

  /** Model colour: the mesh's own (white), tinted amber while tracked and red
   *  while broadcasting an emergency. */

  function _modelColor(icao24) {
    if (icao24 === flightState._trackedIcao) return TRACKED_ICON_COLOR;
    const info = flightState.records.data.get(icao24);
    return isEmergency(info?.emergency) ? EMERGENCY_ICON_COLOR : MODEL_WHITE;
  }

  /** Fleet (untracked) tint: red while the latest poll broadcast an emergency,
   *  amber otherwise. Cockpit far-contact dots use it too. */

  function _fleetBillboardColor(
    icao24,
    info = flightState.records.data.get(icao24),
  ) {
    return isEmergency(info?.emergency) ? EMERGENCY_ICON_COLOR : MIL_ICON_COLOR;
  }

  /** Cockpit far-contact pips wear the fleet tint. */

  const _cockpitContactColor = _fleetBillboardColor;

  const models = createAircraftModels({
    state: flightState,
    services,
    parts,
    resolveAsset,
    logLabel: 'Data:Military',
    setPrefix: 'military',
    policy,
    modelSpec: _modelSpec,
    modelColor: _modelColor,
  });

  return {
    _modelSpec,
    _fleetBillboardScale,
    _cockpitContactColor,
    _iconKind,
    _modelColor,
    _fleetBillboardColor,
    ...models,
  };
}
