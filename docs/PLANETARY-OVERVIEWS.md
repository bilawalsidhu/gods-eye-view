# Independent Moon and Mars overviews

Moon/Mars discovery cards now link to `/planet.html?body=moon|mars&site=Q…`.
This page is independent of the Earth application. It creates no Cesium viewer,
terrestrial layer manager, live feeds, private case vault, Google tiles or model
backend. A small WebGL renderer displays an orthographic textured sphere, with
pointer rotation, wheel zoom, arrow-key rotation, +/- zoom and explicit coordinate
or source-site navigation. Startup and rendering use only local page/assets.

## Geometry and source boundaries

Longitude is positive east, normalized to −180…180°; Mars source values in 0…360°
are normalized without reusing terrestrial coordinates. Source cards must name
the corresponding Wikidata coordinate globe (Moon Q405, Mars Q111). Markers on
the far side are hidden. Picking and marker placement share the same spherical
projection. Picking blank imagery does not identify a feature: it clears the
source-site selection and returns only coordinates.

The Moon is represented by a sphere of mean radius 1737.4 km and Mars by a sphere
of mean radius 3389.5 km. This is an approximate planetocentric overview, not a
triaxial figure or a precision geodetic survey. Source coordinate conventions and
datum consistency have not been independently surveyed. Known Tycho/Olympus Mons
positions provide a coarse visual registration check, not a global accuracy claim.

No elevation model is loaded. Apparent craters and mountains are texture details,
not raised terrain. Lighting is illustrative, not the current solar phase or
ephemeris. Neither color map is used to infer mineral chemistry or soil fractions.
The existing Earth SoilGrids/Landsat investigation adapters are not enabled here.

## Bundled maps and provenance

Original JPEG bytes are stored in `public/planetary/`, with source URLs, credits,
retrieval date, dimensions, byte sizes and SHA-256 hashes in `manifest.json`.
Total map bytes: 1,430,838 (approximately 1.4 MB). No pixel edits, generated
replacement terrain or unlicensed Google imagery are included.

| Body | Source and display size | Approximate equatorial sampling |
| --- | --- | --- |
| Moon | NASA SVS CGI Moon Kit, 2025 color map, 2048×1024 | 5.3 km/pixel |
| Mars | NASA/JPL-Caltech Viking-based image texture processed at USGS, 1440×720 | 14.8 km/pixel |

The NASA lunar map is explicitly optimized for visualization rather than science:
its polar regions include lower-resolution fills and processing. Mars is likewise
a processed global overview. Retain the source captions and credits. The maps
use a zero-centered equirectangular display registration; Mars registration was
checked visually against the installed planetary features. Use original scientific
products and their coordinate metadata for quantitative work.

## Offline installation

From the built local app, open the planetary page and click **Install offline
planetary views**. Its dedicated service worker caches the page, compiled local
code/styles, both JPEG maps and the provenance manifest, capped at 32 assets and
5 MiB. It controls only `/planet.html`, not the Earth application or private APIs.
Installing again refreshes the shell. Clearing browser site data removes it.

After installation, the same origin's planetary page can reopen, switch body and
select installed source sites without networking. Complete Wikipedia/source pages
still need network access. This planetary pack is independent of the lighter
discovery-text library's offline installation.

## Verification

Pure tests cover body-coordinate refusal, positive-east longitude wrapping,
projection/picking roundtrips, far-side visibility, safe planetary URLs, exclusion
of the Earth SDK and original texture hashes/size budget. A real-browser built-page
gate renders the actual maps using software WebGL, checks body/site switching,
English/French links, pointer/keyboard use and reload with networking disabled.
No foreign requests or page errors occurred in that gate. This does not establish
hardware GPU, VR, detailed topography or scientific map accuracy.

A separate failed-texture browser check verifies that switching to an unavailable
Mars map clears the old Moon pixels, hides pending markers and reports failure;
the interface does not present stale imagery under another body's source credit.

Sources: [NASA lunar kit](https://svs.gsfc.nasa.gov/4720/),
[NASA Mars texture](https://science.nasa.gov/3d-resources/mars/),
[Mars mean radius](https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html),
[NASA media guidance](https://www.nasa.gov/nasa-brand-center/images-and-media/),
[JPL image-use policy](https://www.jpl.nasa.gov/jpl-image-use-policy/).
