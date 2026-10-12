import * as Cesium from 'cesium';
import { haversineDistanceMeters } from '../geo/distance.js';
import {
  publishMyLocationState,
  readMyLocationState,
  resetMyLocationState,
} from '../myLocationState.js';

const GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  maximumAge: 15_000,
  timeout: 12_000,
});
const ENTITY_ID = 'my-location';
const MARKER_HEIGHT_M = 1.5;
const MIN_RECENTER_RANGE_M = 1_800;
const MAX_RECENTER_RANGE_M = 9_000;
const RECENTER_PITCH_DEG = -45;

function normalizePosition(position) {
  const coords = position?.coords;
  if (!coords) return null;
  return {
    latitude: Number(coords.latitude),
    longitude: Number(coords.longitude),
    accuracy: Number(coords.accuracy),
    altitude: Number.isFinite(coords.altitude) ? Number(coords.altitude) : null,
    altitudeAccuracy: Number.isFinite(coords.altitudeAccuracy)
      ? Number(coords.altitudeAccuracy)
      : null,
    heading: Number.isFinite(coords.heading) ? Number(coords.heading) : null,
    speed: Number.isFinite(coords.speed) ? Number(coords.speed) : null,
    timestamp: Number.isFinite(position.timestamp)
      ? position.timestamp
      : Date.now(),
  };
}

function meaningfulLocationChange(previous, next) {
  if (!previous || !next) return true;
  const movedM = haversineDistanceMeters(
    previous.latitude,
    previous.longitude,
    next.latitude,
    next.longitude,
  );
  const accuracyDeltaM = Math.abs(
    (previous.accuracy || 0) - (next.accuracy || 0),
  );
  const movementThresholdM = Math.max(
    8,
    Math.min(previous.accuracy || 40, next.accuracy || 40, 40) * 0.25,
  );
  return movedM >= movementThresholdM || accuracyDeltaM >= 10;
}

function errorState(error) {
  switch (error?.code) {
    case 1:
      return {
        enabled: false,
        status: 'denied',
        message:
          'Location permission is blocked. Allow it in your browser, then try ON again.',
        errorCode: 'permission-denied',
      };
    case 2:
      return {
        enabled: true,
        status: 'unavailable',
        message:
          'Current location unavailable. Check location services and try again.',
        errorCode: 'position-unavailable',
      };
    case 3:
      return {
        enabled: true,
        status: 'timeout',
        message:
          'Location fix timed out. Move to a clearer signal area and try again.',
        errorCode: 'timeout',
      };
    default:
      return {
        enabled: true,
        status: 'error',
        message:
          'Location updates failed. Toggle My Location off and on to retry.',
        errorCode: 'watch-error',
      };
  }
}

export class MyLocationController {
  constructor({
    viewer,
    render = {},
    geolocation = globalThis.navigator?.geolocation ?? null,
    eventTarget = globalThis.window ?? null,
  } = {}) {
    this.viewer = viewer;
    this.render = render;
    this.geolocation = geolocation;
    this.eventTarget = eventTarget;
    this.watchId = null;
    this.dataSource = new Cesium.CustomDataSource('my-location');
    this.viewer?.dataSources?.add?.(this.dataSource);
    this.hasInitialFix = false;
    this._boundUnload = () => this.disable();
    this.eventTarget?.addEventListener?.('pagehide', this._boundUnload);
    this.eventTarget?.addEventListener?.('beforeunload', this._boundUnload);
    const initialState = readMyLocationState();
    if (initialState?.status === 'ready' && initialState.position) {
      this.hasInitialFix = true;
      this._updateEntity(initialState.position);
    }
    if (initialState?.enabled) this._resumeWatch();
  }

  _requestRender(reason = 'my-location') {
    this.render.governorRequestRender?.(reason);
  }

  _clearWatch() {
    if (this.watchId === null) return;
    this.geolocation?.clearWatch?.(this.watchId);
    this.watchId = null;
  }

  _clearEntities() {
    this.dataSource?.entities?.removeAll?.();
    this._requestRender('my-location-clear');
  }

  _publish(nextState, change) {
    publishMyLocationState(nextState, change);
    this._requestRender('my-location-state');
  }

  _resumeWatch() {
    if (
      this.watchId !== null ||
      !this.geolocation ||
      typeof this.geolocation.watchPosition !== 'function'
    )
      return false;
    this.watchId = this.geolocation.watchPosition(
      (position) => this._handleSuccess(position),
      (error) => this._handleError(error),
      GEOLOCATION_OPTIONS,
    );
    return true;
  }

  _updateEntity(position) {
    const accuracyM = Math.max(1, Number(position?.accuracy) || 0);
    this.dataSource.entities.removeAll();
    this.dataSource.entities.add({
      id: ENTITY_ID,
      position: Cesium.Cartesian3.fromDegrees(
        position.longitude,
        position.latitude,
        MARKER_HEIGHT_M,
      ),
      point: {
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString('#00d4ff'),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.98),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      ellipse: {
        semiMajorAxis: accuracyM,
        semiMinorAxis: accuracyM,
        height: 0,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.14),
        outline: true,
        outlineColor:
          Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.34),
        outlineWidth: 1,
      },
    });
    this._requestRender('my-location-entity');
  }

  _recenterTo(position, duration = 1.8) {
    if (!position || !this.viewer?.camera) return false;
    const accuracyM = Math.max(100, Number(position.accuracy) || 0);
    const heading = Number.isFinite(this.viewer.camera.heading)
      ? this.viewer.camera.heading
      : 0;
    this.viewer.camera.cancelFlight?.();
    this.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, 0),
        accuracyM,
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          heading,
          Cesium.Math.toRadians(RECENTER_PITCH_DEG),
          Cesium.Math.clamp(
            accuracyM * 8,
            MIN_RECENTER_RANGE_M,
            MAX_RECENTER_RANGE_M,
          ),
        ),
        duration,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      },
    );
    return true;
  }

  _handleSuccess(rawPosition) {
    const position = normalizePosition(rawPosition);
    if (!position) return;
    const previous = readMyLocationState().position;
    if (!this.hasInitialFix || meaningfulLocationChange(previous, position)) {
      this._updateEntity(position);
      this._publish(
        {
          enabled: true,
          status: 'ready',
          message: '',
          errorCode: null,
          position,
        },
        { type: this.hasInitialFix ? 'update' : 'fix' },
      );
    } else if (readMyLocationState().status !== 'ready') {
      this._publish(
        {
          enabled: true,
          status: 'ready',
          message: '',
          errorCode: null,
          position: previous,
        },
        { type: 'status' },
      );
    }
    if (!this.hasInitialFix) {
      this.hasInitialFix = true;
      this._recenterTo(position);
    }
  }

  _handleError(error) {
    const nextState = errorState(error);
    this._clearEntities();
    if (nextState.enabled === false) {
      this._clearWatch();
      this.hasInitialFix = false;
    }
    this._publish(nextState, { type: 'error', code: nextState.errorCode });
  }

  enable() {
    if (this.watchId !== null) return true;
    if (
      !this.geolocation ||
      typeof this.geolocation.watchPosition !== 'function'
    ) {
      this._publish(
        {
          enabled: false,
          status: 'unsupported',
          message: 'This browser does not expose location services.',
          errorCode: 'unsupported',
          position: null,
        },
        { type: 'unsupported' },
      );
      return false;
    }
    this.hasInitialFix = false;
    this._publish(
      {
        enabled: true,
        status: 'requesting',
        message: 'Awaiting browser location permission…',
        errorCode: null,
        position: readMyLocationState().position,
      },
      { type: 'enable' },
    );
    try {
      return this._resumeWatch();
    } catch (error) {
      this._handleError(error);
      return false;
    }
  }

  disable() {
    this._clearWatch();
    this.hasInitialFix = false;
    this._clearEntities();
    resetMyLocationState({ type: 'disable' });
    return true;
  }

  recenter() {
    const position = readMyLocationState().position;
    if (!position) return false;
    return this._recenterTo(position, 1.4);
  }

  destroy() {
    this._clearWatch();
    this.hasInitialFix = false;
    this._clearEntities();
    this.eventTarget?.removeEventListener?.('pagehide', this._boundUnload);
    this.eventTarget?.removeEventListener?.('beforeunload', this._boundUnload);
    if (this.viewer && this.dataSource)
      this.viewer.dataSources?.remove?.(this.dataSource, true);
    this.dataSource = null;
  }
}
