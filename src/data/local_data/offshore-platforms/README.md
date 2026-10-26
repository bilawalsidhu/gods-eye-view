# BSEE offshore oil and gas structures

Dated **2026-10-01** BSEE inventory, retrieved **2026-10-26**. Coverage is U.S.
Gulf federal waters, not all U.S. waters or a worldwide inventory. The shapefile
and fixed-width table are published separately and are not perfectly aligned.
This is an inventory of structures, not drilling rigs or live production status.

## Reproduce

Use Python 3 with `pyshp==2.3.1` and `pyproj==3.7.2` (bundled PROJ 9.5.1).
Download the following inputs into a temporary directory, retaining original bytes:

- https://www.data.bsee.gov/Mapping/Files/platform.zip
- https://www.data.bsee.gov/Platform/Files/platstrufixed.zip
- https://cdn.proj.org/us_noaa_conus.tif

The URLs are mutable. Verify SHA-256 against `provenance.json` before reproducing
this release; a changed input constitutes a new snapshot and requires review.
Release date is the published download date and archive member date, **not** the
retrieval date or the older descriptive metadata date. No downloads run at app
startup or build time.

```sh
python scripts/import-bsee-platforms.py \
  --platforms /tmp/platform.zip --structures /tmp/platstrufixed.zip \
  --grid /tmp/us_noaa_conus.tif \
  --release-date 2026-10-01 --retrieved-date 2026-10-26 \
  --verify-manifest src/data/local_data/offshore-platforms/provenance.json \
  --output src/data/local_data/offshore-platforms
```

The importer validates the DBF field names, fixed row width, point geometry,
unique source keys and source CRS. It joins `COMPLEX_ID` + `STRUCTURE_` to the
fixed table's complex ID (columns 9–16) and structure number (82–84). Names and
installation dates come from the shapefile; type (85–89), last revision (31–41),
area and block come from the fixed table. A removal date in **either** input
excludes the record. IDs are preserved as `complexId:structureNumber`.

The release has 7,317 GIS points: 5,773 have a recorded removal, 2 are explicitly
mobile production units (`MOPU`), and 1,542 remain. Of those, 232 lack a matching
type-table row and retain an unknown type. These are not silently classified as
surface platforms. Known subsea codes (`SSANC`, `SSMNF`, `SSTMP`, `UCOMP`) are
classified separately; no synthetic subsea examples are added to the snapshot.
The initial view excludes known removals and mobile units. Missing removal dates
mean only **no removal date recorded**; production/contract status is unknown.

Schemas and type definitions:
- https://www.data.bsee.gov/Main/HtmlPage.aspx?page=platformStructures
- https://www.data.bsee.gov/Main/HtmlPage.aspx?page=platformStructuresFields

## Coordinates

The downloaded `platform.prj` and BSEE metadata declare **NAD27 (EPSG:4267)**.
The importer uses the exact NOAA CONUS grid with **EPSG:15851 — NAD27 to WGS 84
(79)**, the Gulf OCS operation, in an explicit longitude/latitude pipeline. Its
stated transformation accuracy is 5 m, not an accuracy claim about BSEE's source
locations. No automatic operation selection, ballpark fallback or network grid
lookup is allowed. Points outside the operation's Gulf bounding area are
excluded and counted, rather than extrapolated (none in this snapshot).

Output coordinates are WGS84 longitude/latitude, rounded to six decimals for
storage. This rounding is not a claim of sub-metre positional accuracy. The
source positions are approximate and must not be used for navigation.

## Reuse and attribution

[BSEE's release metadata](https://www.data.bsee.gov/Mapping/Files/platform_meta.html)
says the dataset was developed within the U.S. Government and has no proprietary
rights attached. It excludes legal and navigational uses and disclaims liability
for errors or omissions. The NOAA conversion grid is public domain per
https://cdn.proj.org/us_noaa_README.txt. The code's MIT license does not replace
these data terms.

The app's Data attribution credits BSEE, coverage and snapshot date and links to
its terms. The selection card links to the BSEE mapping catalog. `provenance.json`
records exact URLs, checksums, tool versions, dates, transformation and audit
counts. Runtime serves only `platforms.json`; no API key or external BSEE request
is needed.
