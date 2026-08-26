/**
 * DataPanel — placeholder confirming React integration for the data panel.
 *
 * The #data-panel and #data-toggles DOM is owned by vanilla JS (index.html).
 * LayerPanel renders into #data-toggles. This component is a future hook point.
 */
import React from 'react';

export function DataPanel(): React.JSX.Element {
  // #data-panel / #data-toggles already exist in index.html — do not re-declare.
  // LayerPanel handles rendering into #data-toggles.
  return <></>;
}

