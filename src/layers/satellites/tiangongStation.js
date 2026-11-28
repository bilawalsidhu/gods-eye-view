import { msg } from '../../i18n/index.js';
import { armGroup, sunGroup } from './issStation.js';
import { TIANGONG_NORAD } from './policy.js';
import { trackedStation } from './stationModels.js';
import {
  TIANGONG_ARMS,
  TIANGONG_ONE_AXIS_WINGS,
  TIANGONG_TWO_AXIS_WINGS,
} from './tiangongArticulation.js';

/** The lab wings' slider labels, per TIANGONG_TWO_AXIS_WINGS entry. */
const LAB_WING_LABELS = [
  [msg('Wentian forward · alpha'), msg('Wentian forward · beta')],
  [msg('Wentian aft · alpha'), msg('Wentian aft · beta')],
  [msg('Mengtian forward · alpha'), msg('Mengtian forward · beta')],
  [msg('Mengtian aft · alpha'), msg('Mengtian aft · beta')],
];

/**
 * Tiangong as the STATION section describes it (stationPanel.js): its joint
 * driver from the model part, computed values only (China publishes no
 * telemetry), and the Manual controls: the Sun's position or a fast orbit,
 * and the two arms posed by joint.
 * @param {{state: object, parts: object}} context
 * @returns {import('./stationPanel.js').StationDescription}
 */
export function tiangongStationDescription({ state: layerState, parts }) {
  const model = () => parts.tiangongModel ?? null;
  // Every wing has a joint of its own, so each can be set apart from the
  // others; a wing not touched keeps following the Sun.
  const wingSlider = (joint, label) => ({
    id: joint.node,
    label,
    min: -180,
    max: 180,
    apply: (a, value) => a.setWingAngle(joint.node, (value * Math.PI) / 180),
  });
  const wingGroup = (id, label, sliders) => ({
    id,
    label,
    kind: 'sliders',
    resume: msg('Follow the Sun'),
    sliders,
    resumeApply: (a) => a.resumeWings(),
  });
  const tianheWings = wingGroup('tianhe-wings', msg('Tianhe wings (degrees)'), [
    wingSlider(TIANGONG_ONE_AXIS_WINGS[0], msg('Port wing')),
    wingSlider(TIANGONG_ONE_AXIS_WINGS[1], msg('Starboard wing')),
  ]);
  const labWings = wingGroup(
    'lab-wings',
    msg('Lab wings (degrees)'),
    TIANGONG_TWO_AXIS_WINGS.flatMap((pair, i) => [
      wingSlider(pair.alpha, LAB_WING_LABELS[i][0]),
      wingSlider(pair.beta, LAB_WING_LABELS[i][1]),
    ]),
  );
  return {
    key: 'tiangong',
    title: 'Tiangong', // i18n-ignore: the station's name
    selected: () => trackedStation(layerState, parts)?.norad === TIANGONG_NORAD,
    subjectName: () =>
      layerState._catalog.get(layerState._trackedNorad)?.name?.trim() ||
      `Tiangong · NORAD ${TIANGONG_NORAD}`,
    articulation: () => model()?._articulation ?? null,
    // No feed exists: the status line says so instead of waiting for one.
    telemetry: () => ({ state: 'none', poseAgeMs: null, liveUntilMs: null }),
    position: () =>
      model()?._visualPosition?.() ??
      layerState._trackedFrameCartesian ??
      parts.rendering._pointPosition(TIANGONG_NORAD) ??
      null,
    zoomLabel: msg('Zoom to Tiangong'),
    notes: {
      computed: msg(
        'Arrays follow the Sun, the antenna aims at relay satellites and the arms sway for illustration. Computed: China publishes no live telemetry.',
      ),
    },
    groups: [
      sunGroup(),
      tianheWings,
      labWings,
      armGroup('cmm', msg('Tianhe arm (degrees)'), TIANGONG_ARMS.cmm, (a) =>
        a.resumeArm('cmm'),
      ),
      armGroup('emm', msg('Wentian arm (degrees)'), TIANGONG_ARMS.emm, (a) =>
        a.resumeArm('emm'),
      ),
    ],
    automatic: (a) => {
      a.setOverride(null);
      a.resumeWings();
      a.resumeArm();
    },
  };
}
