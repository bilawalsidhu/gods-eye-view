# Imaging sensor pack

Swath widths and ground resolutions for 46 Earth-observation platforms and
constellations, matched to satellites by NORAD catalog number or by their
CelesTrak name. The orbital view draws a satellite's sensor swath to scale and
lets it zoom past 8x only as far as that swath (`src/layers/satellites/sensors.js`,
`src/data/imagingSensors.js`, `orbitalMaxZoom` in `src/cockpitOrbital.js`).

| File | Content | Entries |
|------|---------|---------|
| `imaging_sensors.json` | Platform, match rule, operator, instruments, altitude, imaging modes (swath km, best ground resolution m), narrowest standard swath, sources, unverified fields | 46 |

**Compiled:** 2026-11-04, by hand from the pages cited per entry (`sources`).
Each match pattern was checked against CelesTrak's active list that day.
Altitude is the nominal value from a cited source; where none was found it is
the median altitude of the matching satellites from CelesTrak GP data, noted in
`unverified`. The app zooms on the live altitude, not this one.

**Narrowest standard swath** is the narrowest continuous standard imaging swath
or scene width (cross-track); for a geostationary imager, the narrower side of
its smallest standard scan area. Some listed modes are left out of it:

- Sampling modes: SAR wave vignettes, and Himawari's Landmark Area scans
  (1000 × 500 km), so Himawari's narrowest is the 1000 km Target Area.
- Generations the operator has retired: PlanetScope's Dove Classic and Dove-R
  (about 25 km scenes, imagery until April 2022 per Planet) stay in `modes`,
  while its narrowest is the SuperDove's 32.5 km. The `^FLOCK ` name rule
  would also match those older Doves.

**Unverified values.** A value not confirmed on an opened page is named in the
entry's `unverified` list. `swathConfirmed` is false when the narrowest swath is
missing or unverified; such a platform keeps the base 1–8x zoom steps:

- Landsat 9 (swath inferred from Landsat 8), ResourceSat-2 (LISS-3 swath),
  SuperView Neo-1 (12 km from search snippets only), BlackSky and Meteosat
  MTG FCI (no swath found).

## Sources and licences

The values are individual specification facts, each cited from the
operator's or agency's official pages listed per entry in `sources`. No text or
images are copied. The main sources:

- **Operator and agency pages and spec sheets** (NASA, USGS, NOAA/NESDIS,
  ESA SentiWiki and Earth Online, EUMETSAT, JAXA, ISRO/NRSC, INPE, CSA, DLR,
  JMA, ASI, KARI, China's Ministry of Natural Resources (LASAC), Planet,
  Vantor (formerly Maxar) datasheet pages, L3Harris, China Siwei, BlackSky,
  Airbus and KOMPSAT-5 via the Disasters Charter, ICEYE, Capella, Umbra,
  Satellogic, Chang Guang).
- **Academic papers and proceedings** (Sensors papers on Gaofen-3, KARI's
  ACRS 2012 paper on KOMPSAT-3, CAST's IAC-16 abstract on Gaofen-2).
- **eoPortal** (ESA's mission directory, an institutional source): a swath
  read there counts as confirmed. It is cited beside the operator's and
  agency's pages, and alone for values they do not give (the wider modes of
  Gaofen-3 and COSMO-SkyMed Second Generation, and a few other entries).
  Gaofen-1 takes eoPortal's 69 km PMS and 830 km WFV swaths by maintainer
  choice; a 2019 Chinese lecture and a Sensors paper give 60 and 800 km.
- **CEOS MIM Database** (https://database.eohandbook.com): CC BY 4.0 since
  7 September 2026, with the credit "CEOS MIM Database,
  https://database.eohandbook.com". No entry relies on it yet; credit it if
  values are taken from it later.

Listed in DATA_SOURCES.md and in the app's Data attribution popover.
