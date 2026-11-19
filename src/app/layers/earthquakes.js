import { createEarthquakesLayer } from '../../layers/earthquakes/index.js';
import { overlayHost } from './overlayHost.js';
import { inputFor } from '../../input/dispatcher.js';
import * as picking from '../../data/pickRegistry.js';
import * as context from '../../data/contextStore.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { requestWorldFocus } from '../../worldFocus.js';
import { createEarthquakeRipples } from './earthquakeRipples.js';
import { heightsOf } from '../../queries/heights.js';
import { formatDate, formatNumber, t } from '../../i18n/index.js';

const EVENT_TIME = Object.freeze({
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

/** The clicked quake's card text, in the page's language. */
export const earthquakeCardText = Object.freeze({
  t,
  formatTime: (time) => formatDate(time, EVENT_TIME),
  formatDepth: (km) => formatNumber(km, { maximumFractionDigits: 1 }),
});

/**
 * Wire earthquake observations to the application overlay host, and its
 * discs to the globe's clicks: a clicked quake shows its detail card.
 */
export function createApplicationEarthquakes(options) {
  return createEarthquakesLayer({
    overlayHost,
    input: (viewer) => inputFor(viewer),
    picking,
    context,
    pointer: { isPointerFree },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    focus: { requestWorldFocus },
    ripples: createEarthquakeRipples(),
    // The loaded ground (terrain or tiles) the clamped disc is draped on.
    groundHeight: (viewer, lon, lat) =>
      viewer ? heightsOf(viewer).now({ lon, lat }) : null,
    text: earthquakeCardText,
    ...options,
  });
}
