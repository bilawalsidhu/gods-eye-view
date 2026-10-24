# Cape Town transmission pilot

This extractor builds the dated regional pack proposed in
[GEV #1293](https://github.com/bilawalsidhu/gods-eye-view/issues/1293).
The initial feasibility measurements and extraction example were contributed by
[daikaginza](https://github.com/bilawalsidhu/gods-eye-view/issues/1293#issuecomment-6379309773).
The production extractor adds explicit clipping, metric simplification, relation
coverage checks, deterministic output, and unknown-voltage record provenance.

## Reproduce

Use Python 3.12 and an isolated environment:

```sh
python3 -m venv /tmp/gev-transmission-venv
/tmp/gev-transmission-venv/bin/pip install -r scripts/transmission/requirements.txt
curl -fL https://download.geofabrik.de/africa/south-africa-261022.osm.pbf -o /tmp/south-africa-261022.osm.pbf
/tmp/gev-transmission-venv/bin/python -m unittest discover -s scripts/transmission -p 'test_*.py'
/tmp/gev-transmission-venv/bin/python scripts/transmission/extract.py /tmp/south-africa-261022.osm.pbf src/data/local_data/transmission
```

The extractor verifies the pinned input MD5 before parsing. `source.json` also
records SHA-256, source time, dependency versions, geometry policy, counts, and
the output digest. The 423 MB source PBF and Python environment are not shipped.
Refreshes require a reviewed change to the source pin and a new audit. There is
no scheduled refresh, runtime Overpass request, or OpenInfraMap tile dependency.

## Selection and transformation

- Rectangle: west 18.30, south -34.36, east 18.99, north -33.47. This approximates
  a Cape Town pilot area; it is not an administrative boundary.
- Include `power=line` ways and `power=substation` nodes/ways when any numeric
  semicolon/comma-separated voltage is at least 110,000 V. Preserve every
  value and the original tag; malformed and absent values are separate states.
- Include substations lacking `voltage` in an optional unknown category. Exclude
  known lower-voltage substations and lines with missing/malformed voltage.
  Unknown objects are not inferred to be transmission sites.
- Clip lines to the rectangle, simplify in EPSG:32734 at 5 m, transform back to
  WGS84, then clip numerical edge drift. Split lines keep one source identity.
  Substation areas become inside representative points, identified as such.
- Keep source IDs unique. Flag node/area overlaps without merging objects or
  transferring voltage between them. One untagged node overlaps a lower-voltage
  area in this snapshot; its popup retains both source identities for inspection.
- Resolve the three source substation relations and assert that they are outside
  the pilot. Stop the build on unresolved members or an intersecting relation;
  relation support must be added before accepting such a future snapshot.

The pinned output has 367 line records, 57 known-voltage substations and 418
unknown-voltage substations. Its clipped, simplified line geometry is about
1,011 km with 1,762 vertices. The complete pack is 251,785 bytes, 32,347 bytes
under gzip-9. Compression is a transfer measurement, not a rendering benchmark.

## Runtime and validation

The source loads only when enabled and the layer caches the parsed snapshot.
The layer is off by default. Unknown substations are also off by default, have
neutral hollow markers and a separate count, and remain separate when a known
voltage is selected. Both filters persist through the normal share/state owner.

At most 600 source records render at once, filtered by the view rectangle, with
known-voltage records first and stable IDs as the tie-breaker. The row reports
omitted records when this limit applies. Above 1,800 km camera height only the
coverage boundary renders. There is one selected detail card and no ambient
label population. Disabling removes Cesium geometry, selection, input handlers,
camera listeners and the layer's credit ownership; destroying also releases the
cached snapshot. This is mapped context, not outage, damage or connectivity data.

```sh
node --test src/layers/transmission/transmission.test.mjs
node scripts/qa-transmission.mjs --url http://localhost:4181
```

The browser gate uses the actual shipped pack, the live keyless basemap and
terrain, and one explicitly synthetic nearby earthquake. External map services
must be available. It briefly holds rendering during basemap warm-up, then
releases the hold before enabling the layer. Screenshots and measurements go to
the ignored `qa-artifacts/transmission/` directory (override with `--out`).
Frame intervals compare the same regional camera with the layer off/on, using
90 driven frames per sample. Interpret timings alongside the recorded WebGL
renderer; they are local smoke measurements, not cross-device benchmarks.

## Data license

The GeoJSON and source data are © OpenStreetMap contributors, available under
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), distributed through
[Geofabrik](https://download.geofabrik.de/africa/south-africa.html).
See [OSM attribution and licensing](https://www.openstreetmap.org/copyright).
The data license is separate from the repository's MIT code license. Preserve
attribution and the applicable database share-alike obligations when distributing
this extract or a derivative. Source URLs and timestamps remain in `source.json`.
