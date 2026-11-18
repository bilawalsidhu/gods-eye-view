/**
 * @module maps/attribution
 * @description The on-map credits of the map stacks' sources, and Esri
 * World Imagery's tile address, which the globe and the card previews share.
 */

// Attribution and service rights are documented in DATA_SOURCES.md.
/** Esri World Imagery's tiles; Stories' card images draw from the same. */
export const ESRI_TILES =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
/** Esri World Imagery's credit line, as plain text. */
export const ESRI_IMAGERY_CREDIT =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';
