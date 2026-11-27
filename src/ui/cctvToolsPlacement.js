// Where the camera tools (CctvTools.vue) sit: in their hidden home in
// Context, or in the `#cctv-tools-slot` of Context's Camera settings tab.
// The same element moves, so the controls CctvControls read once at
// start-up keep working. The frame and video surfaces stay in the home.
// Context registers the home and moves the tools with the Camera settings
// slot (ContextView.vue).

let home = null;
let tools = null;

/** @param {HTMLElement|null} element Context's hidden home for the tools. */
export function registerCctvToolsHome(element) {
  home = element || null;
  tools = home?.querySelector('#cctv-tools') ?? tools;
  placeCctvTools();
}

/** Put the tools in the tab's slot when there is one, else home. */
export function placeCctvTools(
  slot = globalThis.document?.getElementById('cctv-tools-slot') ?? null,
) {
  if (!slot) return returnCctvToolsHome();
  if (!home || !tools || tools.parentElement === slot) return;
  slot.appendChild(tools);
}

/**
 * Return the tools home (before the tab's slot goes). Leaving the tab while
 * calibration's Adjust is on turns it off, so its handles on the globe do
 * not outlive the only control that ends them.
 */
export function returnCctvToolsHome() {
  if (!home || !tools || tools.parentElement === home) return;
  const adjust = tools.querySelector('#cctv-adjust-btn');
  if (adjust?.getAttribute('aria-pressed') === 'true') adjust.click();
  home.appendChild(tools);
}
