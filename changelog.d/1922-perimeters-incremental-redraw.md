- Fire Perimeters redraws only the pieces that changed when the timeline
  steps: with an id on every piece (WFIGS now gives one), new pieces are
  added, gone ones removed and aged ones recoloured in place. An hourly step on
  a synthetic peak day of 1,000 pieces rebuilds only the draw sets it changes
  (German, @gekh, #1922).
- Hosts can place fire-perimeter cards and cancel stale reads without
  workarounds: the package's `./layers/perimeters/records` export carries
  `perimeterAnchorDegrees` with no rendering code, so a server or worker
  stands a card where the map does, and `refreshLayer(id, { supersede: true })`
  cancels a read in flight instead of waiting for it (German, @gekh, #1922).
