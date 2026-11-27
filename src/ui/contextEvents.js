/** Reveal Context's view, Inspect, or a requested list. */
export const CONTEXT_SHOW_VIEW_EVENT = 'gev:context-show-view';

/**
 * Sent on the document when a request asks Context for what is nearby (voice
 * "contacts", the retired Radio panel's name): Context lets go of its pick and
 * shows Inspect, which lists what is around and, while Radio is on, its
 * stations.
 */
export const CONTEXT_NEARBY_EVENT = 'gev:context-nearby';

/** Show Missions in Inspect and keep an active follow available on Back. */
export const CONTEXT_MISSIONS_EVENT = 'gev:context-missions';

/**
 * Sent on the document when a place is picked: a place row or
 * chip in search, or a voice request that names a place. Only these open a
 * place's card. `detail: {name, latitude?, longitude?, query?}`.
 */
export const PLACE_PICK_EVENT = 'gev:place-pick';

/**
 * Sent on the document when a request asks for a camera's settings (voice or
 * search naming the camera tools or the retired CCTV panel): with a camera's
 * card open, Context shows its Camera settings tab.
 */
export const CAMERA_SETTINGS_EVENT = 'gev:camera-settings';

/**
 * Open dialogs that keep Esc for themselves: while one is open, Context and
 * the map leave Esc alone. A popup that takes its own Esc is marked
 * data-owns-escape (a camera's enlarged view, CctvPreview.vue).
 */
export const ESCAPE_OWNING_DIALOGS =
  'dialog[open], [aria-modal="true"], [role="dialog"][data-owns-escape]';
