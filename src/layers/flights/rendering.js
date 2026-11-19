import {
  aircraftLayerModelSpec,
  aircraftModelSpecCacheKey,
} from './modelSpec.js';
import { isEmergency } from '../../data/aircraftEmergency.js';
import {
  MIL_TINT,
  EMERGENCY_TINT,
  VEHICLE_TINT,
  FLEET_TINT,
  GROUND_SCALE,
  COCKPIT_CIVILIAN_COLOR,
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
  const { isMilitaryIcao } = services.militaryRegistry;
  const { tr3bIconKind } = services.aircraftPresentation;

  /** True while this contact's latest poll broadcast an emergency code. */

  function _isEmergency(icao24, info = flightState.records.data.get(icao24)) {
    return isEmergency(info?.emergency);
  }

  /** Fleet (untracked) billboard tint: red while broadcasting an emergency,
   *  orange amber for an airport vehicle, amber for known-military, white
   *  otherwise. Grounded aircraft get NO special tint (owner verdict
   *  2026-07-03 field test). */

  function _fleetBillboardColor(
    icao24,
    info = flightState.records.data.get(icao24),
  ) {
    if (_isEmergency(icao24, info)) return EMERGENCY_TINT;
    if (info?.klass === 'vehicle') return VEHICLE_TINT;
    return isMilitaryIcao(icao24) ? MIL_TINT : FLEET_TINT;
  }

  /** Cockpit far-contact dot tint: the emergency red outranks the category tint. */

  function _cockpitContactColor(
    icao24,
    info = flightState.records.data.get(icao24),
  ) {
    if (_isEmergency(icao24, info)) return EMERGENCY_TINT;
    return isMilitaryIcao(icao24) ? MIL_TINT : COCKPIT_CIVILIAN_COLOR;
  }

  /** Fleet billboard scale: one size for every class, ×GROUND_SCALE while grounded. */

  function _fleetBillboardScale(icao24) {
    return flightState.records.data.get(icao24)?.onGround ? GROUND_SCALE : 1;
  }

  /** The fleet model an aircraft draws with, by its type and emitter category. */
  function _modelSpec(meta) {
    const key = aircraftModelSpecCacheKey(meta);
    const cached = flightState._specCache.get(key);
    if (cached) return cached;
    const spec = aircraftLayerModelSpec(meta);
    // Not cached before the model set loads: the answer changes once it has.
    if (spec.model) flightState._specCache.set(key, spec);
    return spec;
  }

  /** Sprite kind for one contact's billboard. Identity for every aircraft except
   *  the ones the operator converted into a TR-3B (Easter egg), which draw the
   *  black-triangle glyph — its thermal-reactive variant while an IR style owns
   *  the scene. Routing EVERY `aircraftIcon()` call through this is what makes a
   *  conversion survive the poll reconciler and the two-tier raster swap. */

  const _iconKind = (icao24, klass) =>
    tr3bIconKind(icao24, klass, { hot: flightState._irBoost });

  /** Model colour: the mesh's own (white), tinted red while broadcasting an
   *  emergency. Tracking never recolours it. */

  function _modelColor(icao24) {
    return _isEmergency(icao24) ? EMERGENCY_TINT : policy.MODEL_WHITE;
  }

  const models = createAircraftModels({
    state: flightState,
    services,
    parts,
    resolveAsset,
    logLabel: 'Data:Flights',
    setPrefix: 'flights',
    policy,
    modelSpec: _modelSpec,
    modelColor: _modelColor,
    // About to render in 3D: jump the ambient type-enrichment backlog.
    onModelEligible: (icao24) =>
      parts.enrichment._requestTypeEnrichment(icao24, true),
    afterReplan: (renderTime, t, nowMs, eye) =>
      parts.icons._floorGroundedIcons(renderTime, t, nowMs, eye),
  });

  /**
   * Sample the rendered mesh under the collected floor cells (see
   * meshFloorSampler.js), leaving this layer's own icon and model sets out
   * of the probe so it cannot land on an aircraft instead of the pavement.
   */
  function _sampleMeshFloor(points, viewerLat, viewerLon) {
    services.meshFloor.sampleMeshFloorCells(flightState._viewer, points, {
      sets: models._groundSampleExclusions().sets,
      viewerLat,
      viewerLon,
    });
  }

  return {
    _sampleMeshFloor,
    _fleetBillboardColor,
    _fleetBillboardScale,
    _cockpitContactColor,
    _modelSpec,
    _iconKind,
    _modelColor,
    ...models,
  };
}
