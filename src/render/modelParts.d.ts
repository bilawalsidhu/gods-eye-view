/**
 * A model's moving parts (`modelParts.js`): its part table and the maths
 * that turns a model item's `parts` into one matrix per part, so a renderer
 * that poses parts draws exactly those.
 */
import type { ModelPartState } from './contract/index';

/** What a part does: what live data drives and what is offered first. */
export type PartKind =
  'body' | 'spin' | 'hinge' | 'slide' | 'deploy' | 'separable' | 'marker';

/** `[x, y, z]`. */
export type PartVec3 = readonly [number, number, number];

/** One part of a model, as its table gives it (glTF frame, metres and degrees). */
export interface ModelPart {
  /** Its `_PART` index. */
  readonly index: number;
  readonly name: string;
  readonly kind: PartKind;
  /** The part it rides, or null for the body. */
  readonly parent: string | null;
  /** Its parent's index, or -1 for the body. */
  readonly parentIndex: number;
  /** The point it turns about; the origin for the body. */
  readonly pivot: PartVec3;
  /** Its axis of motion, unit length; null where the table gives none. */
  readonly axis: PartVec3 | null;
  /** `[stowed, deployed]`: degrees for hinge and deploy, metres for slide and separable. */
  readonly limits: readonly [number, number] | null;
  /** The value it is drawn at in the file; null without limits. */
  readonly rest: number | null;
}

/** A model's part table: its parts in `_PART` index order, the body first. */
export interface PartTable {
  readonly parts: readonly ModelPart[];
  /** A part's index by its name. */
  readonly byName: ReadonlyMap<string, number>;
}

/** Where and how `partMatrices` writes. */
export interface PartMatricesOptions {
  /** Where in `out` the first matrix goes; 0 by default. */
  readonly offset?: number;
  /** Gets each part's `PART_HIDDEN` and `PART_HIGHLIGHT`, from `flagsOffset`. */
  readonly flags?: Uint8Array;
  readonly flagsOffset?: number;
  /** The model's stretch along its glTF axes (`axisScale`): parts then turn rigidly in the stretched model. */
  readonly scale?: PartVec3 | null;
}

export const PART_KINDS: readonly PartKind[];
export const PART_HIDDEN: 1;
export const PART_HIGHLIGHT: 2;

/** Whether a pose's `highlight` asks for one: true, or a colour (a non-empty string, or three or four finite numbers). */
export function asksHighlight(value: unknown): boolean;

/** The part table in a node's glTF `extras`; null when it has none. Throws on a malformed table. */
export function partTableOf(extras: unknown): PartTable | null;

/** The glTF JSON of a GLB. Throws when the bytes are not a GLB. */
export function glbJson(glb: Uint8Array | ArrayBuffer): Record<string, unknown>;

/** The part table of a glTF document; null when no node has one. */
export function gltfPartTable(gltf: Record<string, unknown>): PartTable | null;

/** The part table of a GLB's bytes; null for a model without one. */
export function readPartTable(glb: Uint8Array | ArrayBuffer): PartTable | null;

/** Where the scene's first mesh is drawn: its node's transform with its parents', column-major 4×4. */
export function gltfMeshMatrix(gltf: Record<string, unknown>): number[];

/**
 * Each part's column-major 4×4 matrix for `state` at `timeS` seconds into
 * `out`, in `_PART` order, in the model's glTF frame. Whether any part is
 * not at rest.
 */
export function partMatrices(
  table: PartTable,
  state: ModelPartState | null | undefined,
  timeS: number,
  out: Float32Array | Float64Array,
  options?: PartMatricesOptions,
): boolean;
