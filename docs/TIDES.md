# Coastal Tides layer

An animated sea surface over the photorealistic tiles (or terrain) that rises
and falls with NOAA's predicted tide. Where the tiles are higher than the water
you see land; where they are lower you see sea. The shoreline you watch move is
that intersection.

## How a height is built

```
NOAA prediction (m above MLLW, GMT)
  + MLLW − NAVD88        station datum sheet       (stations.js: mllwAboveNavd88)
  + GEOID18 N            NGS geoid height          (stations.js: geoidN)
  + calibration          card slider, ±2 m
  + waves / surge        card slider, 0–3 m
  = WGS84 ellipsoid height of the water sheet
```

Google Photorealistic 3D Tiles and the keyless Re:Earth terrain both use WGS84
ellipsoid heights, so the sheet lines up without per-tile work. NAD83 and WGS84
differ by about a metre on the West Coast, and photogrammetry captures the sea
at whatever tide it was flown, so the calibration slider exists to nudge the
sheet until the drawn shoreline matches a known moment.

## Data path

- Client: `src/layers/tides/source.js` → `GET /api/tides?station=&begin=&end=`
- Server: `server/providers/tides.js` → NOAA CO-OPS `datagetter`
  (`product=predictions&interval=hilo&datum=MLLW&time_zone=gmt&units=metric`),
  window padded a day each side, cached 6 h.
- Between turning points the curve is a half cosine (`tideHeightAt`).

## Limits

- Three stations are bundled. Add one by appending its datum offset and geoid
  height to `TIDE_STATIONS` (links in that file's header).
- One flat sheet per station. Tide phase and range change along a coast; a
  production version would interpolate between gauges or use NOAA's
  STOFS/ADCIRC water-level grids.
- Below the tide the 3D tiles still show the sea surface they were captured
  with, so a low tide cannot reveal seabed that the photogrammetry never saw.
- Predictions are astronomical only. Storm surge and wave runup are the
  user's slider, not data. Not for navigation.

## Next steps

- Live water levels (`product=water_level`) next to the prediction.
- CDIP / NDBC wave buoys feeding a Stockdon runup estimate for the slider.
- High-resolution coastal topobathy (NOAA CUDEM) as a terrain provider so low
  tides show real seabed.
