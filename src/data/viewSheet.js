/**
 * @module viewSheet
 * @description A view sheet: one image of small sprites showing a subject
 * (an aircraft class) from a sphere of directions, and the maths that picks
 * the sprite for where the eye is. Plain JavaScript and GLSL: no DOM, no
 * engine. `scripts/build-aircraft-view-sheet.py` bakes the aircraft sheet to
 * this layout; a renderer with the `viewSheets` capability draws it.
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
 * **Roll.** A frame's image up is {@link frameUp}: forward, turned by the
 * smallest rotation that takes up onto the frame's direction. Straight
 * above, the nose points up the image; the roll then changes smoothly all
 * the way round and below. It has no meaning only from straight below, so a
 * sheet's last ring stays short of that.
 *
 * **Between frames.** The frame nearest the eye's direction is drawn
 * ({@link viewFrame}), as a card standing where its subject is, square to
 * the frame's own direction: seen from a little to one side it is tilted
 * (foreshortened and turned) as the subject itself would be, until the next
 * frame is the nearer. Frames are not blended.
 */

/** Rings a sheet may hold (the shader's uniform array); even. */
export const VIEW_RINGS_MAX = 18;

/** The aircraft classes' view sheet (`public/sprites/aircraft-views.json`). */
export const AIRCRAFT_VIEWS = Object.freeze({
  id: 'aircraft-views',
  sheet: Object.freeze({
    image: '/sprites/aircraft-views.webp',
    cellPx: 64,
    columns: 64,
    rows: 57,
    ringStepDeg: 7.5,
    rings: Object.freeze([
      1, 4, 7, 10, 13, 16, 18, 20, 22, 23, 24, 25, 25, 25, 24, 23, 22,
    ]),
    grey: true,
  }),
  /** Frames in each subject's block. */
  frames: 302,
  /** Each subject's first cell. */
  subjects: Object.freeze({
    airliner: 0,
    widebody: 302,
    quadjet: 604,
    turboprop: 906,
    light: 1208,
    glider: 1510,
    fastjet: 1812,
    bizjet: 2114,
    uav: 2416,
    helicopter0: 2718,
    helicopter1: 3020,
    helicopter2: 3322,
  }),
});

/**
 * Check a sheet's layout, and return it with each ring's first frame.
 * @param {{image: string, cellPx: number, columns: number, rows: number,
 *   ringStepDeg: number, rings: readonly number[], grey?: boolean}} sheet
 * @returns {{columns: number, rows: number, ringStepRad: number,
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
    columns: sheet.columns,
    rows: sheet.rows,
    ringStepRad: (ringStepDeg * Math.PI) / 180,
    rings: [...rings],
    firsts,
    frames,
  };
}

/**
 * The frame that shows a subject from `d`.
 * @param {ReturnType<typeof viewLayout>} layout
 * @param {readonly [number, number, number]} d Toward the eye, as
 *   `[forward, right, up]`; any length above 0.
 * @returns {{frame: number, ring: number, index: number, mirrored: boolean}}
 *   `frame` counts from the subject's first cell; `mirrored` draws it flipped
 *   left to right (the eye on the left side).
 */
export function viewFrame(layout, d) {
  const length = Math.hypot(d[0], d[1], d[2]);
  const up = length > 0 ? Math.min(1, Math.max(-1, d[2] / length)) : 1;
  const ring = Math.min(
    layout.rings.length - 1,
    Math.floor(Math.acos(up) / layout.ringStepRad + 0.5),
  );
  const span = layout.rings[ring] - 1;
  const side = Math.abs(d[1]);
  const bearing = side + Math.abs(d[0]) > 0 ? Math.atan2(side, d[0]) : 0;
  const index = span > 0 ? Math.floor((bearing / Math.PI) * span + 0.5) : 0;
  return {
    frame: layout.firsts[ring] + index,
    ring,
    index,
    mirrored: d[1] < 0,
  };
}

/**
 * The direction a frame shows its subject from: a unit `[forward, right,
 * up]`, on the right side (or the left, mirrored).
 */
export function frameDirection(layout, ring, index, mirrored = false) {
  const off = ring * layout.ringStepRad;
  const span = layout.rings[ring] - 1;
  const turn = span > 0 ? (index / span) * Math.PI : 0;
  return [
    Math.sin(off) * Math.cos(turn),
    Math.sin(off) * Math.sin(turn) * (mirrored ? -1 : 1),
    Math.cos(off),
  ];
}

/**
 * A frame's image up, for the unit direction `d` it shows its subject from:
 * forward, turned as up turns onto `d`. A unit `[forward, right, up]`,
 * perpendicular to `d`.
 */
export function frameUp(d) {
  const k = 1 / Math.max(1 + d[2], 1e-6);
  return [1 - d[0] * d[0] * k, -d[0] * d[1] * k, -d[0]];
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

/**
 * {@link viewFrame}, {@link frameDirection} and {@link frameUp} in GLSL, over `u_viewGrid` (columns, rows, ring step in radians, rings) and
 * `u_viewRings` (each ring's frames and first frame, two rings a vector).
 */
export const VIEW_SHEET_GLSL = /* glsl */ `
uniform vec4 u_viewGrid;
uniform vec4 u_viewRings[${VIEW_RINGS_MAX / 2}];

// A ring's frames and its first frame, from the subject's first cell.
vec2 viewRing(float ring) {
  vec4 pair = u_viewRings[int(ring * 0.5)];
  return ring - 2.0 * floor(ring * 0.5) < 0.5 ? pair.xy : pair.zw;
}

// The frame that shows a subject from d (unit, toward the eye, as forward,
// right, up): its ring, its index in the ring, and 1 when it is drawn
// mirrored (the eye on the left side).
vec3 viewNearest(vec3 d) {
  float ring = clamp(
    floor(acos(clamp(d.z, -1.0, 1.0)) / u_viewGrid.z + 0.5),
    0.0, u_viewGrid.w - 1.0);
  float span = viewRing(ring).x - 1.0;
  float side = abs(d.y);
  float bearing = side + abs(d.x) > 0.0 ? atan(side, d.x) : 0.0;
  return vec3(
    ring,
    span > 0.0 ? floor(bearing / 3.141592653589793 * span + 0.5) : 0.0,
    d.y < 0.0 ? 1.0 : 0.0);
}

// The direction a frame shows its subject from (toward the eye, as forward,
// right, up; flip 1 for the left side) and the frame's image up.
void viewFrameAxes(float ring, float index, float flip, out vec3 toEye, out vec3 up) {
  float span = viewRing(ring).x - 1.0;
  float off = ring * u_viewGrid.z;
  float turn = span > 0.0 ? index / span * 3.141592653589793 : 0.0;
  toEye = vec3(
    sin(off) * cos(turn),
    sin(off) * sin(turn) * (1.0 - 2.0 * flip),
    cos(off));
  float k = 1.0 / max(1.0 + toEye.z, 1.0e-6);
  up = vec3(1.0 - toEye.x * toEye.x * k, -toEye.x * toEye.y * k, -toEye.x);
}
`;

/**
 * Reading a view sheet's cells in a fragment shader: `viewCell(cell, uv,
 * lod)` is the colour of a cell at `uv` (0..1 across it, v down) and that
 * level of detail, nothing outside it, from `u_views` over `u_viewGrid`.
 */
export const VIEW_SHEET_FRAGMENT_GLSL = /* glsl */ `
uniform sampler2D u_views;
uniform vec4 u_viewGrid;

vec4 viewCell(float cell, vec2 uv, float lod) {
  float at = floor(cell + 0.5);
  float row = floor((at + 0.5) / u_viewGrid.x);
  float column = at - row * u_viewGrid.x;
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  vec4 color = textureLod(
    u_views, (vec2(column, row) + clamp(uv, 0.0, 1.0)) / u_viewGrid.xy, lod);
  return color * (inside.x * inside.y);
}
`;
