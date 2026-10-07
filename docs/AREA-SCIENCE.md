# Dated imagery and soil estimates

These explicit geographic queries live in **INVESTIGATE AREA**. Unlock/create an
area case, review the coordinates/radius and use the historical or soil controls.
Only geographic coordinates, years, cloud threshold and soil depth go to the
providers. No case title, personal note or passphrase is sent. No AI model or paid
API is required by these adapters.

## Historical scenes and timelapse

Landsat Collection 2 archives cover the requested 1990-to-current-year period
where scenes exist. Select first/last year, a 1/5/10-year step and maximum
scene-wide cloud percentage. The default five-year cadence limits catalogue calls;
annual cadence is available. At most 50 requested frames and 20 candidate scenes
per year are examined, with a three-minute overall UI cancellation limit.

For each requested year the adapter chooses the lowest-cloud candidate among
the returned scenes that meets the threshold and whose bounding box encloses the
area. It renders the same fixed geographic crop for all frames through Planetary
Computer's Landsat image API. Acquisition date, satellite and scene-wide cloud
percentage remain visible. A slider and Play/Pause animate dated frames; missing
or unavailable years remain visible gaps and failed image loads are labelled.

These are individual ~30 m optical scenes, not annual mosaics, same-season
composites, historical photorealistic 3D or a reconstruction of every building.
Scene-wide cloud percentage does not guarantee a clear crop. The scene bounding
box test does not measure valid-pixel coverage; nodata, Landsat 7 scan-line gaps,
clouds and seasonal differences may affect comparisons. Current-year searches
stop at the query time. Earth only; antimeridian-crossing crops are rejected.

Metadata/provenance persists encrypted and is included in case backups. Image
bytes are fetched on viewing and are not part of that backup or an offline pack.
Closing the case stops animation and clears image sources. No Google tiles are
archived or analysed.

## Soil composition: texture, not chemical analysis

SoilGrids 2.0 estimates sand, silt and clay mass fractions of fine earth at the
center of the selected area, at approximately 250 m grid spacing. Choose one of
six depth intervals: 0–5, 5–15, 15–30, 30–60, 60–100 or 100–200 cm. Values returned
in g/kg are divided by 10 to display mass percent. The mean and independently
predicted 5th/95th quantiles are retained; that interval spans 90% of the predictive
distribution. It is not the probability that a mineral occurs at this location.

Each property/statistic is fetched separately, because the tested WMS multi-layer
response concatenates JSON documents and reuses misleading feature IDs. A profile
uses at most nine WMS point requests; this adapter allows one profile per minute.
The REST service timed out during the 2026-10-05 probe, so this implementation uses
the working documented map service instead. Service failures, masked cells and
missing values stay unknown. Independent means are not normalized to force 100%.

This is a static modeled center-cell estimate, not an area average, historical
soil series, laboratory sample, rock/mineral/metal assay or proof of deposits.
ISRIC cautions against using its global predictions at local/farm level. More
specific regional survey data or measurements are needed for that use.

## Validation evidence, 2026-10-05

- Synthetic tests cover percentages/units, quantiles, missing data, depth/range
  validation, bounded/private-free requests, current-year cutoff, cancellation,
  gaps, fixed-provider rendering and authenticated scientific case backup.
- A bounded real provider probe returned SoilGrids means and quantiles at one
  mainland point and a 1990 Landsat scene covering a Paris-area crop. The rendered
  crop returned PNG bytes successfully. These are point/scene observations, not
  proof of global coverage or a laboratory validation of the soil model.
- Browser fixtures must check soil display, dated frames, missing-year slider,
  close/scrub and encrypted case reopen. Fixture images are synthetic and must not
  be presented as historical observations.

## Sources

- [USGS Landsat Collection 2](https://www.usgs.gov/landsat-missions/landsat-collection-2)
- [Planetary Computer access](https://planetarycomputer.microsoft.com/docs/)
- [Planetary Computer image API](https://planetarycomputer.microsoft.com/api/data/v1/docs)
- [SoilGrids properties and units](https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_01.html)
- [ISRIC map services](https://maps.isric.org/)
- [SoilGrids coverage and interpretation](https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_04.html)
