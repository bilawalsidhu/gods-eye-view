import * as Cesium from 'cesium';
import { WINDOW_DAYS } from './policy.js';

export function createModel({ state: layerState, services, parts, source }) {
  function finiteCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizePayloadFlights(launch) {
    const flights =
      launch.rocket?.payloads ||
      launch.payloads ||
      launch.mission?.payloads ||
      [];
    if (!Array.isArray(flights)) return [];
    return flights.map((flight, index) => {
      const payload = flight.payload || flight;
      return {
        id: String(flight.id || payload.id || `payload-${index}`),
        name: payload.name || flight.name || 'Unnamed payload',
        type: payload.type?.name || flight.type?.name || null,
        manufacturer: payload.manufacturer?.name || null,
        operator: payload.operator?.name || null,
        destination: flight.destination || payload.destination || null,
        amount: Number.isFinite(Number(flight.amount))
          ? Number(flight.amount)
          : 1,
        massKg:
          (typeof payload.mass === 'number' ||
            (typeof payload.mass === 'string' && payload.mass.trim() !== '')) &&
          Number.isFinite(Number(payload.mass)) &&
          Number(payload.mass) >= 0
            ? Number(payload.mass)
            : null,
      };
    });
  }

  function normalizeLanding(stage, fallbackName, category, index) {
    const landing = stage?.landing;
    const location = landing?.landing_location || {};
    const launcher = stage?.launcher || stage?.spacecraft || {};
    const serial = launcher.serial_number || stage?.serial_number || null;
    const stageType = stage?.type?.name || stage?.type || category;
    const attempted = landing?.attempt === true;
    const success = landing?.success;
    const recoveryType = landing?.type?.name || null;
    const launcherStatus = launcher.status?.name || null;
    const status =
      success === true
        ? 'RECOVERED'
        : success === false
          ? 'LOST'
          : attempted
            ? 'RECOVERY ATTEMPT'
            : recoveryType
              ? recoveryType.toUpperCase()
              : launcherStatus
                ? launcherStatus.toUpperCase()
                : 'NO RECOVERY DATA';
    return {
      id: String(stage?.id || landing?.id || `${category}-${index}`),
      category,
      name: [stageType, serial].filter(Boolean).join(' · ') || fallbackName,
      serial,
      reused: stage?.reused === true,
      flightNumber: finiteCoordinate(stage?.launcher_flight_number),
      status,
      attempted,
      success: success === true ? true : success === false ? false : null,
      recoveryType,
      destination:
        location.name || landing?.destination || landing?.type?.name || null,
      description: landing?.description || null,
      downrangeKm: finiteCoordinate(landing?.downrange_distance),
      lat: finiteCoordinate(location.latitude ?? landing?.latitude),
      lon: finiteCoordinate(location.longitude ?? landing?.longitude),
    };
  }

  function normalizeRecoveryStages(launch, payloads) {
    const rocket = launch.rocket || {};
    const launcherStages = Array.isArray(rocket.launcher_stage)
      ? rocket.launcher_stage
      : [];
    const spacecraftStages = Array.isArray(rocket.spacecraft_stage)
      ? rocket.spacecraft_stage
      : [];
    const stages = [
      ...launcherStages.map((stage, index) =>
        normalizeLanding(
          stage,
          `Launcher stage ${index + 1}`,
          'LAUNCHER',
          index,
        ),
      ),
      ...spacecraftStages.map((stage, index) =>
        normalizeLanding(
          stage,
          `Spacecraft stage ${index + 1}`,
          'SPACECRAFT',
          index,
        ),
      ),
    ];
    const payloadFlights = rocket.payloads || launch.payloads || [];
    if (Array.isArray(payloadFlights)) {
      payloadFlights.forEach((flight, index) => {
        if (!flight?.landing) return;
        stages.push(
          normalizeLanding(
            {
              ...flight,
              type: payloads[index]?.type || 'Payload',
              serial_number: payloads[index]?.name,
            },
            payloads[index]?.name || `Payload ${index + 1}`,
            'PAYLOAD',
            index,
          ),
        );
      });
    }
    return stages;
  }

  /**
   * Select a stable marker color from the mission operator and payload name.
   * Labels stay cyan so the layer remains visually coherent.
   * @param {object} launch Normalized launch record.
   * @returns {Cesium.Color}
   */

  function missionMarkerColor(launch) {
    const identity =
      `${launch.provider || ''} ${launch.name || ''} ${launch.missionName || ''}`.toLowerCase();
    if (/nasa|national aeronautics/.test(identity))
      return Cesium.Color.fromCssColorString('#ff9f43');
    if (/starlink|spacex|space exploration/.test(identity))
      return Cesium.Color.fromCssColorString('#4cc9f0');
    if (/rocket lab/.test(identity))
      return Cesium.Color.fromCssColorString('#7bed9f');
    if (/isro|indian space/.test(identity))
      return Cesium.Color.fromCssColorString('#ff66c4');
    if (/cnsa|china national|long march/.test(identity))
      return Cesium.Color.fromCssColorString('#ffd166');
    if (/blue origin/.test(identity))
      return Cesium.Color.fromCssColorString('#a78bfa');
    if (/ula|united launch alliance/.test(identity))
      return Cesium.Color.fromCssColorString('#f97316');
    if (/arianespace|esa|european space/.test(identity))
      return Cesium.Color.fromCssColorString('#60a5fa');
    if (launch.provider) return Cesium.Color.fromCssColorString('#c084fc');
    return Cesium.Color.fromCssColorString('#22e6e6');
  }

  /**
   * Normalize a Launch Library 2 response into records suitable for the layer.
   * Trajectory points are retained only when the upstream explicitly supplies
   * them; orbital tracks must not be reconstructed from launch metadata.
   * @param {object} payload Launch Library 2-compatible response.
   * @param {Date} [now] Reference time used for the rolling window.
   * @returns {Array<object>}
   */

  function normalizeRocketLaunches(payload, now = new Date()) {
    const launches = Array.isArray(payload) ? payload : payload?.results;
    if (!Array.isArray(launches)) return [];
    const cutoff = now.getTime() - WINDOW_DAYS * 86400000;
    return launches
      .map((launch) => {
        const launchTime =
          launch.net || launch.window_start || launch.pad?.location?.name;
        const date = Date.parse(launchTime);
        const pad = launch.pad || {};
        const location = pad.location || {};
        const coordinates = location.coordinates || '';
        const [coordinateLon, coordinateLat] = String(coordinates)
          .split(',')
          .map(Number);
        const lat = Number.isFinite(Number(pad.latitude))
          ? Number(pad.latitude)
          : coordinateLat;
        const lon = Number.isFinite(Number(pad.longitude))
          ? Number(pad.longitude)
          : coordinateLon;
        const payloads = normalizePayloadFlights(launch);
        return {
          id: String(
            launch.id || launch.slug || launch.name || `launch-${date}`,
          ),
          name: launch.name || 'Unnamed launch',
          status: launch.status?.name || 'Unknown',
          launchTime: Number.isFinite(date)
            ? new Date(date).toISOString()
            : null,
          launchSite: pad.name || location.name || 'Unknown launch site',
          lat: Number.isFinite(lat) ? lat : null,
          lon: Number.isFinite(lon) ? lon : null,
          provider: launch.launch_service_provider?.name || null,
          mission: launch.mission?.description || null,
          missionName: launch.mission?.name || null,
          satelliteQuery: launch.mission?.name || launch.name || null,
          payloads,
          recoveryStages: normalizeRecoveryStages(launch, payloads),
          trajectory: Array.isArray(launch.trajectory) ? launch.trajectory : [],
          timeline: Array.isArray(launch.timeline)
            ? launch.timeline.map((event) => ({
                name:
                  event.type?.abbrev ||
                  event.type?.name ||
                  event.name ||
                  'Mission event',
                relativeTime: event.relative_time || event.relativeTime || null,
                offsetSeconds: parts.policyHelpers.parseMissionDurationSeconds(
                  event.relative_time || event.relativeTime,
                ),
              }))
            : [],
          orbit: launch.mission?.orbit || launch.orbit || null,
          source: 'Launch Library 2',
          inWindow:
            Number.isFinite(date) && date >= cutoff && date <= now.getTime(),
        };
      })
      .filter(
        (launch) =>
          launch.inWindow && launch.lat !== null && launch.lon !== null,
      );
  }
  return {
    finiteCoordinate,
    normalizePayloadFlights,
    normalizeLanding,
    normalizeRecoveryStages,
    missionMarkerColor,
    normalizeRocketLaunches,
  };
}
