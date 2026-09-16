/**
 * Resolve where Cockpit's Display/Radio strip hangs in the right margin.
 *
 * The strip is anchored under the REC readout it shares that margin with, and
 * is pulled back up whenever the briefing card below would otherwise be
 * overrun — never above `minTop`, so it can't climb into the topline. The
 * returned `maxHeight` is measured from that resolved top, so a corridor the
 * strip cannot honour by moving is honoured by shrinking instead.
 *
 * @param {object} input Measured rectangles and sizing knobs, all in px.
 * @param {number} input.recBottom Bottom edge of the REC readout, in px.
 * @param {number} input.signalTop Top edge of the briefing card, in px.
 * @param {number} input.stripHeight Rendered height of the strip, in px.
 * @param {number} input.viewportHeight Viewport height, in px.
 * @param {number} [input.collapsedHeight] Height of one collapsed launcher.
 * @param {number} [input.recGap] Clearance under the REC readout.
 * @param {number} [input.signalGap] Clearance above the briefing card.
 * @param {number} [input.minTopFloor] Absolute ceiling for the strip, in px.
 * @param {number} [input.minTopRatio] Viewport-relative ceiling, 0..1.
 * @returns {{ top: number, maxHeight: number }} Resolved strip top and the
 *   height it may occupy below that top, in px.
 */
export function resolveCockpitUtilityAnchor({
  recBottom,
  signalTop,
  stripHeight,
  viewportHeight,
  collapsedHeight = 0,
  recGap = 12,
  signalGap = 8,
  minTopFloor = 96,
  minTopRatio = 0.12,
}) {
  const viewport = Math.max(0, Number(viewportHeight) || 0);
  const minTop = Math.max(minTopFloor, viewport * minTopRatio);
  const anchoredTop = Math.max(minTop, (Number(recBottom) || 0) + recGap);
  const strip = Math.max(0, Number(stripHeight) || 0);
  const signal = Number(signalTop);
  const lowerBound = Number.isFinite(signal) ? signal : viewport;
  const clearedTop = lowerBound - signalGap - strip;
  const top = Math.max(minTop, Math.min(anchoredTop, clearedTop));
  const floor = Math.max(0, Number(collapsedHeight) || 0) || 50;

  return { top, maxHeight: Math.max(floor, lowerBound - top - signalGap) };
}

/**
 * Resolve whether a collapsed Cockpit utility launcher can share the desktop
 * corridor with the currently expanded utility panel.
 *
 * @param {object} input Corridor measurement and launcher sizes, in px.
 * @param {number} input.availableHeight Usable corridor height.
 * @param {number} input.expandedHeight Rendered height of the expanded panel.
 * @param {number} input.collapsedHeight Rendered height of one collapsed launcher.
 * @param {number} [input.gap] Spacing between the panel and the launcher.
 * @param {number} [input.minimumExpandedHeight] Floor the expanded panel never
 *   shrinks below, even when the corridor cannot honour it.
 * @returns {{ primaryOnly: boolean, expandedMaxHeight: number }} Whether the
 *   launcher must be hidden, and the panel's allowed height.
 */
export function resolveCockpitUtilityLayout({
  availableHeight,
  expandedHeight,
  collapsedHeight,
  gap = 7,
  minimumExpandedHeight = 120,
}) {
  const available = Math.max(minimumExpandedHeight, Number(availableHeight) || 0);
  const expanded = Math.max(0, Number(expandedHeight) || 0);
  const collapsed = Math.max(0, Number(collapsedHeight) || 0);
  const spacing = Math.max(0, Number(gap) || 0);
  const primaryOnly = expanded + spacing + collapsed > available;

  return {
    primaryOnly,
    expandedMaxHeight: Math.max(
      minimumExpandedHeight,
      available - (primaryOnly ? 0 : spacing + collapsed),
    ),
  };
}

