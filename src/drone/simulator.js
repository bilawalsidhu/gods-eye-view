import { headingDegrees, interpolateGeodesic } from './geodesy.js';

export const MISSION_STATES = Object.freeze([
  'draft',
  'ready',
  'takeoff',
  'climb',
  'cruise',
  'descent',
  'paused',
  'aborted',
  'arrived',
  'landed',
]);

function positiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

function nonnegativeFinite(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function assertProfile(profile) {
  if (!profile?.vertices || !Array.isArray(profile.vertices) || profile.vertices.length < 2
    || !Number.isFinite(profile.totalLengthMeters) || profile.totalLengthMeters <= 0) {
    throw new TypeError('a valid terrain-aware profile is required');
  }
  return profile;
}

function intervalAtDistance(profile, distance) {
  const vertices = profile.vertices;
  if (distance <= 0) return { from: vertices[0], to: vertices[1], fraction: 0 };
  if (distance >= profile.totalLengthMeters) {
    return { from: vertices.at(-2), to: vertices.at(-1), fraction: 1 };
  }
  let low = 1;
  let high = vertices.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (vertices[middle].cumulativeDistanceMeters < distance) low = middle + 1;
    else high = middle;
  }
  const to = vertices[low];
  const from = vertices[low - 1];
  const length = to.cumulativeDistanceMeters - from.cumulativeDistanceMeters;
  return { from, to, fraction: length > 0 ? (distance - from.cumulativeDistanceMeters) / length : 0 };
}

export function interpolateProfilePosition(profile, distanceMeters) {
  assertProfile(profile);
  if (!Number.isFinite(distanceMeters)) throw new TypeError('distanceMeters must be finite');
  const distance = Math.min(profile.totalLengthMeters, Math.max(0, distanceMeters));
  const interval = intervalAtDistance(profile, distance);
  const horizontal = interpolateGeodesic(interval.from, interval.to, interval.fraction);
  const altitudeMsl = interval.from.altitudeMsl
    + (interval.to.altitudeMsl - interval.from.altitudeMsl) * interval.fraction;
  const terrainHeightMsl = interval.from.terrainHeightMsl
    + (interval.to.terrainHeightMsl - interval.from.terrainHeightMsl) * interval.fraction;
  return Object.freeze({
    latitude: horizontal.latitude,
    longitude: horizontal.longitude,
    altitudeMsl,
    terrainHeightMsl,
    aglMeters: altitudeMsl - terrainHeightMsl,
    headingDegrees: headingDegrees(interval.from, interval.to),
    routeSegmentIndex: interval.to.routeSegmentIndex,
  });
}

export class DroneMissionSimulator {
  constructor({
    profile = null,
    groundSpeedMps = profile?.groundSpeedMps ?? 15,
    playbackSpeed = 1,
    takeoffDurationSeconds = 2,
    arrivalHoldSeconds = 1,
    phaseRateEpsilonMps = 0.05,
  } = {}) {
    positiveFinite(groundSpeedMps, 'groundSpeedMps');
    positiveFinite(playbackSpeed, 'playbackSpeed');
    nonnegativeFinite(takeoffDurationSeconds, 'takeoffDurationSeconds');
    nonnegativeFinite(arrivalHoldSeconds, 'arrivalHoldSeconds');
    nonnegativeFinite(phaseRateEpsilonMps, 'phaseRateEpsilonMps');
    this.profile = profile == null ? null : assertProfile(profile);
    this.groundSpeedMps = groundSpeedMps;
    this.playbackSpeed = playbackSpeed;
    this.takeoffDurationSeconds = takeoffDurationSeconds;
    this.arrivalHoldSeconds = arrivalHoldSeconds;
    this.phaseRateEpsilonMps = phaseRateEpsilonMps;
    this.elapsedSeconds = 0;
    this.state = this.profile ? 'ready' : 'draft';
    this.running = false;
  }

  loadProfile(profile) {
    this.profile = assertProfile(profile);
    this.elapsedSeconds = 0;
    this.state = 'ready';
    this.running = false;
    return this.getTelemetry();
  }

  setPlaybackSpeed(playbackSpeed) {
    this.playbackSpeed = positiveFinite(playbackSpeed, 'playbackSpeed');
    return this.playbackSpeed;
  }

  launch() {
    if (this.state !== 'ready') throw new Error(`cannot launch from ${this.state}`);
    this.running = true;
    this.state = this.takeoffDurationSeconds > 0 ? 'takeoff' : this.#phaseAtDistance(0);
    return this.getTelemetry();
  }

  pause() {
    if (!this.running || !['takeoff', 'climb', 'cruise', 'descent'].includes(this.state)) {
      throw new Error(`cannot pause from ${this.state}`);
    }
    this.running = false;
    this.state = 'paused';
    return this.getTelemetry();
  }

  resume() {
    if (this.state !== 'paused') throw new Error(`cannot resume from ${this.state}`);
    this.running = true;
    this.state = this.#stateAtElapsed();
    return this.getTelemetry();
  }

  abort() {
    if (!['ready', 'takeoff', 'climb', 'cruise', 'descent', 'paused', 'arrived'].includes(this.state)) {
      throw new Error(`cannot abort from ${this.state}`);
    }
    this.running = false;
    this.state = 'aborted';
    return this.getTelemetry();
  }

  reset() {
    this.elapsedSeconds = 0;
    this.running = false;
    this.state = this.profile ? 'ready' : 'draft';
    return this.getTelemetry();
  }

  replay() {
    if (!this.profile) throw new Error('cannot replay without a profile');
    this.reset();
    return this.launch();
  }

  tick(realDeltaSeconds) {
    nonnegativeFinite(realDeltaSeconds, 'realDeltaSeconds');
    if (!this.running || realDeltaSeconds === 0) return this.getTelemetry();
    this.elapsedSeconds = Math.min(
      this.#landedAtSeconds(),
      this.elapsedSeconds + realDeltaSeconds * this.playbackSpeed,
    );
    this.state = this.#stateAtElapsed();
    if (this.state === 'landed') this.running = false;
    return this.getTelemetry();
  }

  getTelemetry() {
    if (!this.profile) {
      return Object.freeze({
        missionState: this.state,
        simulationTimeSeconds: this.elapsedSeconds,
        playbackSpeed: this.playbackSpeed,
      });
    }
    const distanceFlown = this.#distanceAtElapsed();
    const position = interpolateProfilePosition(this.profile, distanceFlown);
    const activeFlight = ['climb', 'cruise', 'descent'].includes(this.state);
    return Object.freeze({
      latitude: position.latitude,
      longitude: position.longitude,
      altitudeMsl: position.altitudeMsl,
      altitudeAgl: position.aglMeters,
      terrainHeightMsl: position.terrainHeightMsl,
      headingDegrees: position.headingDegrees,
      groundSpeedMps: activeFlight ? this.groundSpeedMps : 0,
      distanceFlownMeters: distanceFlown,
      distanceRemainingMeters: Math.max(0, this.profile.totalLengthMeters - distanceFlown),
      etaSeconds: this.#etaSeconds(distanceFlown),
      currentSegment: position.routeSegmentIndex,
      missionState: this.state,
      simulationTimeSeconds: this.elapsedSeconds,
      playbackSpeed: this.playbackSpeed,
    });
  }

  #flightDurationSeconds() {
    return this.profile.totalLengthMeters / this.groundSpeedMps;
  }

  #arrivedAtSeconds() {
    return this.takeoffDurationSeconds + this.#flightDurationSeconds();
  }

  #landedAtSeconds() {
    return this.#arrivedAtSeconds() + this.arrivalHoldSeconds;
  }

  #distanceAtElapsed() {
    const flightElapsed = Math.max(0, this.elapsedSeconds - this.takeoffDurationSeconds);
    return Math.min(this.profile.totalLengthMeters, flightElapsed * this.groundSpeedMps);
  }

  #phaseAtDistance(distance) {
    const interval = intervalAtDistance(this.profile, distance);
    const horizontalDistance = interval.to.cumulativeDistanceMeters
      - interval.from.cumulativeDistanceMeters;
    const verticalRate = horizontalDistance > 0
      ? (interval.to.altitudeMsl - interval.from.altitudeMsl)
        * this.groundSpeedMps / horizontalDistance
      : 0;
    if (verticalRate > this.phaseRateEpsilonMps) return 'climb';
    if (verticalRate < -this.phaseRateEpsilonMps) return 'descent';
    return 'cruise';
  }

  #stateAtElapsed() {
    if (this.elapsedSeconds < this.takeoffDurationSeconds) return 'takeoff';
    if (this.elapsedSeconds < this.#arrivedAtSeconds()) {
      return this.#phaseAtDistance(this.#distanceAtElapsed());
    }
    if (this.elapsedSeconds < this.#landedAtSeconds()) return 'arrived';
    return 'landed';
  }

  #etaSeconds(distanceFlown) {
    if (this.state === 'draft' || this.state === 'aborted') return null;
    if (this.state === 'arrived' || this.state === 'landed') return 0;
    const takeoffRemaining = Math.max(0, this.takeoffDurationSeconds - this.elapsedSeconds);
    return takeoffRemaining + (this.profile.totalLengthMeters - distanceFlown) / this.groundSpeedMps;
  }
}
