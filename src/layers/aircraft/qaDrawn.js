// What an aircraft layer draws, as plain data (QA: the engine-neutral probe,
// window.__godsEyeView.layers.drawn): per contact its glyph (image, scale,
// shown, screen rotation, alpha, position) and its 3D model, read from the
// renderer's handles — the same on every engine. Shared by the aircraft
// layers (flights, military).

/**
 * @param {object} state The layer's state: `_billboards` (id → sprite
 *   handle), `_models` (id → model handle), `_trackedIcao`, `_trackedModel`.
 * @returns {Array<object>}
 */
const translationOf = (matrix) =>
  matrix && Number.isFinite(matrix[12])
    ? { x: matrix[12], y: matrix[13], z: matrix[14] }
    : null;

export function aircraftQaDrawn(state) {
  const out = [];
  for (const [id, sprite] of state._billboards) {
    const model = state._models.get(id);
    out.push({
      id,
      tracked: id === state._trackedIcao,
      image: sprite.image,
      scale: sprite.scale,
      width: sprite.width,
      show: sprite.show,
      rotation: sprite.rotation,
      trackedRotation:
        id === state._trackedIcao
          ? (state._trackedEntity?.rotation ??
            state._lastTrackedRotation ??
            null)
          : null,
      alpha: sprite.color?.alpha ?? null,
      position: sprite.position
        ? {
            x: sprite.position.x,
            y: sprite.position.y,
            z: sprite.position.z,
          }
        : null,
      model: model
        ? {
            scale: model.scale,
            // The drawn scale, after the minimum pixel size.
            computedScale: model.computedScale,
            show: model.show,
            ready: model.ready,
            // Where it is drawn: its transform's translation.
            position: translationOf(model.modelMatrix),
            matrix: model.modelMatrix ? Array.from(model.modelMatrix) : null,
          }
        : null,
    });
  }
  const tracked = state._trackedModel;
  if (state._trackedIcao && tracked)
    out.push({
      id: state._trackedIcao,
      trackedModel: true,
      model: {
        scale: tracked.scale,
        show: tracked.show,
        ready: tracked.ready,
        matrix: tracked.modelMatrix ? Array.from(tracked.modelMatrix) : null,
      },
    });
  return out;
}
