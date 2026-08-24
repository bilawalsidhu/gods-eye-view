/**
 * Screen-space grid clustering for the mover layers.
 *
 * At a whole-globe view the aircraft layer draws eleven hundred marks into the few hundred
 * pixels that Europe occupies, and the vessel layer puts nearly four thousand into the North
 * Sea. No mark size fixes that: at that range there is less than a pixel of screen per mover,
 * so the honest answer is to stop pretending each one has its own place on the picture and say
 * how many are there instead.
 *
 * **A cluster is a truthful object.** It carries the number of movers it stands for, so a
 * viewer is never shown one mark that quietly means forty. Nothing is dropped: every mover the
 * camera can see is either drawn as itself or counted inside exactly one group, and
 * `ClusterState` reports both halves so the layer rail can say so out loud.
 *
 * **Density decides, not zoom.** There is no altitude threshold anywhere in here. A cell
 * clusters when it holds `CLUSTER_MIN_MEMBERS` or more, which means the picture resolves itself
 * as you come in: big groups split into small groups and small groups into individuals, without
 * a global switch that flips the whole layer at once. It also means a sparse layer never
 * clusters at all however far out you are, which is the right behaviour for the satellite
 * shell.
 *
 * **Cheap and boring on purpose.** This runs on camera movement rather than on a fix, so it
 * sits on the interaction path where a stall is felt immediately. One pass to project and bin,
 * one pass to read back, flat typed arrays for the grid, and nothing allocated per frame. It is
 * not Cesium's `EntityCluster`, which is tied to the `Entity` API this project bans for movers.
 *
 * Renderer-free, like `palette.ts` and `icons.ts`: the projection is a hand-rolled multiply
 * against a column-major 4x4, so a Cesium `Matrix4` can be passed straight in and a test can
 * pass sixteen plain numbers.
 */

/**
 * Cell size in pixels.
 *
 * Two constraints meet here. It has to be wide enough that a cell holding the minimum is a genuine
 * pile rather than a near miss, and it has to be **wider than the largest badge**, because badges are
 * drawn on cell centres and two neighbouring centres are one cell apart. A badge wider than its cell
 * would therefore reach into the one next door. The first version had 44-pixel cells and a 52-pixel
 * badge, and a whole-globe view came back with "523" and "44" printed on top of each other over the
 * North Sea, which is a count worse than no count. `palette.test.ts` asserts the relationship so it
 * cannot drift apart again.
 *
 * That relationship is only sufficient because of the nudge on `ClusterMark.nudgeX`. While badges
 * were drawn on their anchor member rather than on the cell centre, a narrower-than-a-cell badge did
 * **not** prevent overlap, because two members either side of a shared edge can be a pixel apart. It
 * took until 2026-08-24 to catch, and it was measured rather than spotted by eye.
 *
 * **Do not raise this to thin out the opening view. It was swept from 56 to 132 and 56 kept.**
 *
 * The reason to reach for a bigger cell is real: at the whole-globe default, 1400 by 900, five layers
 * of live data draw 22 badges and the densest 300-pixel window holds 17 of them, which over Europe is
 * a band you cannot read the map through. Doubling the cell to 112 takes that to 12 badges and a worst
 * window of 9, and over Europe at 3,000km from 100 badges to 53. So the arithmetic points at 112.
 *
 * Three measurements say not to, all taken on the live feeds on 2026-08-24.
 *
 * **It costs the city view, in the direction that matters most.** At the transit feed's densest city,
 * Prague, doubling the cell takes badges from 3 to 20 and the vehicles drawn as themselves from 568
 * to 280. That is 288 vehicles disappearing into badges at exactly the zoom where somebody is looking
 * at vehicles. The opening view is the first thing seen; a city is where the product is used.
 *
 * **The count is alignment-sensitive, so no cell size is defensible.** It is not a smooth function of
 * this number: 112 gives 12 badges at the opening view and 128 gives 18, while 56 gives 22 and 64
 * gives 23. A cell is a partition, so moving the boundaries changes which entities share one, and the
 * swing is about a quarter either way depending on how the grid happens to fall over the data. That
 * turns "56 against 112" from a tuning question into a reason not to tune, this value included.
 *
 * **Raising the minimum instead is worse, and here is the figure.** Getting the opening view from 22
 * badges to 13 by raising every mover layer's minimum costs **1,170 loose marks**, because every cell
 * that no longer reaches its threshold draws its members one by one. That is the smear this whole
 * exercise removed, arriving through the front door. At a minimum of 50 it is already 131 loose marks
 * bought for four fewer badges.
 *
 * **And the density is true rather than an artefact.** At the opening view the badges *are* the honest
 * representation of 24,698 entities on screen, and there is no way to have fewer of them without
 * either hiding more, which is the bigger cell, or smearing more, which is the higher minimum. The
 * band sits over Europe because that is where the data is: the transit feed holds 1,068 vehicles
 * within 25km of Prague against 52 in the whole of California.
 *
 * A cell that varied with camera height would get both ends, 112 up top and 56 in a city, and it is a
 * small change: `begin` already recomputes its grid and reallocates on every call. It was considered
 * and rejected on 2026-08-24 because crossing a band makes every badge jump to a new lattice with
 * different counts, and somebody flying a camera from the globe into a city would read that pop as a
 * broken render. Buying tidiness with a new artefact that looks like a glitch is the wrong trade.
 */
export const CLUSTER_CELL_PX = 56;

/**
 * How many movers must share a cell before they become a group, by default.
 *
 * Ten, and the number is a correction rather than a guess. A first attempt used three, on the
 * reasoning that two overlapping marks are still two readable marks. Measured on a whole-globe
 * view that turned out to be far too eager: northern Europe came back as fifteen opaque badges
 * covering more of the map than the smear they replaced, which is the failure this whole exercise
 * exists to avoid.
 *
 * The real test is whether a badge costs the picture less than what it hides. A badge is about
 * thirty pixels across and a mark at that range is seven to nine, so a badge earns its place at
 * roughly ten of them and not before. It is also about when the marks stop being readable: a
 * forty-four pixel cell holds about two dozen nine-pixel marks, so ten is around the point where
 * half the cell is covered and individual movers can no longer be picked out.
 *
 * Layers override it. A layer whose marks are already quiet enough to see the globe through wants
 * a much higher number, because for it a badge is a step backwards until the pile is genuinely
 * large. See `layers/satellites.ts`.
 *
 * **Do not raise the mover minimums to thin out the opening view, and do not reach for the satellite
 * precedent to justify it. Both were measured on 2026-08-24 and both say no.**
 *
 * The argument for raising them is a good one: the satellite minimum is thirty because a badge hides
 * more of the globe than the seven-pixel diamonds it replaces, so a badge has to earn its place, and
 * at a whole-globe view the mover layers look like they fail the same test. Applying that test
 * properly is what settles it, and the metric has to be **painted ink rather than mark count**: at
 * that range a transit mark is 5.2 pixels drawn and a badge is 30 to 48, so counting marks flatters
 * the badge by a factor of thirty. Ink fractions taken from the real silhouette polygons: a plane
 * paints 0.447 of its box with its casing, a ship 0.409, a vehicle 0.393, a diamond 0.544, and the
 * badge hexagon about 0.60.
 *
 * Total ink over the live feeds, badges plus the loose marks that replace them:
 *
 * - **Whole Earth: it barely moves.** 30,310 square pixels at ten, 28,083 at forty, 28,691 at a
 *   hundred. Seven per cent at best, and then it gets worse again. The reason is that the badges up
 *   there hold thousands each, far above any threshold worth setting, so raising the minimum removes
 *   only the handful of small ones and the twenty-odd big ones are not going anywhere.
 * - **Europe at 3,000km: fifteen is the optimum and above it degrades fast.** 122,441 at fifteen,
 *   132,943 at forty, 186,147 at a hundred. Fifty-two per cent worse.
 * - **A dense city: lower is better all the way down.** 87,530 at ten rising monotonically to 95,154,
 *   where nothing groups at all.
 *
 * So the mover minimums are already at the ink optimum or within one step of it at every zoom, and
 * the satellite precedent does not transfer for a reason that is measurable rather than a matter of
 * taste: a diamond is the inkiest mark in the app at 0.544 of its box, there are only about seven
 * hundred satellites and they are spread around a shell, so a satellite badge replaces few marks that
 * each cost a lot. A transit badge replaces thousands that each cost almost nothing.
 */
export const CLUSTER_MIN_MEMBERS = 10;

/** What `offer` returns for a mover the camera cannot see. */
export const OFF_SCREEN = -1;

/** Mean earth radius in metres, for the occlusion test. Matches `globe/project.ts`. */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * What the layer rail needs to describe a layer honestly.
 *
 * `onScreen === individuals + inGroups` always holds, which is the invariant that stops
 * clustering turning a count into a lie.
 */
export interface ClusterState {
  /** Movers the camera can see, counting a group's members one by one. */
  onScreen: number;
  /** Of those, how many are drawn as themselves. */
  individuals: number;
  /** How many group marks are drawn. */
  groups: number;
  /** How many movers those group marks stand for between them. */
  inGroups: number;
  /** Members behind the largest single group, or 0 when nothing grouped. */
  largestGroup: number;
}

/** A group to draw: where it goes, how many it speaks for, and how far apart they are. */
export interface ClusterMark {
  /** Dense grid index. Stable for the life of one pass and no longer. */
  cellId: number;
  count: number;
  /**
   * The world position the badge hangs from: whichever member landed nearest the cell's centre.
   *
   * A real member's position rather than the group's centroid, because the mean of positions on a
   * sphere sits *inside* it, a chord's midpoint being nearer the centre than its ends, so a badge
   * placed there is swallowed by the globe's own depth buffer. Keeping a real member also means the
   * badge is occluded and moved by the camera exactly as its members are.
   *
   * This is where the badge *hangs from*, not where it is drawn. See `nudgeX`.
   */
  x: number;
  y: number;
  z: number;
  /**
   * Screen pixels from that member to the centre of its cell. The badge is drawn there.
   *
   * Corrected 2026-08-24, and it corrects a claim this comment used to make. Anchoring to the member
   * nearest the middle was described here as keeping badges about a cell apart, which is why
   * `CLUSTER_CELL_PX` is wider than the widest badge. Measured across 2,450 London and 2,256
   * Manhattan posts at four altitudes, that is false: two members in neighbouring cells can both sit
   * against their shared edge and end up arbitrarily close, and no badge size prevents it. A London
   * 8km view had 38 overlapping pairs involving 50 of 96 badges, with a deepest overlap of 24px, and
   * it happened at every grouping threshold from 2 to 10, so it was never about the threshold.
   *
   * Drawing on the cell centre is what actually fixes it: badges then sit on a `cellPx` lattice, and
   * since the widest badge is narrower than a cell they cannot overlap at all. The badge moves by at
   * most half a cell diagonal from its anchor, which costs nothing true, because a badge is a count
   * over an area and has never claimed to mark a position.
   */
  nudgeX: number;
  nudgeY: number;
  /**
   * The cell centre in screen pixels, which is where the nudge points.
   *
   * Carried so a caller can trade the point for another one. `badge-slots.ts` hands out lattice
   * points across every layer at once, and converting a granted point back into a pixel offset needs
   * to know which point the nudge was aiming at.
   */
  centreX: number;
  centreY: number;
  /**
   * Upper bound on how far apart the members are, in metres.
   *
   * The diagonal of their earth-fixed bounding box, which is a bound rather than a measurement
   * and needs no second pass over the members. Earth-fixed, so it has no antimeridian to fall
   * over.
   */
  spreadM: number;
}

/**
 * Field offsets within a cell, laid out as a struct of arrays so a pass allocates nothing.
 *
 * Plain constants rather than a `const enum`, which this project's `erasableSyntaxOnly` forbids
 * because it is syntax the type stripper cannot simply delete.
 */
const COUNT = 0;
const BEST_X = 1;
const BEST_Y = 2;
const BEST_Z = 3;
/** Squared pixel distance from the cell's centre of the member held in `BEST_*`. */
const BEST_SCORE = 4;
const MIN_X = 5;
const MIN_Y = 6;
const MIN_Z = 7;
const MAX_X = 8;
const MAX_Y = 9;
const MAX_Z = 10;
/**
 * The winning member's screen displacement from its cell's centre, negated: the pixel offset that
 * puts the badge on the cell centre. Stored rather than recomputed because `offer` already has both
 * numbers and `marks()` has no view projection to redo the work with.
 */
const NUDGE_X = 11;
const NUDGE_Y = 12;
const STRIDE = 13;

/**
 * Whether the globe hides a point from a camera.
 *
 * Proper segment-versus-sphere rather than the usual `dot(p, camera) < radius squared` horizon
 * plane, because that shortcut is wrong for exactly the layer that needs it most: a satellite
 * sitting above the far limb is genuinely in view, and the plane test calls it hidden. Counting
 * hidden movers into a visible group would make the group's number a claim about the other side
 * of the world.
 */
export function occludedByGlobe(
  cameraX: number,
  cameraY: number,
  cameraZ: number,
  x: number,
  y: number,
  z: number,
  radiusM: number = EARTH_RADIUS_M,
): boolean {
  const dx = x - cameraX;
  const dy = y - cameraY;
  const dz = z - cameraZ;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) {
    return false;
  }
  const alongRay = cameraX * dx + cameraY * dy + cameraZ * dz;
  // Where the ray from the camera to the point passes closest to the earth's centre. Outside
  // the segment, the nearest point is an end of it, and both ends are above the surface.
  const closest = -alongRay / lengthSquared;
  if (closest <= 0 || closest >= 1) {
    return false;
  }
  const cameraSquared = cameraX * cameraX + cameraY * cameraY + cameraZ * cameraZ;
  const nearestSquared = cameraSquared - (alongRay * alongRay) / lengthSquared;
  return nearestSquared < radiusM * radiusM;
}

/**
 * Where an earth-fixed point lands on the canvas, or false when it lands nowhere.
 *
 * `viewProjection` is column-major, which is Cesium's own layout, so a `Matrix4` goes straight
 * in without being copied. False means behind the camera or outside the viewport, and a caller
 * must treat that as "not on screen" rather than clamping: a mover off the left edge does not
 * belong in a group on the left edge.
 */
export function projectToScreen(
  viewProjection: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  widthPx: number,
  heightPx: number,
  out: { x: number; y: number },
): boolean {
  const m = viewProjection;
  const clipW = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
  if (clipW <= 0) {
    return false;
  }
  const clipX = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
  const clipY = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
  // Normalised device coordinates run -1 to 1 with y up; the canvas has y down.
  const screenX = (clipX / clipW + 1) * 0.5 * widthPx;
  const screenY = (1 - (clipY / clipW + 1) * 0.5) * heightPx;
  if (screenX < 0 || screenY < 0 || screenX >= widthPx || screenY >= heightPx) {
    return false;
  }
  out.x = screenX;
  out.y = screenY;
  return true;
}

/**
 * One layer's worth of screen-space binning, reused pass after pass.
 *
 * Used in two passes over the movers, which is what keeps it allocation-free: `offer` bins each
 * one and hands back the cell it landed in, `resolve` decides which cells are crowded, and then
 * `grouped` answers per mover without another projection.
 */
export class ScreenClusterer {
  private readonly cellPx: number;
  private readonly minMembers: number;
  /** `STRIDE` doubles per cell. Grown, never shrunk: the viewport rarely gets bigger. */
  private cells = new Float64Array(0);
  private columns = 0;
  private rows = 0;
  /**
   * The real viewport, kept apart from the grid.
   *
   * The grid rounds up to a whole number of cells, so it is a little larger than the canvas.
   * Projecting into the rounded size instead of the real one would shift every mover by up to a
   * cell's worth of scale, which is a bug that looks like nothing until a badge sits next to the
   * movers it speaks for rather than on them.
   */
  private widthPx = 0;
  private heightPx = 0;
  private readonly screen = { x: 0, y: 0 };
  private onScreenCount = 0;
  private individualCount = 0;
  private groupCount = 0;
  private inGroupCount = 0;
  private largest = 0;
  private resolved = false;

  constructor(cellPx: number = CLUSTER_CELL_PX, minMembers: number = CLUSTER_MIN_MEMBERS) {
    this.cellPx = cellPx;
    this.minMembers = minMembers;
  }

  /** Start a pass over a viewport of this size. */
  begin(widthPx: number, heightPx: number): void {
    this.widthPx = widthPx;
    this.heightPx = heightPx;
    this.columns = Math.max(1, Math.ceil(widthPx / this.cellPx));
    this.rows = Math.max(1, Math.ceil(heightPx / this.cellPx));
    const needed = this.columns * this.rows * STRIDE;
    if (this.cells.length < needed) {
      this.cells = new Float64Array(needed);
    } else {
      this.cells.fill(0, 0, needed);
    }
    this.onScreenCount = 0;
    this.individualCount = 0;
    this.groupCount = 0;
    this.inGroupCount = 0;
    this.largest = 0;
    this.resolved = false;
  }

  /**
   * Bin one mover. Returns the cell it landed in, or `OFF_SCREEN`.
   *
   * The camera position is passed per call rather than held, because it is three numbers and
   * holding it would be one more thing that can go stale between `begin` and here.
   */
  offer(
    viewProjection: ArrayLike<number>,
    cameraX: number,
    cameraY: number,
    cameraZ: number,
    x: number,
    y: number,
    z: number,
  ): number {
    if (occludedByGlobe(cameraX, cameraY, cameraZ, x, y, z)) {
      return OFF_SCREEN;
    }
    if (!projectToScreen(viewProjection, x, y, z, this.widthPx, this.heightPx, this.screen)) {
      return OFF_SCREEN;
    }
    const column = Math.min(this.columns - 1, Math.floor(this.screen.x / this.cellPx));
    const row = Math.min(this.rows - 1, Math.floor(this.screen.y / this.cellPx));
    const cellId = row * this.columns + column;
    const at = cellId * STRIDE;
    const cells = this.cells;
    const count = (cells[at + COUNT] ?? 0) + 1;
    cells[at + COUNT] = count;
    // How near this member is to the middle of its cell, squared because the square root would
    // buy nothing: only the ordering matters.
    const offX = this.screen.x - (column + 0.5) * this.cellPx;
    const offY = this.screen.y - (row + 0.5) * this.cellPx;
    const score = offX * offX + offY * offY;
    if (count === 1 || score < (cells[at + BEST_SCORE] ?? Number.MAX_VALUE)) {
      cells[at + BEST_SCORE] = score;
      cells[at + BEST_X] = x;
      cells[at + BEST_Y] = y;
      cells[at + BEST_Z] = z;
      // Negated, so adding this to the member's screen position lands on the cell centre.
      cells[at + NUDGE_X] = -offX;
      cells[at + NUDGE_Y] = -offY;
    }
    if (count === 1) {
      cells[at + MIN_X] = x;
      cells[at + MIN_Y] = y;
      cells[at + MIN_Z] = z;
      cells[at + MAX_X] = x;
      cells[at + MAX_Y] = y;
      cells[at + MAX_Z] = z;
    } else {
      cells[at + MIN_X] = Math.min(cells[at + MIN_X] ?? x, x);
      cells[at + MIN_Y] = Math.min(cells[at + MIN_Y] ?? y, y);
      cells[at + MIN_Z] = Math.min(cells[at + MIN_Z] ?? z, z);
      cells[at + MAX_X] = Math.max(cells[at + MAX_X] ?? x, x);
      cells[at + MAX_Y] = Math.max(cells[at + MAX_Y] ?? y, y);
      cells[at + MAX_Z] = Math.max(cells[at + MAX_Z] ?? z, z);
    }
    this.onScreenCount += 1;
    return cellId;
  }

  /** Work out which cells are crowded. Called once between the two passes. */
  resolve(): void {
    const cells = this.cells;
    const total = this.columns * this.rows;
    for (let cellId = 0; cellId < total; cellId += 1) {
      const count = cells[cellId * STRIDE + COUNT] ?? 0;
      if (count === 0) {
        continue;
      }
      if (count < this.minMembers) {
        this.individualCount += count;
        continue;
      }
      this.groupCount += 1;
      this.inGroupCount += count;
      this.largest = Math.max(this.largest, count);
    }
    this.resolved = true;
  }

  /** Whether this cell's movers are drawn as a group rather than as themselves. */
  grouped(cellId: number): boolean {
    if (cellId === OFF_SCREEN) {
      return false;
    }
    return (this.cells[cellId * STRIDE + COUNT] ?? 0) >= this.minMembers;
  }

  /**
   * The groups to draw, in grid order.
   *
   * A generator rather than an array, so nothing is allocated for the cells that hold one
   * aircraft. `resolve` has to have run: the counts it computes are what a caller reads
   * alongside this, and returning marks without them would let a rail report a group total
   * that disagreed with the marks on the globe.
   */
  *marks(): Generator<ClusterMark> {
    if (!this.resolved) {
      throw new Error('ScreenClusterer.marks() before resolve()');
    }
    const cells = this.cells;
    const total = this.columns * this.rows;
    for (let cellId = 0; cellId < total; cellId += 1) {
      const at = cellId * STRIDE;
      const count = cells[at + COUNT] ?? 0;
      if (count < this.minMembers) {
        continue;
      }
      const dx = (cells[at + MAX_X] ?? 0) - (cells[at + MIN_X] ?? 0);
      const dy = (cells[at + MAX_Y] ?? 0) - (cells[at + MIN_Y] ?? 0);
      const dz = (cells[at + MAX_Z] ?? 0) - (cells[at + MIN_Z] ?? 0);
      yield {
        cellId,
        count,
        x: cells[at + BEST_X] ?? 0,
        y: cells[at + BEST_Y] ?? 0,
        z: cells[at + BEST_Z] ?? 0,
        nudgeX: cells[at + NUDGE_X] ?? 0,
        nudgeY: cells[at + NUDGE_Y] ?? 0,
        centreX: ((cellId % this.columns) + 0.5) * this.cellPx,
        centreY: (Math.floor(cellId / this.columns) + 0.5) * this.cellPx,
        spreadM: Math.hypot(dx, dy, dz),
      };
    }
  }

  /** One group by its cell, or null when that cell is no longer crowded. */
  markFor(cellId: number): ClusterMark | null {
    for (const mark of this.marks()) {
      if (mark.cellId === cellId) {
        return mark;
      }
    }
    return null;
  }

  /** What the rail needs. Truthful whether or not anything clustered. */
  get state(): ClusterState {
    return {
      onScreen: this.onScreenCount,
      individuals: this.individualCount,
      groups: this.groupCount,
      inGroups: this.inGroupCount,
      largestGroup: this.largest,
    };
  }
}

/** Where clicking a group should take the camera. */
export interface ClusterFlyTo {
  lon: number;
  lat: number;
  /** Camera height above the ellipsoid that frames the group's members, in metres. */
  altitudeM: number;
  /** How many movers were behind the badge that was clicked. */
  count: number;
}

/**
 * The lowest a fly-to will take the camera, in metres.
 *
 * Forty kilometres, which is close enough that individual marks are at full size and a group of
 * aircraft sitting on one airport apron resolves into aircraft. Without a floor, a tight group
 * would put the camera inside the movers.
 */
export const CLUSTER_FLY_FLOOR_M = 40_000;

/**
 * A camera height that frames a group of this extent.
 *
 * With Cesium's default sixty-degree field of view the visible ground is a little wider than the
 * camera's height, so height and extent are within about fifteen per cent of each other and the
 * multiplier is margin rather than maths. The point of the flight is that the group dissolves
 * when it lands, so erring wide would leave it clustered and erring tight would hide members.
 */
export function clusterCameraHeight(spreadM: number): number {
  return Math.max(CLUSTER_FLY_FLOOR_M, spreadM * 1.2);
}

/** Prefix on the id stamped onto every group mark, so a click routes to the right layer. */
export const CLUSTER_PICK_PREFIX = 'cluster:';

/** The pick id for one group. `layerKey` names the layer that drew it. */
export function clusterPickId(layerKey: string, cellId: number): string {
  return `${CLUSTER_PICK_PREFIX}${layerKey}:${cellId}`;
}

/**
 * The layer and cell in a picked group id, or null when the pick was not a group.
 *
 * Rejects a negative or fractional cell for the same reason `noradFromPickId` rejects zero: a
 * malformed id has to read as "that was not a group" rather than as a lookup that quietly finds
 * nothing.
 */
export function parseClusterPickId(id: string | null): { layerKey: string; cellId: number } | null {
  if (!id?.startsWith(CLUSTER_PICK_PREFIX)) {
    return null;
  }
  const rest = id.slice(CLUSTER_PICK_PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split <= 0 || split === rest.length - 1) {
    return null;
  }
  const cellId = Number(rest.slice(split + 1));
  if (!Number.isSafeInteger(cellId) || cellId < 0) {
    return null;
  }
  return { layerKey: rest.slice(0, split), cellId };
}
