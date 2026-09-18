/** Maximum retention of missing records during an incomplete refresh. */
export const PARTIAL_RETENTION_MS = 5 * 60 * 1000;

/** Complete refreshes a selected-but-missing vessel remains pinned. */
export const SELECTED_PIN_REFRESHES = 3;

export const AIS_FIRST_CONNECT_LABEL = 'awaiting first AIS position…';

/**
 * Transport statuses that are NOT feed faults even with zero rows: the
 * serverless collector (server/providers/vessels/ais-serverless.js) answers
 * 'empty' for a scene with no vessel in it and 'degraded' when it is serving
 * a fallback (last-good, AISHub, demo replay). Neither may trip the
 * definitive-failure path that marks the layer UNAVAILABLE.
 */
export const AIS_NON_FAULT_STATUSES = Object.freeze(
  new Set(['empty', 'degraded']),
);

/** Half-width (degrees) of the scene box sent with each vessel poll. */
export const AIS_SCENE_HALF_WIDTH_DEG = 1.5;

/** Guidance text when a poll reports zero vessels without naming a reason. */
export const AIS_EMPTY_SCENE_MESSAGE = 'No vessels in scene';
