# Dams

Extracted from local decoded OpenInfraMap/PostGIS layers.

Filters: `waterway=dam`, `man_made=dam`, or `building=dam`.

Feature count: 704

Runtime output: `dams.geojsonl`

License: Open Database License (ODbL) 1.0. Keep the OpenStreetMap contributor
attribution and the Open Infrastructure Map source credit when redistributing
this derived database.

The public-release snapshot removes contact-oriented fields and note values
that contain email or phone identifiers. The runtime layer does not display or
depend on those fields.

## Norway (`norway.geojsonl`)

Every dam in NVE's register (map service Vannkraft1, layer Dam_N250), one
Point per dam: 4,141 records retrieved 2026-10-11. Built by
`scripts/build-dams-norway.py`, which translates NVE's code lists (purpose,
dam type, function, setting) to English and writes names stored in capitals in
normal case; names of dams, power plants, reservoirs and places stay
Norwegian. `norway.sha256` holds the file checksum; `--verify` checks it
offline. NVE updates the register daily, so a rebuild may differ. A dam
number NVE gives to one dam alone is its id (`nve-dam-<number>`); a dam with
no number, number 0 or a shared number is named by number and position
(`nve-dam-<number or p>-<lat>-<lon>`), since NVE renumbers its object ids. A
dam NVE lists twice at one position keeps its fuller record, and NVE's coastal
catchments ("KYSTFELT") are not given as a river.

License: Norwegian Licence for Open Government Data (NLOD), separate from the
ODbL data above. Attribution: "Inneholder data under Norsk lisens for
offentlige data (NLOD) tilgjengeliggjort av NVE".
