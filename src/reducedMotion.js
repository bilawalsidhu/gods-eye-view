/** Whether the viewer asked for reduced motion (`scope` defaults to the page's window). */
export function prefersReducedMotion(scope = globalThis.window) {
  try {
    return (
      scope?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    );
  } catch {
    return false;
  }
}
