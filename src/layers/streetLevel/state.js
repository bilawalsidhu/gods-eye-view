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
    capturedAtSource: null,
    /** 'day', or 'month' for providers that date images by month (Google). */
    capturedAtPrecision: 'day',
    /** Why the last nearest lookup opened nothing: 'empty', 'sky' or null. */
    nearestOutcome: null,
    /** A place name for the caption (Google's address), or null. */
    title: null,
    /** Whether the open viewer has FIT/FILL render modes. */
    renderModes: true,
    sequenceId: null,
    creator: null,
    via: null,
    license: null,
    externalUrl: null,
    /** A small picture of the image, where its source names one, or null. */
    still: null,
    loading: false,
    /**
     * Whether the viewer is still opening this image: true from the open
     * until it is accepted or given up. Unlike `loading`, which a nearest
     * lookup shares, only the viewer's own open sets it.
     */
    opening: false,
    error: null,
    // A lookup a link prepared but left to a click: {point, providerIds, radiusM}.
    armed: null,
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
    /** Counts the photos asked for (an open or a nearest lookup). */
    photoRequests: 0,
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

    /** The open image's marker: its draw set and drawn icon. */
    marker: { set: null, placed: null, look: null },
    clickSubscription: null,
  };
}
