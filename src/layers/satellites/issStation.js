import { msg } from '../../i18n/index.js';
import { ISS_ARM_JOINTS } from './issArticulation.js';
import { issCommandFastOrbit } from './issCommand.js';
import { ISS_NORAD } from './policy.js';
import { trackedStation } from './stationModels.js';

const unit = (v) => {
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
};

/**
 * The Sun positions Manual offers, on the model's axes (port, zenith,
 * forward), and whether the station is lit there.
 */
export const ISS_SUN_POSES = Object.freeze([
  { id: 'overhead', label: msg('Overhead'), sun: [0, 1, 0], sunlit: true },
  { id: 'ahead', label: msg('Ahead'), sun: unit([0, 0.05, 1]), sunlit: true },
  {
    id: 'behind',
    label: msg('Behind'),
    sun: unit([0, 0.05, -1]),
    sunlit: true,
  },
  {
    id: 'below',
    label: msg('Underneath'),
    sun: unit([0, -1, 0.05]),
    sunlit: true,
  },
  {
    id: 'port',
    label: msg('Port side'),
    sun: unit([0.8, 0.5, 0.3]),
    sunlit: true,
  },
  {
    id: 'starboard',
    label: msg('Starboard side'),
    sun: unit([-0.8, 0.5, 0.3]),
    sunlit: true,
  },
  { id: 'night', label: msg('Night (shadow)'), sun: [0, -1, 0], sunlit: false },
]);

/** A seven-joint arm's slider labels, base to tip (Tiangong's arms share them). */
export const ISS_ARM_LABELS = Object.freeze([
  msg('Shoulder roll'),
  msg('Shoulder yaw'),
  msg('Shoulder pitch'),
  msg('Elbow'),
  msg('Wrist pitch'),
  msg('Wrist yaw'),
  msg('Wrist roll'),
]);

/**
 * The ISS as the STATION section describes it (stationPanel.js): its joint
 * driver and telemetry from the model part, and the Manual controls the
 * command panel offered: the Sun's position or a fast orbit, folding the
 * arrays and radiators as a demonstration, aiming the dishes, posing
 * Canadarm2 by joint.
 * @param {{state: object, parts: object}} context
 * @returns {import('./stationPanel.js').StationDescription}
 */
export function issStationDescription({ state: layerState, parts }) {
  return {
    key: 'iss',
    title: 'ISS', // i18n-ignore: the station's name
    // stationModels.js says which station the tracked entry belongs to.
    selected: () => trackedStation(layerState, parts)?.norad === ISS_NORAD,
    subjectName: () =>
      layerState._catalog.get(layerState._trackedNorad)?.name?.trim() ||
      `ISS · NORAD ${ISS_NORAD}`,
    articulation: () => parts.issModel?._articulation ?? null,
    telemetry: () => {
      // The feed is read only while the model is drawn; away from it there
      // is no signal to report, and a stale answer would read as lost.
      if ((parts.issModel?._visualPosition?.() ?? null) === null)
        return { state: 'idle', poseAgeMs: null, liveUntilMs: null };
      return parts.issModel?._telemetryStatus?.() ?? null;
    },
    // The model's centre, else this frame's tracked sample, else the dot as
    // the rendering part draws it.
    position: () =>
      parts.issModel?._visualPosition?.() ??
      layerState._trackedFrameCartesian ??
      parts.rendering?._pointPosition?.(ISS_NORAD) ??
      null,
    zoomLabel: msg('Zoom to the ISS'),
    notes: {
      live: msg(
        "Arrays, radiators and one dish follow NASA's live telemetry. The other dish holds still and the arms sway for illustration.",
      ),
      computed: msg(
        'Arrays and radiators follow the Sun, the dishes aim at relay satellites and the arms sway for illustration. Computed, not live telemetry.',
      ),
    },
    groups: [
      {
        id: 'sun',
        label: msg('Sun position'),
        kind: 'choices',
        choices: [
          {
            id: 'follow',
            label: msg('Follow the Sun'),
            isDefault: true,
            apply: (a) => a.setOverride(null),
          },
          ...ISS_SUN_POSES.map(({ id, label, sun, sunlit }) => ({
            id,
            label,
            apply: (a) => {
              const fixed = { sun, sunlit };
              a.setOverride(() => fixed);
            },
          })),
          {
            id: 'orbit',
            label: msg('Fast orbit (40 s)'),
            apply: (a) => {
              const start = Date.now();
              a.setOverride((nowMs) => issCommandFastOrbit(nowMs - start));
            },
          },
        ],
      },
      {
        id: 'arrays',
        label: msg('Solar arrays'),
        note: msg('Demonstration: the real arrays stay extended.'),
        kind: 'choices',
        choices: [
          {
            id: 'retract',
            label: msg('Retract'),
            apply: (a) => a.setDeploy(false),
          },
          {
            id: 'extend',
            label: msg('Extend'),
            isDefault: true,
            apply: (a) => a.setDeploy(true),
          },
        ],
      },
      {
        id: 'radiators',
        label: msg('Radiators'),
        note: msg(
          'Demonstration: the real radiators can fold but stay extended.',
        ),
        kind: 'choices',
        choices: [
          {
            id: 'retract',
            label: msg('Retract'),
            apply: (a) => a.setRadiatorDeploy(false),
          },
          {
            id: 'extend',
            label: msg('Extend'),
            isDefault: true,
            apply: (a) => a.setRadiatorDeploy(true),
          },
        ],
      },
      {
        id: 'dishes',
        label: msg('Dishes'),
        kind: 'choices',
        choices: [
          {
            id: 'relays',
            label: msg('Relay satellites'),
            isDefault: true,
            apply: (a) => a.setDishOverride(null),
          },
          {
            id: 'up',
            label: msg('Up'),
            apply: (a) => a.setDishOverride([0, 1, 0]),
          },
          {
            id: 'forward',
            label: msg('Forward'),
            apply: (a) => a.setDishOverride(unit([0, 0.35, 0.94])),
          },
          {
            id: 'sideways',
            label: msg('Sideways'),
            apply: (a) => a.setDishOverride(unit([0.94, 0.35, 0])),
          },
        ],
      },
      {
        id: 'arm',
        label: msg('Canadarm2 (degrees)'),
        kind: 'sliders',
        resume: msg('Resume sway'),
        sliders: ISS_ARM_JOINTS.map((joint, i) => ({
          id: joint.node,
          label: ISS_ARM_LABELS[i],
          min: -120,
          max: 120,
          apply: (a, value) =>
            a.setJoint(
              joint.node,
              joint.pivot,
              joint.axis,
              (value * Math.PI) / 180,
            ),
        })),
        resumeApply: (a) => a.resumeArm(),
      },
    ],
    automatic: (a) => {
      a.setTelemetryAllowed?.(true);
      a.setOverride(null);
      a.setDishOverride(null);
      a.setDeploy(true);
      a.setRadiatorDeploy(true);
      a.resumeArm();
    },
  };
}
