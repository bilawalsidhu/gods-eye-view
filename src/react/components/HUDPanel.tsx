/**
 * HUDPanel — React wrapper for the IntelHUD class.
 *
 * IntelHUD owns its DOM inside `#intel-hud`. This placeholder div is mounted
 * so React can attach context/hooks; the HUD class manages all child DOM.
 */
import React from 'react';

export function HUDPanel(): React.JSX.Element {
  return <div id="intel-hud" aria-label="Intelligence HUD" />;
}
