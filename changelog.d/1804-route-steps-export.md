- `gods-eye-view/sources/places` also exports `normalizeOsrmSteps`, so a route
  proxy outside Core's dev server can serve the same turn-by-turn steps the
  Directions layer asks for with `steps=1`.
