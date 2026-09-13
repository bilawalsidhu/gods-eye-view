/**
 * Shared construction for WorldOverlay entries (`src/overlays/worldOverlay.js`).
 *
 * Every layer-side `create*OverlayEntry` factory (earthquakes, satellites,
 * radio ×3, bikeshare, trackedReadout, cctv, cctvCards, submarine cables,
 * rocket launches ×2, local infrastructure) re-declared the same three
 * host-default presentation flags. This module owns that baseline once so a
 * drift in one factory's copy is impossible; everything else on an entry —
 * `variant`, `paintLane`, `placement`, `verticalOnly`, `edgeFade`,
 * `distanceScale`, lane/collision tuning — is a deliberate per-entry decision
 * and stays at the call site.
 *
 * The three match the host's own normalizer exactly (worldOverlay.js
 * `_normalizeEntry`): `interactive === true` else false, `horizonCull !==
 * false` else true, `terrainOcclusion === true` else false. Callers may still
 * override (the CCTV thumbnails are `interactive: true`); `...entry` wins.
 *
 * @param {object} [entry] The source-owned entry fields.
 * @returns {object} A fresh entry carrying the shared baseline plus `entry`.
 */
const SHARED_ENTRY_BASELINE = Object.freeze({
  interactive: false,
  horizonCull: true,
  terrainOcclusion: false,
});

export function createOverlayEntry(entry = {}) {
  return { ...SHARED_ENTRY_BASELINE, ...entry };
}
