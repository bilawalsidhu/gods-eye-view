# Sky background

Catalogue stars over a soft Milky Way, drawn by `src/sky/starrySky.js` in
place of Cesium's blocky Tycho-2 sky box.

| File | Content | Size |
| ---- | ------- | ---- |
| `bright_stars.json` | 9,096 stars: J2000 RA/Dec, V magnitude, B−V | 235 KB |
| `milkyway_{px,nx,py,ny,pz,nz}.webp` | Milky Way glow, six 1024² cube faces, no stars | 62 KB |

## Stars — Yale Bright Star Catalogue

**Source:** 5th Revised Edition (Hoffleit & Warren 1991), CDS catalogue
[V/50](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50), file
`https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz` (sha256
`3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed`, fetched
2026-10-19).

**License:** public domain. CDS asks for an acknowledgement; the "Data
attribution" popover carries it.

**Build:** `node scripts/build-bright-stars.mjs [catalog.gz]`. Drops the 14
records without a J2000 position; rounds RA/Dec to 0.001° and magnitudes to
0.01.

## Milky Way — ESO/S. Brunier

**Source:** ESO image [eso0932a](https://www.eso.org/public/images/eso0932a/),
`https://cdn.eso.org/images/original/eso0932a.tif` (6000×3000 sRGB TIFF, sha256
`10f209ab83e1fd89e7fa1ed70277ffc6ed19c43549f04ec637c6806d98aff035`, fetched
2026-10-19).

**License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
**Credit: ESO/S. Brunier.**

**Changes made** (CC BY 4.0 asks for them): resampled to 4096×2048; stars
removed; two images of Jupiter painted over; blurred (0.4°, 2° in the faint
glow); reprojected to ICRF cube faces; black level at the median sky; saved as
WebP. Build: `node scripts/build-milky-way.mjs <eso0932a.tif>`.

The panorama's stars sit up to ~2° off; that is invisible in the blurred glow,
and every sharp star comes from the catalogue.

NASA SVS "Deep Star Maps 2020" was not used: it derives from Gaia DR2, which
ESA licenses CC BY-NC 3.0 IGO.

## Frame

Both layers are in ICRF/J2000. The cube faces use the WebGL face layout, +X
to the March equinox and +Z to the north celestial pole, uploaded without
`flipY`.
