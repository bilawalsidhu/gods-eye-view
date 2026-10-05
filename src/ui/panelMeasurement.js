/**
 * Measure unconstrained visible content without feeding the allocated outer
 * height back into the next layout pass.
 * @param {HTMLElement} panel Panel whose natural height is needed.
 * @param {Function} getComputedStyle Style reader for the panel's document.
 * @returns {number} Natural height in CSS pixels.
 */
export function measurePanelNaturalHeight(panel, getComputedStyle) {
  const inner = [...panel.children].find(
    (child) => !child.classList.contains('panel-glow'),
  );
  if (!inner)
    return Math.ceil(
      panel.scrollHeight || panel.getBoundingClientRect().height,
    );

  const innerRect = inner.getBoundingClientRect();
  const panelStyle = getComputedStyle(panel);
  const innerStyle = getComputedStyle(inner);
  const paddingBottom = parseFloat(innerStyle.paddingBottom) || 0;
  let contentBottom = parseFloat(innerStyle.paddingTop) || 0;

  for (const child of inner.children) {
    const childStyle = getComputedStyle(child);
    if (childStyle.display === 'none' || childStyle.visibility === 'hidden')
      continue;
    const childRect = child.getBoundingClientRect();
    const marginBottom = parseFloat(childStyle.marginBottom) || 0;
    const naturalChildHeight = Math.max(
      childRect.height,
      child.scrollHeight || 0,
    );
    const childBottom =
      childRect.top - innerRect.top + naturalChildHeight + marginBottom;
    contentBottom = Math.max(contentBottom, childBottom);
  }

  const wrapperChrome =
    (parseFloat(panelStyle.borderTopWidth) || 0) +
    (parseFloat(panelStyle.borderBottomWidth) || 0) +
    (parseFloat(panelStyle.paddingTop) || 0) +
    (parseFloat(panelStyle.paddingBottom) || 0);
  return Math.ceil(contentBottom + paddingBottom + wrapperChrome);
}
