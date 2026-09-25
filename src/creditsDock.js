/**
 * On-screen attribution dock — the app's compliance surface for the
 * Google Maps Platform ToS, which requires VISIBLE attribution for
 * Photorealistic 3D Tiles (PLAN.md Batch 6, matrix check C13).
 *
 * History: the operator detached Cesium's credit container on 2026-08-29
 * (recorded in main.js), which removed the strip AND the "Data attribution"
 * lightbox with it — C13 reported the gap as SKIPPED[OWNER-RUN] every run
 * rather than silently dropping the signal. 2026-09-24 this module restores
 * the surface as a compact fixed dock: the same container Cesium already
 * builds its credit display inside, re-parented to the document so the
 * on-screen line (Google/Cesium logos + the lightbox expand link) renders,
 * while the lightbox itself keeps the capped, scrollable panel style.css
 * has carried since 2026-09-12. The bottom-left default is occupied by app
 * chrome and hidden outright (`.cesium-viewer-bottom { display:none }`), so
 * the dock parks bottom-RIGHT, above the panel tier but below the modal
 * tiers, and never participates in clean-view (attribution is a legal
 * surface, not chrome — the L9 matrix asserts exactly that contract).
 *
 * This module is DOM-only on purpose: it takes an injected `document` so the
 * unit test can drive it with element stubs, and it is idempotent — calling
 * it twice (HMR, re-init) never duplicates the dock.
 */

const DOCK_CLASS = 'gev-credit-dock';

/**
 * Append the viewer's credit container to the document inside the dock.
 *
 * @param {{ creditContainer?: Element, cesiumWidget?: { creditContainer?: Element } }} viewer
 *   Viewer-like object. NOTE: Cesium's Viewer has NO `creditContainer` of its
 *   own — the option is forwarded to the widget, so the live element hangs
 *   off `viewer.cesiumWidget.creditContainer` (verified against the installed
 *   Cesium 1.144 source: CesiumWidget exposes the getter, Viewer does not).
 * @param {Document} [doc] - Document to attach into; defaults to the global.
 * @returns {Element|null} The dock wrapper, or null when there is nothing to
 *   attach (no viewer/container, or no document to attach into).
 */
export function attachCreditDock(viewer, doc) {
  const documentRef = doc ?? (typeof document !== 'undefined' ? document : null);
  const creditContainer = viewer?.creditContainer ?? viewer?.cesiumWidget?.creditContainer;
  if (!documentRef?.body || !creditContainer) return null;
  // Idempotency: an already-connected container means the dock exists (or a
  // previous call docked it) — never wrap the live credit display again.
  if (creditContainer.isConnected) return creditContainer.parentElement;
  const dock = documentRef.createElement('div');
  dock.className = DOCK_CLASS;
  dock.dataset.testid = 'credit-dock';
  dock.appendChild(creditContainer);
  documentRef.body.appendChild(dock);
  return dock;
}
