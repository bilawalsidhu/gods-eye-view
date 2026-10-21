- The client's great-circle distances now come from one shared
  `src/geoDistance.js` (`greatCircleKm`/`greatCircleMeters`, `{lat, lon}`
  points). The Earth radius is standardized on 6371.0088 km, so distances shift
  by about 1.4 ppm and region areas by about 2.8 ppm, and missing or
  out-of-range points return `Infinity` (onionviolet, #287; Rajojha-1, #749).
