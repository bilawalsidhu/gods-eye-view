import * as Cesium from 'cesium';
import { civilAircraftModelSpec } from './modelSpec.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import { isEmergency } from '../../data/aircraftEmergency.js';
import {
  MIL_TINT,
  EMERGENCY_TINT,
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
   *  amber for known-military, white otherwise.
   *  Ground traffic gets NO special tint (owner verdict 2026-07-03 field test). */

  function _fleetBillboardColor(
    icao24,
    info = flightState.records.data.get(icao24),
  ) {
    if (_isEmergency(icao24, info)) return EMERGENCY_TINT;
    return isMilitaryIcao(icao24) ? MIL_TINT : Cesium.Color.WHITE;
  }

  /** Cockpit far-contact dot tint: the emergency red outranks the category tint. */

  function _cockpitContactColor(
    icao24,
    info = flightState.records.data.get(icao24),
  ) {
    if (_isEmergency(icao24, info)) return EMERGENCY_TINT;
    return isMilitaryIcao(icao24) ? MIL_TINT : COCKPIT_CIVILIAN_COLOR;
  }

  /** Fleet billboard scale: per-class scale, ×GROUND_SCALE while grounded. */

  function _fleetBillboardScale(icao24, klass) {
    return (
      (CLASS_SCALE_2D[klass] || 1) *
      (flightState.records.data.get(icao24)?.onGround ? GROUND_SCALE : 1)
    );
  }

  function _modelSpec(klass) {
    const cached = flightState._specCache.get(klass);
    if (cached) return cached;
    const spec = civilAircraftModelSpec(klass);
    flightState._specCache.set(klass, spec);
    return spec;
  }

  /** Sprite kind for one contact's billboard. Identity for every aircraft except
   *  the ones the operator converted into a TR-3B (Easter egg), which draw the
   *  black-triangle glyph — its thermal-reactive variant while an IR style owns
   *  the scene. Routing EVERY `aircraftIcon()` call through this is what makes a
   *  conversion survive the poll reconciler and the two-tier raster swap. */

  const _iconKind = (icao24, klass) =>
    tr3bIconKind(icao24, klass, { hot: flightState._irBoost });

  /** Model tint, mirroring the billboard color rules. */

  function _modelColor(icao24) {
    if (icao24 === flightState._trackedIcao) return Cesium.Color.CYAN;
    return _fleetBillboardColor(icao24);
  }

  const models = createAircraftModels({
    state: flightState,
    services,
    parts,
    resolveAsset,
    logLabel: 'Data:Flights',
    policy,
    modelSpec: _modelSpec,
    modelColor: _modelColor,
    // About to render in 3D: jump the ambient type-enrichment backlog.
    onModelEligible: (icao24) =>
      parts.enrichment._requestTypeEnrichment(icao24, true),
    afterReplan: (renderTime, tau, nowMs, camera) =>
      parts.icons._floorGroundedIcons(
        renderTime,
        tau,
        nowMs,
        camera.positionWC,
      ),
  });

  return {
    _fleetBillboardColor,
    _fleetBillboardScale,
    _cockpitContactColor,
    _modelSpec,
    _iconKind,
    _modelColor,
    ...models,
  };
}
