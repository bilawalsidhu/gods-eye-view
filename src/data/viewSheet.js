/**
 * @module viewSheet
 * @description A view sheet: one image of small sprites showing a subject
 * (an aircraft class) from a sphere of directions, and the maths that picks
 * the sprite for where the eye is. The renderer implements the frame maths in
 * `render/cesium/iconSetPrimitive.js`. The aircraft bake follows this layout.
 *
 * **Frames.** A subject lies flat on the earth: up is the ground's normal,
 * forward its course. `d` is the direction from the subject to the eye in
 * the subject's own axes `[forward, right, up]`. A sheet holds each subject
 * as a block of consecutive cells, row-major: rings of frames `ringStepDeg`
 * apart, from straight above (ring 0) downward, ring `k` holding `rings[k]`
 * frames from the eye dead ahead, round the right side, to dead astern. The
 * left side is the right-side frame mirrored, so a sheet's subjects and
 * their light are symmetric about their centre plane.
 *
 * **Roll.** A frame's image up is `viewFrameAxes`: forward, turned by the
 * smallest rotation that takes up onto the frame's direction. Straight
 * above, the nose points up the image; the roll then changes smoothly all
 * the way round and below. It has no meaning only from straight below, so a
 * sheet's last ring stays short of that.
 *
 * **Between frames.** The frame nearest the eye's direction is drawn
 * (`viewNearest`), as a card standing where its subject is, square to
 * the frame's own direction: seen from a little to one side it is tilted
 * (foreshortened and turned) as the subject itself would be, until the next
 * frame is the nearer. Frames are not blended.
 */

/** Rings a sheet may hold (the shader's uniform array); even. */
export const VIEW_RINGS_MAX = 18;

/** Whether an icon image refers to a subject on a view sheet. */
export const isViewRef = (image) => typeof image?.views === 'string';

/**
 * Check a sheet's layout, and return it with each ring's first frame.
 * @param {{image: string, cellPx: number, columns: number, rows: number,
 *   ringStepDeg: number, rings: readonly number[]}} sheet
 * @returns {{cellPx: number, columns: number, rows: number, ringStepRad: number,
 *   rings: number[], firsts: number[], frames: number}}
 */
export function viewLayout(sheet) {
  const whole = (n) => Number.isInteger(n) && n > 0;
  if (!sheet || typeof sheet.image !== 'string' || !sheet.image)
    throw new TypeError('a view sheet needs its image URL');
  if (!whole(sheet.cellPx) || !whole(sheet.columns) || !whole(sheet.rows))
    throw new TypeError(
      'a view sheet needs whole cellPx, columns and rows above 0',
    );
  const { rings, ringStepDeg } = sheet;
  if (
    !Array.isArray(rings) ||
    rings.length < 1 ||
    rings.length > VIEW_RINGS_MAX ||
    !rings.every(whole)
  )
    throw new TypeError(
      `a view sheet needs 1 to ${VIEW_RINGS_MAX} rings of whole frame counts`,
    );
  if (rings[0] !== 1)
    throw new TypeError("a view sheet's first ring is the one frame above");
  if (
    !(ringStepDeg > 0) ||
    !Number.isFinite(ringStepDeg) ||
    (rings.length - 1) * ringStepDeg >= 180
  )
    throw new TypeError("a view sheet's rings stop short of straight below");
  const firsts = [];
  let frames = 0;
  for (const count of rings) {
    firsts.push(frames);
    frames += count;
  }
  return {
    cellPx: sheet.cellPx,
    columns: sheet.columns,
    rows: sheet.rows,
    ringStepRad: (ringStepDeg * Math.PI) / 180,
    rings: [...rings],
    firsts,
    frames,
  };
}

/**
 * A sheet's layout as the shader's uniforms: `grid`, and `rings` as one
 * vector for each two rings (`[frames, first, frames, first]`).
 */
export function viewUniforms(layout) {
  const rings = [];
  for (let k = 0; k < VIEW_RINGS_MAX; k += 2)
    rings.push([
      layout.rings[k] ?? 1,
      layout.firsts[k] ?? 0,
      layout.rings[k + 1] ?? 1,
      layout.firsts[k + 1] ?? 0,
    ]);
  return {
    grid: [
      layout.columns,
      layout.rows,
      layout.ringStepRad,
      layout.rings.length,
    ],
    rings,
  };
}
