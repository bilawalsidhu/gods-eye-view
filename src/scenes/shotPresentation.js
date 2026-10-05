const DEFAULT_SHOT_DURATION_SEC = 4;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const deepClone = (value) => JSON.parse(JSON.stringify(value));

/** Prepare scene-owned layer state, timing context and seek/travel controls. */
export function layerStatesForShot(
  scene,
  shot,
  packs,
  { cameraSettled = false, cameraTravel = null, sceneSeek = null } = {},
) {
  const states = deepClone(shot?.layers || {});
  const shotIndex = scene?.shots?.findIndex(({ id }) => id === shot?.id) ?? -1;
  const sceneShotDurations =
    scene?.shots?.map((sceneShot) =>
      shotRuntimeDurationSec(scene, sceneShot, packs),
    ) || [];
  const sceneDurationSec = sceneShotDurations.reduce(
    (sum, duration) => sum + duration,
    0,
  );
  const authoredSceneElapsedSec = sceneShotDurations
    .slice(0, Math.max(0, shotIndex))
    .reduce((sum, duration) => sum + duration, 0);
  const sceneElapsedSec = sceneSeek
    ? Math.max(
        0,
        Math.min(sceneDurationSec, Number(sceneSeek.sceneElapsedSec) || 0),
      )
    : authoredSceneElapsedSec;
  const sourceRecipe = packs.recipeForShot(shot);
  for (const state of Object.values(states)) {
    if (state?.params?.presentation !== 'scene-beat') continue;
    state.params.sceneSurface ||= shot.sourcePackId
      ? 'evidence-beat'
      : 'panel-only';
    const runtimeControls =
      sourceRecipe?.runtimeControlsByBeat?.[state.params.beatId];
    if (runtimeControls) {
      state.params.sceneControls = {
        ...state.params.sceneControls,
        ...runtimeControls,
        ...(runtimeControls.deferEvidenceUntilCameraSettled
          ? { cameraSettled }
          : {}),
        ...(sceneSeek
          ? {
              timelineSeek: {
                shotElapsedSec: Number(sceneSeek.shotElapsedSec) || 0,
                flightDurationSec: Number(sceneSeek.flightDurationSec) || 0,
                holdDurationSec: Number(sceneSeek.holdDurationSec) || 0,
                holdElapsedSec: Number(sceneSeek.holdElapsedSec) || 0,
                cameraProgress: clamp01(Number(sceneSeek.cameraProgress) || 0),
                holdProgress: clamp01(Number(sceneSeek.holdProgress) || 0),
              },
            }
          : {}),
      };
      if (runtimeControls.evidencePathDuringCamera && cameraTravel) {
        state.params.sceneControls.cameraTravel = { ...cameraTravel };
      }
    }
    state.params.sceneContext = {
      sceneId: scene.id,
      sceneTitle: scene.title,
      shotId: shot.id,
      shotTitle: shot.title,
      shotIndex,
      shotCount: scene.shots.length,
      durationSec: shot.durationSec || DEFAULT_SHOT_DURATION_SEC,
      holdSec: effectiveShotHoldSec(scene, shot, packs, states),
      sceneElapsedSec,
      sceneDurationSec,
      sceneProgress:
        sceneDurationSec > 0 ? sceneElapsedSec / sceneDurationSec : 0,
      ...(sceneSeek
        ? {
            shotElapsedSec: Number(sceneSeek.shotElapsedSec) || 0,
            shotProgress: clamp01(Number(sceneSeek.shotProgress) || 0),
            seeking: true,
          }
        : {}),
    };
  }
  for (const layerId of scene?.releaseLayerIds || []) {
    if (!Object.hasOwn(states, layerId)) states[layerId] = { enabled: false };
  }
  return states;
}

/** Resolve recipe map preferences and registered presentation fallbacks. */
export function visualStateForShot(shot, packs, isMapStackAvailable) {
  const sourceRecipe = packs.recipeForShot(shot);
  const sceneBeatState = Object.values(shot?.layers || {}).find(
    (state) => state?.params?.presentation === 'scene-beat',
  );
  const controls = {
    ...sceneBeatState?.params?.sceneControls,
    ...sourceRecipe?.runtimeControlsByBeat?.[sceneBeatState?.params?.beatId],
  };
  if (controls.imageryComparison === true) {
    return { ...(shot.visual || {}), mapStack: 'esri-imagery' };
  }
  if (
    sourceRecipe?.standaloneSurfaceBeatIds?.includes(
      sceneBeatState?.params?.beatId,
    )
  ) {
    return { ...(shot.visual || {}), mapStack: 'esri-imagery' };
  }
  const visual = sourceRecipe?.photorealSurfaceBeatIds?.includes(
    sceneBeatState?.params?.beatId,
  )
    ? { ...(shot.visual || {}), mapStack: 'photoreal' }
    : shot?.visual || {};
  return packs.resolveVisual(shot, visual, isMapStackAvailable);
}

/** Combine authored holds, registered pack overrides and layer reveal requirements. */
export function effectiveShotHoldSec(
  scene,
  shot,
  packs,
  resolvedStates = null,
) {
  const states = resolvedStates || layerStatesForShot(scene, shot, packs);
  const recipe = packs.recipeForShot(shot);
  const overrides = Object.values(states)
    .filter(
      (state) => state?.enabled && state.params?.presentation === 'scene-beat',
    )
    .map((state) => recipe?.runtimeHoldSecByBeat?.[state.params.beatId])
    .filter((value) => Number.isFinite(value) && value >= 0);
  const authoredHoldSec = overrides.length
    ? Math.max(...overrides)
    : Number(shot?.holdSec) || 0;
  return Object.values(states).reduce(
    (holdSec, state) => {
      const controls = state?.params?.sceneControls;
      return Math.max(
        holdSec,
        Number(controls?.minimumHoldSec) || 0,
        controls?.evidenceSequence === true
          ? Number(controls.evidenceSequenceDurationSec) || 0
          : 0,
      );
    },
    Math.max(packs.minimumHoldSec(states), authoredHoldSec),
  );
}

/** Estimate flight plus effective hold without mutating saved layer parameters. */
export function shotRuntimeDurationSec(scene, shot, packs) {
  const states = deepClone(shot?.layers || {});
  const sourceRecipe = packs.recipeForShot(shot);
  for (const state of Object.values(states)) {
    if (state?.params?.presentation !== 'scene-beat') continue;
    const runtimeControls =
      sourceRecipe?.runtimeControlsByBeat?.[state.params.beatId];
    if (runtimeControls) {
      state.params.sceneControls = {
        ...state.params.sceneControls,
        ...runtimeControls,
      };
    }
  }
  return (
    (shot?.durationSec || DEFAULT_SHOT_DURATION_SEC) +
    effectiveShotHoldSec(scene, shot, packs, states)
  );
}
