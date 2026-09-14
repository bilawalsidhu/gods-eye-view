export function createController({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  function _abortActiveUpdates() {
    for (const controller of flightState._activeUpdateControllers)
      controller.abort();
    flightState._activeUpdateControllers.clear();
  }
  return { _abortActiveUpdates };
}
