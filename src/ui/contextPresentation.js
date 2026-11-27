export function _syncContextModeButtons() {
  if (this.destroyed) return;
  if (this.publish) {
    const flightsActive = this._contextMode === 'flights';
    this.publish({
      mode: this._contextMode || 'none',
      enabled: flightsActive,
      flightsActive,
      busy: Boolean(this._contextModeChanging),
    });
  }
  this.cockpitView?.syncEntry();
  // Every _contextMode mutation funnels through here; the sync no-ops until
  // the transaction settles, so this is the activation/deactivation edge.
  this.actions.syncDetection();
  this.actions.scheduleLayout();
}
