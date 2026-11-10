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
    /** Stops following the manager's adoptions (see watchAdoptions). */
    unwatchAdoptions: null,
    subject: null,
    /** The tracked flight's photo with the subject it belongs to, or null. */
    subjectPhoto: null,
    results: null,
    visual: null,
    /** Whether layer views replace the panel's initial markup yet. */
    panelShown: false,
    /** The published panel view, its signature and its subscribers. */
    panelView: null,
    panelSignature: '',
    panelListeners: new Set(),
    /** Result renders, published or not; tests observe repaint storms. */
    panelRenders: 0,
    subjectListener: null,
    contextListener: null,
    clearListener: null,
    subjectClearListener: null,
    runtimeListenersAttached: false,
    preRenderRemover: null,
    /** The published direction overlay, its signature and its subscribers. */
    directionView: null,
    directionSignature: '',
    directionListeners: new Set(),
    /** Each marker's last stable screen angle. */
    directionAngles: [0, 0, 0],
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
    /** When the viewer last handled the camera (pointer, wheel, touch, key). */
    lastCameraInputMs: Number.NEGATIVE_INFINITY,
    /** Element the camera-input listeners are attached to. */
    cameraInputTarget: null,
    /** Whether the view currently counts as moving (hysteretic, not per-frame). */
    cameraMoving: false,
    lastEvaluatedPosition: null,
    sourceRevision: '',
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
