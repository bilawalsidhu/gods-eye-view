/** Route Cockpit keys while preserving the active disclosure and form-control owner. */

export function onKeyDown(event) {
  if (this.destroyed) return false;
  if (event.repeat || event.isComposing) return;
  if (event.key === 'Escape' && this.active) {
    // The credit lightbox owns Escape while its Close control or links hold
    // focus. Its target handler closes the overlay and restores attribution
    // focus; Cockpit must stay active behind it.
    if (event.target?.closest?.('.cesium-credit-lightbox')) return;
    if (
      document
        .getElementById('context-radio-dock')
        ?.classList.contains('disclosure-open')
    )
      return;
    if (
      document.querySelector('#cockpit-utility-controls [aria-expanded="true"]')
    )
      return;
    if (this.context?.contains(event.target) && !this.contextCollapsed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setContextCollapsed(true);
      if (
        event.target === this.contextToggle ||
        this.contextToggle?.contains?.(event.target)
      ) {
        this.contextToggle?.blur?.();
      } else {
        this.contextToggle?.focus({ preventScroll: true });
      }
      return;
    }
    if (this.signalStream?.contains(event.target) && !this.signalCollapsed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setSignalCollapsed(true, { user: true });
      if (
        event.target === this.signalToggle ||
        this.signalToggle?.contains?.(event.target)
      ) {
        this.signalToggle?.blur?.();
      } else {
        this.signalToggle?.focus({ preventScroll: true });
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.exit();
    return;
  }
  if (event.target?.closest?.('input, textarea, select, [contenteditable]'))
    return;
  const key = event.key?.toLowerCase();
  if (key === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!this.active) {
      const cockpitAttempt = !!(
        this.readAircraftInfo() && this.viewer.trackedEntity?.position
      );
      if (!cockpitAttempt) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.active && !this.isEntryAllowed()) return;
    const changed = this.active ? this.exit() : this.enter();
    return;
  }
}
