import { fallbackHeadingFromId } from './normalize.js';

/**
 * Public Peatonal Dufaur feed embedded by Noticias Monte Hermoso, courtesy of
 * Montevisión. The publisher's HTML supplies the canonical, unsigned master:
 * https://www.noticiasmontehermoso.com.ar/camara-de-monte-hermoso-en-vivo/
 *
 * Approximate pedestrian-area anchor (Patio Dufaur), not a surveyed mount:
 * https://www.openstreetmap.org/way/782261091
 * https://mapcarta.com/es/W782261091
 *
 * Keep the master URL: it issues a fresh hls_ctx for its same-origin TS playlist.
 * No session URL or video is bundled, and no browser-supplied URL is accepted.
 */
export function loadMonteHermosoSources() {
  const id = 'monte-hermoso-peatonal-dufaur';
  return [
    {
      id,
      code: 'DUFAUR',
      name: 'Peatonal Dufaur (approx. location)',
      city: 'Monte Hermoso, Argentina',
      provider: 'Montevisión',
      sourceKind: 'monte-hermoso-webcam',
      feedType: 'hls',
      url: 'https://encoder-1b.montevision.com.ar/live/monte2.m3u8',
      lat: -38.988,
      lon: -61.2865,
      headingDeg: fallbackHeadingFromId(id),
      headingConfidence: 'low',
      groundElevationM: 10,
      credit:
        'Montevisión · Noticias Monte Hermoso · approximate pedestrian-area location',
      license:
        'Publicly published webcam; provider rights retained, no open-data ' +
        'redistribution license established. Map reference: ' +
        '© OpenStreetMap contributors (ODbL).',
    },
  ];
}
