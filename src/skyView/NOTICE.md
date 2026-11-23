# Sky view: third-party data and code notices

The Sky view code in this folder is MIT licensed like the rest of God's Eye
View. The three catalogue files in `data/` are NOT MIT: they are derived from
Creative Commons Attribution-ShareAlike data and stay under that licence.
Anyone redistributing those files must keep the attribution below and share
derived data files under the same licence. (Not legal advice.)

## Star catalogue: `data/stars.json`

- Source: HYG database v4.4, David Nash (astronexus),
  https://codeberg.org/astronexus/hyg (file `data/hyg/CURRENT/hyg_v44.csv.gz`,
  repository commit 53e3df311869e813ace5f1ad2ec4ce909f13256c, 2026-07-12,
  input SHA-256 pinned in `scripts/build-sky-data.mjs`).
- Licence: Creative Commons Attribution-ShareAlike 4.0 International
  (CC BY-SA 4.0). Upstream licence statement: `data/LICENSE-HYG.md`; full
  legal code: `data/CC-BY-SA-4.0.txt`
  (https://creativecommons.org/licenses/by-sa/4.0/legalcode).
- Changes made: kept stars with V magnitude <= 6.5 plus every Hipparcos star
  used by a constellation line; kept only RA/Dec (J2000, degrees, 4 decimals),
  magnitude, B-V colour, proper motion, Hipparcos id, IAU proper name and the
  Bayer/Flamsteed field; reordered by magnitude; written as columnar JSON.

## Constellation lines and names: `data/constellations.json`

- Source: Stellarium sky cultures, "western" sky culture, `western/index.json`,
  https://github.com/Stellarium/stellarium-skycultures (commit
  92df9e4c48c7a3b21d4b0cfc6ce088dd8ce2f2df, 2024-05-17), authors "Stellarium's
  team".
- Licence: "Text and data: CC BY-SA" as stated in `western/description.md`
  (copied to `data/LICENSE-Stellarium-western.md`; no version number is given
  upstream). Illustrations are Free Art License and are NOT bundled.
- Changes made: kept the 88 constellations' IAU abbreviation, English and
  Latin names and line chains (Hipparcos ids); dropped the "thin" line-style
  markers, illustrations and asterisms; sorted by abbreviation.

## Constellation boundaries: `data/boundaries.json`

- Source: the same Stellarium `western/index.json` (commit above), its
  `edges` list (781 edges; upstream source pbarbier.com `edges_18`, IAU
  boundaries at epoch B1875).
- Licence: as above ("Text and data: CC BY-SA").
- Changes made: each B1875 meridian/parallel edge was densified to steps of
  at most 1 degree of arc and precessed B1875 -> J2000 (IAU 2006 precession,
  `skyMath.precessionMatrix`) at build time; written as flat RA/Dec polylines
  (degrees, 2 decimals). Loaded only when the boundaries switch is on.

## Credits in the app

Both sources are credited in the app's "Data attribution" panel
(`src/data/dataCredits.js`, key `sky-catalogues`) and in `DATA_SOURCES.md`.
`src/skyView/notice.test.mjs` fails if either credit line, this file or
a licence file goes missing.

## Code dependency

- astronomy-engine 2.1.19 (Don Cross, MIT), Sun/Moon/planet positions;
  https://github.com/cosinekitty/astronomy. Pinned exact in `package.json`.
- geomagnetism 0.2.0 (Brandon Reavis / Natural Atlas, Apache-2.0),
  https://github.com/naturalatlas/geomagnetism, magnetic declination for
  "Point at the sky" (`declination.js`). It bundles the World Magnetic Model
  coefficients (WMM2025 used, valid 2024-11-13 to 2029-11-13), produced
  jointly by NOAA NCEI and the British Geological Survey; NCEI's metadata
  (gov.noaa.ngdc:WMM2025, read 2026-10-12): "Not subject to copyright
  protection within the United States", free and publicly available. Cite as:
  NOAA NCEI Geomagnetic Modeling Team; British Geological Survey. 2024: World
  Magnetic Model 2025. https://doi.org/10.25921/aqfd-sd83. Pinned exact in
  `package.json`; `declination.test.mjs` checks it against the NOAA calculator.
  When WMM2030 is published (late 2029) update the package or the model.

## Rebuilding the data

```
curl -LO https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz
curl -L -o index.json https://raw.githubusercontent.com/Stellarium/stellarium-skycultures/master/western/index.json
node scripts/build-sky-data.mjs --hyg hyg_v44.csv.gz --western index.json          # write
node scripts/build-sky-data.mjs --hyg hyg_v44.csv.gz --western index.json --check  # verify
```

The script refuses inputs whose SHA-256 differs from the pinned values and
writes byte-identical output for the same inputs; `data/manifest.json`
records input and output checksums, counts and sizes.
