// The vessel chevron artwork, engine-neutral: one SVG data URL per colour
// and variant. Cesium's billboards load the URL; the Navara renderer draws
// the same SVGs into its atlas, keyed by the same URL.

import { VESSEL_TYPE_CSS_COLORS } from '../../data/vesselLabels.js';

/** The chevron's artwork size (CSS px), before the billboard scale. */
export const VESSEL_ICON_PX = 32;

/** The selected variant's colour. */
export const VESSEL_SELECTED_CSS = '#ffffff';

/**
 * A chevron/delta-wing SVG data URL tinted `cssColor`. The shape points north
 * (up) so the billboard rotation maps directly to heading.
 * @param {string} cssColor
 * @param {boolean} selected The white/brighter selected variant.
 * @returns {string}
 */
export function vesselChevronIcon(cssColor, selected) {
  const stroke = selected ? 'rgba(6,26,32,0.95)' : 'rgba(4,18,24,0.9)';
  const strokeWidth = selected ? 1.1 : 0.7;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="translate(16,16)">
      <path d="M0,-14 L11,10 L4,7 L0,14 L-4,7 L-11,10 Z" fill="${cssColor}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
    </g>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

/** Every chevron the layer can draw: the type colours and the selected one. */
export function allVesselChevronIcons() {
  return [
    ...VESSEL_TYPE_CSS_COLORS.map((css) => vesselChevronIcon(css, false)),
    vesselChevronIcon(VESSEL_SELECTED_CSS, true),
  ];
}
