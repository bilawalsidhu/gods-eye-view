/**
 * The attribution panel.
 *
 * These credits are licence conditions, not decoration. adsb.lol publishes under ODbL
 * 1.0, which requires attribution wherever the data is shown, and NASA asks for a credit
 * on GIBS imagery. The list comes from `/api/capabilities` so a source added to the
 * backend cannot ship without its credit.
 */

import type { AttributionEntry } from '../types/entities';

/**
 * Shown before the capabilities call answers, and kept if it never does.
 *
 * Deliberately duplicated from the backend for these two only: the GIBS basemap renders
 * straight from NASA without our API being reachable at all, so its credit cannot depend
 * on our API being up, and the aircraft layer must never be visible uncredited.
 */
export const BASELINE_CREDITS: readonly AttributionEntry[] = [
  {
    source: 'adsb.lol',
    text: 'Aircraft data from adsb.lol',
    url: 'https://adsb.lol',
    licence: 'ODbL 1.0',
  },
  {
    source: 'NASA GIBS',
    text: 'Imagery courtesy of NASA EOSDIS GIBS',
    url: 'https://gibs.earthdata.nasa.gov',
    licence: 'Public domain, attribution requested',
  },
];

export class AttributionPanel {
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('attribution');
    this.render(BASELINE_CREDITS);
  }

  render(entries: readonly AttributionEntry[]): void {
    const shown = entries.length > 0 ? entries : BASELINE_CREDITS;
    this.root.replaceChildren(
      ...shown.map((entry) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = entry.url;
        link.rel = 'noreferrer';
        link.target = '_blank';
        link.textContent = entry.text;
        const licence = document.createElement('span');
        licence.className = 'attribution-licence';
        licence.textContent = ` (${entry.licence})`;
        item.append(link, licence);
        return item;
      }),
    );
  }
}
