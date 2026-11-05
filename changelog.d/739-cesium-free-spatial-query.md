- Adds Cesium-free `queryRadius()` and `nearest()` helpers for geographic
  point collections, with nearest-first ordering, deterministic ties,
  index-aware position accessors, and invalid-entity filtering. Both helpers
  use the canonical `src/geoDistance.js` implementation. Transit feed range
  selection now uses the shared query API.
