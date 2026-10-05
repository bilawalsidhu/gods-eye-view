import * as Cesium from 'cesium';

export function createState({ services }) {
  const state = {};

  state.DIRECTION_SCRATCH = Array.from(
    { length: 3 },
    () => new Cesium.Cartesian3(),
  );

  state.SUBJECT_CARTOGRAPHIC_SCRATCH = new Cesium.Cartographic();

  state.TARGET_CARTOGRAPHIC_SCRATCH = Array.from(
    { length: 3 },
    () => new Cesium.Cartographic(),
  );

  Object.assign(state, {
    viewer: null,
    dataManager: null,
    enabled: false,
    // Set once a refresh observes the subject gone from a still-reporting source.
    // The Contact readout turns this into its CONTACT LOST hold state.
    subjectMissing: false,
    // The dedicated Context chooser exposes a passive shell. Operational source
    // layers activate only after Contacts is explicitly selected.
    passive: true,
    ownedDependencies: new Set(),
    subject: null,
    results: null,
    visual: null,
    panel: null,
    panelOwned: false,
    subjectListener: null,
    contextListener: null,
    clearListener: null,
    subjectClearListener: null,
    runtimeListenersAttached: false,
    preRenderRemover: null,
    panelClickListener: null,
    directionRoot: null,
    compassRing: null,
    compassLabels: [],
    compassHeading: null,
    directionMarkers: [],
    navigationHistory: [],
    navigationVisited: new Set(),
    navigationIndex: -1,
    suppressedHistoryKey: null,
    pendingSelectionKey: null,
    lastSubjectRefreshMs: 0,
    /** Camera-pose signature observed on the previous rendered frame. */
    lastCameraPoseSig: '',
    /** When the pose signature last changed bins (hysteresis anchor). */
    lastCameraPoseChangeMs: 0,
    /** Whether the view currently counts as moving (hysteretic, not per-frame). */
    cameraMoving: false,
    lastEvaluatedPosition: null,
    sourceRevision: '',
    panelMarkup: '',
    directionFrame: null,
    lastDirectionUpdateMs: 0,
    activationId: 0,
    autoFocusAttempted: false,
    autoFocusRetryPending: false,
    pageTimer: null,
    cohortPages: new Map(),
  });
  return state;
}
