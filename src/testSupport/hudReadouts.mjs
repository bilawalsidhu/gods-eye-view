// src/testSupport/hudReadouts.mjs — the Intel HUD's published readouts by the
// element ids its view renders them in, for tests that drive IntelHUD alone.

const FIELDS = Object.freeze({
  'hud-alt': 'alt',
  'hud-summary': 'summary',
  'hud-mgrs': 'mgrs',
  'hud-latlon': 'latlon',
  'hud-bottom-line': 'bottom',
  'hud-gsd': 'gsd',
  'hud-coll': 'coll',
  'hud-ona': 'ona',
  'hud-mode': 'mode',
  'hud-timestamp': 'timestamp',
});

/**
 * A `publish` to hand IntelHUD and each readout's latest text.
 * @returns {{publish: (view: object) => void, view: () => ?object,
 *   elements: Map<string, {readonly textContent: string}>}}
 */
export function hudReadouts() {
  let view = null;
  const elements = new Map(
    Object.entries(FIELDS).map(([id, field]) => [
      id,
      {
        get textContent() {
          return view?.[field] ?? '';
        },
      },
    ]),
  );
  return { publish: (next) => (view = next), view: () => view, elements };
}
