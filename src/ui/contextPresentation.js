export function _syncContextModeButtons() {
  if (this.destroyed) return;
  this._presentContext();
  this.cockpitView?.syncEntry();
  // Every _contextMode mutation funnels through here; the sync no-ops until
  // the transaction settles, so this is the activation/deactivation edge.
  this.actions.syncDetection();
  this.actions.scheduleLayout();
}

/** Publish the mode switch and the nearby sites search to the view. */
export function _presentContext() {
  if (this.destroyed) return;
  const flightsActive = this._contextMode === 'flights';
  const missionsActive = this._contextMode === 'space-missions';
  // Both Context choices stay in the ordinary Tab sequence and are never
  // native-disabled. Arrow keys still provide tablist navigation, but must
  // not be the only way to reach Space Missions from the keyboard. Semantic
  // busy state keeps them perceivable while synchronous click guards prevent
  // a second transition.
  this.publish({
    mode: this._contextMode || 'none',
    enabled: flightsActive || missionsActive,
    flightsActive,
    missionsActive,
    busy: Boolean(this._contextModeChanging),
    installationsBusy: this._installationsSearchBusy,
  });
}
