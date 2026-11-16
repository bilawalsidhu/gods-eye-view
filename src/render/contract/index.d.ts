/**
 * The renderer contract: what the application asks of a renderer, typed
 * one file per port.
 */
export * from './common';
export * from './renderer';
export * from './frame';
export * from './globe';
export * from './draw';
export * from './camera';
export * from './query';
export * from './input';
export * from './effects';
export * from './credits';
export * from './quality';

/** Every capability a renderer may list. */
export declare const CAPABILITIES: readonly import('./common').Capability[];

/** The contract version this module describes. */
export declare const CONTRACT_VERSION: import('./renderer').ContractVersion;

/** One port's members: null when required, else the capability that adds it. */
export type PortDescriptor = Readonly<
  Record<string, import('./common').Capability | null>
>;

/** Every port's members, by port name. */
export declare const PORTS: Readonly<Record<string, PortDescriptor>>;

/** One of the roles a renderer plays, and the members that make it up. */
export interface ContractRole {
  readonly id: 'surface' | 'scene' | 'view' | 'queries' | 'look' | 'host';
  readonly title: string;
  readonly summary: string;
  /** `port` or `port.member`; the most specific entry wins. */
  readonly members: readonly string[];
}

/** What a renderer does, by role: every member of {@link PORTS} in one. */
export declare const ROLES: readonly ContractRole[];

/**
 * The role of `port`'s `member` (dotted), or of the port itself without one;
 * undefined for a member the port does not have.
 */
export declare function roleOf(
  port: string,
  member?: string,
): ContractRole['id'] | undefined;

/** Every quality setting a renderer may support. */
export declare const QUALITY_KEYS: readonly import('./quality').QualityKey[];

/** The phases and steps of one frame, in order. */
export declare const FRAME_STEPS: readonly import('./frame').FrameStep[];

/**
 * What a renderer is missing against the contract: each required member it
 * lacks, and each capability-gated member present without its capability.
 */
export declare function checkRendererShape(renderer: unknown): string[];

/** What one port (or handed-out shape) is missing against its descriptor. */
export declare function checkPortShape(
  target: object,
  port: string,
  capabilities: ReadonlySet<string>,
): string[];
