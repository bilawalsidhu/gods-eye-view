# OurAirports

`airports.json` holds the airports Context's airport cards and "near …" links
use: large and medium airports, and small ones with an IATA code and scheduled
service. Closed airports and OurAirports' duplicate, misplaced and closed
placeholder rows (and large airports with no IATA code and no open runway)
are left out. Each row is `[ident, iata, name, lat, lon, size, city, country,
elevationFt, runways, icao?]`. The optional final column holds a distinct ICAO
code. The runway count excludes helipads and counts repeated runway-end pairs
once. `meta` names the source, licence, build time and count.

- Source: OurAirports, https://ourairports.com/data/ (the CSV mirror at
  https://davidmegginson.github.io/ourairports-data/: `airports.csv`,
  `runways.csv`).
- Licence: public domain.
- Build: `node scripts/build-ourairports.mjs airports.csv runways.csv`. The raw
  CSV files are not kept in the repository.
- The app reads this file only; it never calls OurAirports.
