# UCS Satellite Database pack

Offline operator, owner-country and purpose records for active satellites,
keyed by NORAD catalog number. The satellites layer joins them to CelesTrak's
positions to file each satellite under a class (stations, imaging, telecom,
probes) and to name its operator and owner country
(`src/data/ucsSatellites.js`, `src/layers/satellites/classes.js`).

| File | Source dataset | Records |
|------|----------------|---------|
| `ucs_satellites.json` | UCS Satellite Database, release **UCS-Satellite-Database 5-1-2023** (data current through 2023-05-01) | 3,564 |

**Source:** Union of Concerned Scientists, https://www.ucsusa.org/satellite_database.
The same release is mirrored on Hugging Face as
`juliensimon/ucs-satellite-database` (identical rows). UCS has paused updates
since this release, so satellites launched after May 2023 are not in it; the
layer classifies those from CelesTrak SATCAT, CelesTrak groups and name
patterns instead.

**License:** free, unrestricted use. Section 3 of the UCS database manual:
"The Database is free and its use is unrestricted. We request that its use be
acknowledged and referenced in written materials. References should include
the version of the Database that was used, which is indicated by the name of
the Excel file, and a link to or URL for the webpage
www.ucsusa.org/satellite_database."

**Acknowledgement:** "Satellite operators and purposes: UCS Satellite Database
(UCS-Satellite-Database 5-1-2023), https://www.ucsusa.org/satellite_database".
It is also listed in the app's Data attribution popover and in
DATA_SOURCES.md.

**Build:** `python scripts/build-ucs-satellites.py "<path>/UCS-Satellite-Database 5-1-2023.xlsx"`
(openpyxl). The file's `meta` header records the curation.

**Curation:**

- Kept columns: Operator/Owner, Country of Operator/Owner and Purpose, the
  ones the layer reads. Everything else (detailed purpose, users, orbits,
  masses, contractors, launch data, sources) is left out.
- Repeated text is stored once in `strings`; each record is
  `[noradId, operator, operatorCountry, purpose]` with string-table indexes,
  `0` meaning empty.
- The 3,996 Starlink rows are dropped: every Starlink object is classed and
  credited to SpaceX by name, so they would only add size.
- Rows without a readable, positive NORAD number are dropped and counted apart
  from duplicate NORAD numbers (the first row of a duplicate is kept); both
  counts are 0 in this release.
- Owner countries stay as UCS writes them ("USA", "USA/Japan", "ESA",
  "Multinational"); `src/layers/satellites/classes.js` normalises them, together with
  CelesTrak SATCAT owner codes, in one table.
