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
    /** 'day', or 'month' for providers that date images by month (Google). */
    capturedAtPrecision: 'day',
    /** A place name for the caption (Google's address), or null. */
    title: null,
    /** Whether the open viewer has FIT/FILL render modes. */
    renderModes: true,
    sequenceId: null,
    creator: null,
    license: null,
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
    listeners: new Set(),
    notify: null,
    /** Shared imagery filter, in the stored (relative-days) form. */
    filter: { ...FILTER_DEFAULT },
    /** @type {Map<string, {def: object, instance: object, on: boolean, status: object|null}>} */
    providers: new Map(),

    street: {
      host: null,
      /** 'letterbox' shows the whole image; 'fill' crops it to the frame. */
      renderMode: 'letterbox',
      ...freshStreet(),
    },

    /** Whether the camera is low enough for a ground click to open an image. */
    groundClickReady: false,

    marker: { collection: null, billboard: null, look: null },
    clickHandler: null,
  };
}
