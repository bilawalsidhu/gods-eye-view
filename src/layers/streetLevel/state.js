import { FILTER_DEFAULT } from './policy.js';

/**
 * The per-image fields of `state.street` with no image open; closing resets
 * exactly these (host and render mode outlive an image).
 */
export function freshStreet() {
  return {
    open: false,
    providerId: null,
    providerName: null,
    providerLabel: null,
    imageId: null,
    position: null,
    bearing: null,
    tilt: null,
    altitude: null,
    isPano: false,
    capturedAt: null,
    sequenceId: null,
    creator: null,
    externalUrl: null,
    loading: false,
    error: null,
  };
}

/** Mutable core state, created once per layer instance. */
export function createState({ services }) {
  return {
    services,
    viewer: null,
    enabled: false,
    initialized: false,
    destroyed: false,
    listeners: new Set(),
    notify: null,
    /** Shared imagery filter, in the stored (relative-days) form. */
    filter: { ...FILTER_DEFAULT },
    /** @type {Map<string, {def: object, instance: object, on: boolean}>} */
    providers: new Map(),

    street: {
      host: null,
      /** 'letterbox' shows the whole image; 'fill' crops it to the frame. */
      renderMode: 'letterbox',
      ...freshStreet(),
    },

    marker: { collection: null, billboard: null },
    clickHandler: null,
  };
}
