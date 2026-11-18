/**
 * Fleet contacts as the Flights and Vessels layers draw them (`index.js`):
 * the fleet model set and its loader, model and size resolution, the
 * icon-to-model handover distances, model lighting and tint, part-state
 * drivers and vessel hull sprites.
 */
import type { Color, ModelPartState } from '../render/contract/index';
import type { PartTable } from '../render/modelParts';

/** A colour as `[r, g, b, a]`, 0..1. */
export type FleetRgba = readonly [number, number, number, number];

/** The loaded fleet model set (`loadFleetModelSet`). */
export interface FleetModelSet {
  /** `catalog.json`: each model's file, bounds, length, beam, clearance and icon class. */
  readonly catalog: Record<string, FleetCatalogModel>;
  /** `types.json`: which model draws which type, and the fallbacks. */
  readonly types: FleetTypes;
  /** Each model's GLB bytes by name; a model whose GLB did not load is absent. */
  readonly bytes: ReadonlyMap<string, Uint8Array>;
  readonly loadMs: number;
  readonly totalBytes: number;
}

/** One model of `catalog.json`. */
export interface FleetCatalogModel {
  readonly file: string;
  readonly category: string;
  readonly icon?: string;
  readonly length: number;
  readonly beam?: number;
  readonly clearance: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly [key: string]: unknown;
}

/** `types.json`, as the resolvers read it. */
export interface FleetTypes {
  readonly [key: string]: unknown;
}

/** A model and the length (metres) it is drawn at; null draws it as built. */
export interface FleetModelChoice {
  model: string;
  length: number | null;
}

/** The drawing of a fleet model at a size (`fleetModelSpec`). */
export interface FleetModelSpec {
  readonly model: string;
  readonly url: string;
  readonly category: string;
  readonly icon?: string;
  /** Metres along the body, as drawn. */
  readonly length: number;
  /** The uniform scale along the model's length. */
  readonly scale: number;
  /** The length, beam and height scales. */
  readonly scaleXYZ: readonly [number, number, number];
  /** How far the model reaches below its origin at this scale. */
  readonly clearanceM: number;
  /** How far the model's origin stands above the route it follows. */
  readonly elevationM: number;
  /** Whether its meshes carry the `_TINT` attribute a route colour paints. */
  readonly tinted: boolean;
  readonly nativeRadiusM: number;
  readonly visualCenterNative: readonly [number, number, number];
  readonly trailAnchorNative: readonly [number, number, number];
  /** Its identity: model and scales. */
  readonly key: string;
  /** An aid to navigation's: it has no heading to turn to. */
  readonly fixed?: boolean;
}

/** An aircraft's model spec as the aircraft layers draw it. */
export interface AircraftLayerModelSpec extends Omit<
  FleetModelSpec,
  'model' | 'url'
> {
  /** Null before the set has loaded. */
  readonly model: string | null;
  readonly url: string | null;
  /** How far a grounded aircraft's origin stands above the ground. */
  readonly bellyM: number;
}

/** What picks an aircraft's model. */
export interface FleetAircraft {
  typeCode?: string | null;
  type?: string | null;
  category?: string | number | null;
  callsign?: string | null;
}

/** What picks a vessel's model. */
export interface FleetVessel {
  type?: string | number | null;
  mmsi?: string | number | null;
  virtual?: boolean;
  length?: number | null;
  beam?: number | null;
  name?: string | null;
}

/** What picks a transit or rail vehicle's model. */
export interface FleetTransitVehicle {
  railCategory?: string;
  railMode?: string;
  routeType?: number | string;
  mode?: string;
}

/** The icon-to-model rules every fleet layer follows. */
export interface FleetModelPolicy {
  /** No model above this camera height. */
  readonly altitudeCeilingM: number;
  /** Models drawn in the nearby mode, and in the all mode. */
  readonly cap: number;
  readonly capAll: number;
  /** A contact this near gets a model; one that has one keeps it this near. */
  readonly addM: number;
  readonly keepM: number;
  /** How often eligibility is worked out again. */
  readonly intervalMs: number;
}

/** How an aircraft model's colour meets its mesh (`ModelItem.colorBlend`). */
export interface AircraftModelBlend {
  mode: 'highlight' | 'mix';
  amount?: number;
}

/** What an aircraft's part state is driven by. */
export interface FleetAircraftMotion {
  onGround?: boolean;
  heightAboveGroundM?: number | null;
  altitudeM?: number | null;
  verticalRateMps?: number | null;
  speedMps?: number | null;
}

/** Where the model set is served, relative to the application base. */
export const FLEET_MODEL_BASE: string;
export function resolveAircraft(
  types: FleetTypes,
  type?: string | null,
  category?: string | null,
  callsign?: string | null,
): FleetModelChoice;
export function resolveVessel(
  types: FleetTypes,
  shipType?: number | null,
  length?: number | null,
  beam?: number | null,
  name?: string | null,
): FleetModelChoice;
export function resolveTransit(
  types: FleetTypes,
  vehicle?: FleetTransitVehicle,
): FleetModelChoice;
export function fleetModelSpec(
  set: Pick<FleetModelSet, 'catalog' | 'types'>,
  name: string,
  length: number | null,
  options?: { beam?: number },
): FleetModelSpec;
export function aircraftModelSpec(
  set: Pick<FleetModelSet, 'catalog' | 'types'>,
  aircraft?: FleetAircraft,
): FleetModelSpec;
/** Null for a virtual aid to navigation: nothing physical stands there. */
export function vesselModelSpec(
  set: Pick<FleetModelSet, 'catalog' | 'types'>,
  vessel?: FleetVessel,
): FleetModelSpec | null;
export function transitModelSpec(
  set: Pick<FleetModelSet, 'catalog' | 'types'>,
  vehicle: FleetTransitVehicle,
): FleetModelSpec;
/** Model `name`'s part table, read once from its GLB; null for none. */
export function fleetPartTable(
  set: Pick<FleetModelSet, 'bytes'> | null | undefined,
  name: string | null | undefined,
): PartTable | null;
/** The set once loaded, else null. */
export function fleetModelSet(): FleetModelSet | null;
/** The load started, or null when none has. */
export function fleetModelSetLoading(): Promise<FleetModelSet> | null;
/** Fetches the set's JSON and every GLB once, up front. */
export function loadFleetModelSet(options?: {
  resolveAsset?: (url: string) => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<FleetModelSet>;

export const UNLOADED_AIRCRAFT_MODEL_SPEC: AircraftLayerModelSpec;
export function aircraftLayerModelSpec(
  aircraft: FleetAircraft | null | undefined,
  set?: FleetModelSet | null,
): AircraftLayerModelSpec;
export function aircraftModelSpecCacheKey(
  aircraft: FleetAircraft | null | undefined,
  set?: FleetModelSet | null,
): string;

export const EMERGENCY_TINT: FleetRgba;
export const FLEET_MODEL_POLICY: FleetModelPolicy;
/** The handover: a contact within this many metres of the eye is drawn as its model. */
export const MODEL_ADD_M: number;
export const MODEL_KEEP_M: number;
export const MODEL_ALT_CEIL_M: number;
export const MODEL_HEADING_OFFSET_DEG: number;
export const MODEL_MAX: number;
export const MODEL_MAX_ALL: number;
export const MODEL_WHITE: FleetRgba;

export const AIRCRAFT_ENVIRONMENT_MAP_OPTIONS: { readonly enabled: boolean };
export const AIRCRAFT_MODEL_TINT_MIX: number;
export function aircraftModelBlend(
  irBoost: boolean,
  tint?: ArrayLike<number> | null,
): AircraftModelBlend;

export function aircraftPartState(
  table: PartTable | null | undefined,
  aircraft: FleetAircraftMotion,
): ModelPartState | undefined;
/** An airport vehicle (class `vehicle`) rolls as a road vehicle; any other contact flies. */
export function aircraftLayerPartState(
  table: PartTable | null | undefined,
  contact: FleetAircraftMotion & { klass?: string | null },
): ModelPartState | undefined;
export function vesselPartState(
  table: PartTable | null | undefined,
  vessel: { speedMps?: number | null },
): ModelPartState | undefined;
export function groundVehiclePartState(
  table: PartTable | null | undefined,
  vehicle: { speedMps?: number | null; atStop?: boolean },
): ModelPartState | undefined;

/**
 * Which contacts may hold a model: `[id, distanceSq, onScreen]` inside the
 * keep radius, nearest first, on-screen first under the cap.
 */
export function selectModelEligible(
  candidates: ReadonlyArray<readonly [string, number, boolean]>,
  options: {
    cap: number;
    addDistSq: number;
    isModeled: (id: string) => boolean;
  },
): Set<string>;

/** Every fleet model is nose -X: opposite the draw contract's heading 0. */
export const FLEET_HEADING_OFFSET_DEG: number;
/** The per-axis stretch a spec draws with on top of its length scale, if any. */
export function fleetAxisScale(
  spec: Pick<FleetModelSpec, 'scaleXYZ'> | null | undefined,
): [number, number, number] | undefined;
/** A colour as the draw contract takes it; null for none. */
export function fleetColor(
  color:
    | Color
    | { red: number; green: number; blue: number; alpha?: number }
    | null
    | undefined,
): Color | null;

export const VESSEL_SPRITE_PX: number;
/** The white hull sprite of a vessel kind, bow up, as an SVG data URI. */
export function vesselSprite(kind: string): string;
/** The buoy sprite of an aid to navigation, as an SVG data URI. */
export function aidSprite(): string;

export const VESSEL_KINDS: readonly string[];
export const VESSEL_KIND_STYLES: Readonly<
  Record<string, { readonly css: string; readonly accent: string }>
>;
export function isAidToNavigation(vessel?: {
  type?: string | number | null;
  mmsi?: string | number | null;
  virtual?: boolean;
}): boolean;
export function normalizeVesselType(
  type: string | number | null | undefined,
): string;
export function vesselKind(type: string | number | null | undefined): string;
