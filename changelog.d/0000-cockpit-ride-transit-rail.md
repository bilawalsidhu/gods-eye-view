- Fix rides on a Rail train or Transit vehicle for an application's Cockpit
  subjects. A held parked vehicle no longer leaves its icon drawn under the
  view, and turning Transit off ends a hold, so the vehicle shows again when
  the layer is back on. A train or vehicle drawn on the ellipsoid while no
  floor is known reports no height, so the view waits for the ground instead
  of standing on the ellipsoid. A train standing at a platform keeps the way
  it runs: GPS jitter of a few metres no longer turns the ride around
  (German, @gekh, #0000).
