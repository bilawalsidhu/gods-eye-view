import {
  CLASS_MODEL_REAL,
  CLASS_SCALE_3D,
  CLASS_SCALE_2D,
} from '../../data/aircraftClass.js';
import {
  visualCenterForModel,
  trailAnchorForModel,
} from '../../data/modelVisualAnchor.js';
import { isEmergency } from '../../data/aircraftEmergency.js';
import {
  PLANE_MODEL_SCALE,
  PLANE_MODEL_URL,
  PLANE_NATIVE_RADIUS_M,
  PLANE_BELLY_OFFSET_NATIVE,
  MODEL_SCALE,
  JET_MODEL_URL,
  MODEL_NATIVE_RADIUS_M,
  MODEL_BELLY_OFFSET_NATIVE,
  MODEL_HEADING_OFFSET_DEG,
  BILLBOARD_SCALE,
  GROUND_SCALE,
  MIL_ICON_COLOR,
  TRACKED_ICON_COLOR,
  EMERGENCY_ICON_COLOR,
  MODEL_COLOR_BLEND_AMOUNT,
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

  function _modelSpec(klass) {
    let spec = flightState._specCache.get(klass);
    if (spec) return spec;
    const real = CLASS_MODEL_REAL[klass];
    if (real) {
      spec = {
        url: real.url,
        scale: 1,
        nativeRadiusM: real.radiusM,
        bellyM: real.bellyM,
        headingOffsetDeg: 180,
        blendAmount: MODEL_COLOR_BLEND_AMOUNT,
        visualCenterNative: visualCenterForModel(real.url),
        trailAnchorNative: trailAnchorForModel(real.url),
      };
    } else if (
      klass === 'airliner' ||
      klass === 'quadjet' ||
      klass === 'glider'
    ) {
      const scale = PLANE_MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
      spec = {
        url: PLANE_MODEL_URL,
        scale,
        nativeRadiusM: PLANE_NATIVE_RADIUS_M,
        bellyM: PLANE_BELLY_OFFSET_NATIVE * scale,
        headingOffsetDeg: 180,
        blendAmount: MODEL_COLOR_BLEND_AMOUNT,
        visualCenterNative: visualCenterForModel(PLANE_MODEL_URL),
        trailAnchorNative: trailAnchorForModel(PLANE_MODEL_URL),
      };
    } else {
      const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
      spec = {
        url: JET_MODEL_URL,
        scale,
        nativeRadiusM: MODEL_NATIVE_RADIUS_M,
        bellyM: MODEL_BELLY_OFFSET_NATIVE * scale,
        headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
        blendAmount: MODEL_COLOR_BLEND_AMOUNT,
        visualCenterNative: visualCenterForModel(JET_MODEL_URL),
        trailAnchorNative: trailAnchorForModel(JET_MODEL_URL),
      };
    }
    flightState._specCache.set(klass, spec);
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

  /** Model tint, mirroring the billboard color rules (amber instead of cyan/white). */

  function _modelColor(icao24) {
    if (icao24 === flightState._trackedIcao) return TRACKED_ICON_COLOR;
    return _fleetBillboardColor(icao24);
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
