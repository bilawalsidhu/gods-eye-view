# Area insights validation

Local validation on 2026-10-11, Node 24.19.0.

- `npm test`: 6,255 passed and one skipped in the main suite, plus 14 passing
  serialized allocation checks. No failures.
- Focused area, OMI, GEM, palette and nearby tests: 12 passed.
- `npm run test:track -- --offline-imagery`: 109 passed, no failures. Tracking
  uses the harness's synthetic contacts and bundled tile images; this does not
  prove live provider coverage.
- Build, adopted-source formatting, import/package boundaries and whitespace
  checks passed. Build retains the existing chunk-size advisory.

Real local API and browser checks:

- Rome OMI B31, 2025-H2: residential quotation range 7,400–9,700 EUR/m²,
  standard apartments in normal condition, gross floor area. The midpoint
  8,550 against a 4,000 budget scores about 32/100 with the gradual curve.
- French DVF (Nice), UK HPI (Southwark) and US Census (New York County) return
  native-unit observations. Top-coded US tract values fall back to the county.
- GEM raster sampling was checked in Rome, London and Tokyo. An uncovered
  Hormuz cell remains missing, not zero.
- Real OSM/Nominatim samples supply mapped service coordinates, with their
  non-exhaustive nature and straight-line distance method disclosed.
- Selecting only air makes the composite equal to the air score. Changing
  weights and housing budget changes the index without fetching replacements.
- Nearby search around Rome compared nine locations with all four selected
  parameters available. Browser UI displayed a higher-scoring sampled match
  about 1.5 km away, using the stated two-point score tolerance.

The sampled nearby search is not exhaustive and does not find housing listings.
Air/hazard resolution may exceed sample spacing. Housing definitions vary across
countries. Service coverage is incomplete and rankings can change with fresher
samples. The map's service dots use category colors and denote locations; only analyzed locations carry a
composite-result color. Missing selected data prevents candidate ranking.

Evidence is local under ignored `output/playwright/area-*`. It includes unit,
tracking, build, boundary and formatting logs, real API observations and browser
screenshots. Provider datasets, credentials and tokens are excluded from Git.

Area insights is integrated as an expandable section inside Data Layers.
A browser click on a blue service point changed the analyzed coordinate from
41.8382, 12.4724 to 41.8366, 12.4721 and initiated real provider acquisition.
Area markers use the same picking path; compared labels expose keyboard actions.

Service categories have their own legend: health pink, schools blue, groceries
purple and public transport cyan. These colors are independent of area scores.

Conservative judgment: missing selected observations contribute zero to the
full selected-weight mean. A regression with perfect air, missing housing
(weight 2) and no mapped services (weight 1) produces 25/100, 25% coverage;
increasing missing housing weight lowers it further. All selected data missing
produces zero; no selected positive weights produces no index. Raw missing
observations remain explicitly unavailable.

Browser verification also selected an existing comparison marker: the panel
changed from 41.9237, 12.8003 to 41.9123, 12.6783 and returned 79/100 with
4/4 parameters. Category colors and both legends were visibly verified.
