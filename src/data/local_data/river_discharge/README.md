# River discharge outlook points

`points.json` holds the 187 river points the River discharge outlook layer
(`src/layers/riverDischarge/`) and its proxy (`/api/river-discharge`) read,
each with percentiles of its own daily GloFAS discharge. Built 2026-10-24 by
`scripts/build-river-discharge-points.mjs`; every parameter is in the file's
`meta`.

**Points.** Named `River` features (lake centrelines excluded) at scalerank
≤ 5 in Natural Earth 10m `rivers_lake_centerlines` (public domain;
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
commit `ca96624a56bd078437bca8184e78163e5039ad19`, SHA-256
`bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a`), a point
every 800 km along each line and none within 400 km of a point already kept:
196 candidates on 110 named rivers.

**Snapping.** The Open-Meteo Flood API reads the nearest 0.05° GloFAS cell,
which is often a dry cell or a side stream beside the main stem. Each
candidate's 3×3 cell neighbourhood is read over 2022-03-14 to 2022-07-31 and
the cell with the largest mean discharge is kept; 9 candidates whose best cell
averaged under 10 m³/s were dropped. `lat` / `lon` are GloFAS v4 cell centres,
not the Natural Earth vertex.

**Percentiles.** `p50`, `p90`, `p99`, `mean` and `max` (m³/s) are taken over
every day from 2012-08-01 to 2022-07-31 of the GloFAS v4 reanalysis
(`models=seamless_v4`). They describe the model's own flow at that cell: they
are not return periods, not flood stages and not gauge statistics. Where
GloFAS misrepresents a river (reservoir operation, braided or deltaic
channels) the percentiles carry the same bias as the forecast compared with
them.

**Licence.** River data: Natural Earth, public domain. Discharge: Open-Meteo
(CC BY 4.0, https://open-meteo.com/en/licence) from GloFAS, Copernicus
Emergency Management Service (CEMS-FLOODS licence,
https://cds.climate.copernicus.eu/licences/cems-floods). The percentiles are
modified Copernicus Emergency Management Service information (2026).

**Cost and regeneration.** One point costs 9 weighted Open-Meteo calls to
snap and 26.09 for the ten-year history (Open-Meteo counts one daily variable
over `days` as max(1, days / 140) per location). This build spent 6,642
weighted calls on the free API in about 75 minutes, paced at ≤ 300 a minute
and ≤ 3,500 an hour. To rebuild:

```
node scripts/build-river-discharge-points.mjs --cache <dir> --max-weight 8000
```

The cache keeps every answer, so a run stopped by `--max-weight` or a 429
resumes without repeating calls. The free API is non-commercial; spread a
larger build over several days to stay under 10,000 weighted calls a day.
