# IGN Argentina administrative outlines

`departments.json` supplies 529 administrative units to the existing area
annotation resolver: 379 departments, 135 partidos and 15 CABA comunas. It is
loaded on demand and adds no map layer or toggle. Examples: `Departamento
Capital, Misiones`, `Partido de La Matanza, Buenos Aires`, `Comuna 1, CABA`.

## Source and dates

**Fuente: Instituto Geográfico Nacional de la República Argentina.**
Official [SIG catalog](https://www.ign.gob.ar/NuestrasActividades/InformacionGeoespacial/CapasSIG)
and [OGC services](https://www.ign.gob.ar/NuestrasActividades/InformacionGeoespacial/ServiciosOGC).
`source.json` pins the WFS URLs and feature-content SHA-256 digests:

- `ign:departamento`: full GeoJSON, EPSG:4326, 529 features.
- `ign:provincia`: province code/name attributes, 24 features; used only to
  qualify department names. It does not replace province geometry.

Retrieved **2026-10-15**. The service does not supply an underlying dataset
update date. WFS `timeStamp` dates the response, not the administrative data.
Original per-feature compilation metadata (`fdc`, `sag`, and the other IGN
properties) is retained in `sourceProperties`.

The dataset follows IGN's territorial representation, including disputed
territories and Antarctic claims. These are provider-derived jurisdiction
outlines; the app's global country basemap is unchanged. No endorsement by IGN
is implied. These simplified outlines are for visualization, not cadastral use.

## License

The data remains under the [IGN geographic information reuse terms](https://www.ign.gob.ar/descargas/tyc1.html),
separate from the software's MIT license. The terms permit copying,
redistribution, modification and combination; require source attribution and
retention of date/reuse metadata; and require that redistributed data be shared
freely without charge. Commercial use is permitted as an input to derived
products. Preserve the original terms and attribution when reusing this pack.
No separate open-data license is inferred. The app registers the IGN credit
when its first administrative outline resolves.

## Regenerate

```sh
node scripts/build-argentina-admin.mjs
# Or reuse downloaded departments.geojson and provinces.geojson:
node scripts/build-argentina-admin.mjs --cache /path/to/cache
```

Raw downloads (approximately 140 MB for departments) stay in the system temp
directory by default, outside the repository. Content hashes retain all source
feature IDs, properties and coordinates, sort features by official `in1`, and
exclude volatile WFS response metadata. A changed source fails closed and
requires review before updating the pin; the builder never silently refreshes
the dataset. Given the pinned source it reproduces the pack byte for byte.

The builder reuses the existing administrative geometry simplifier, then:

- Applies Douglas–Peucker at 0.003 × √(area in km²) km, clamped to
  0.0001°–0.01°, and rounds coordinates to four decimals. This preserves finer
  detail for small CABA comunas.
- Keeps the largest part; drops secondary parts below 0.1 km² or 0.1% of that
  largest part, and holes below 0.1 km². Retained outers and holes are oriented
  consistently. Tiny units use the same higher-precision fallback as the
  existing global packs.
- Clamps the source's Antarctic floating-point excess (-90.00000001°) to
  -90°. It otherwise preserves the coordinate reference and territorial scope.
- Delta-encodes each open ring as `[lon0, lat0, dLon1, dLat1, …]`, in units of
  10^-4 degrees (or per-feature `d`). Parts are ordered largest first.

`features[]` retains `id` (`in1`), `name` (`nam`), `full` (`fna`), `type` (`gna`),
province `region` and two-digit INDEC `regionCode`, original feature ID and
properties, and encoded `polygons`. `meta` carries provenance and simplification
parameters. Source update dates remain explicitly unknown.
