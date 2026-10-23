# Bundled NASA night-light texture

The primary texture is `black-marble-svs-night-lights-2023-8192.png`,
8,192 × 4,096 RGBA (about 4.25 MB). It contains the **2023 annual average**
independent light signal from [NASA Scientific Visualization Studio 5276](https://svs.gsfc.nasa.gov/5276/),
visualization by Kel Elkins using NASA Black Marble. It replaces the previous
3,600 × 1,800, 2016 browse texture with a more detailed, newer visualization.
This is presentation imagery, not raw VNP46A4 radiance for scientific analysis.
The 2023 year is the observation year, not the year of download or a claim
that this is the latest annual scientific product.

## Source and preparation

The original is the 7,680 × 4,320 TIFF in the official
[independent-lights frame set](https://svs.gsfc.nasa.gov/vis/a000000/a005200/a005276/frames/7680x4320_16x9_3p/nightlights_flat_2012-2023_only_lights/):
[2023 TIFF](https://svs.gsfc.nasa.gov/vis/a000000/a005200/a005276/frames/7680x4320_16x9_3p/nightlights_flat_2012-2023_only_lights/nightlights_flat_series_stills_8k_only_lights.2023.tif).
Credit: NASA's Scientific Visualization Studio / Kel Elkins / NASA Black Marble.
NASA imagery is generally public domain; the source credit is retained in the
application's Data attribution popover and in `DATA_SOURCES.md`.

Preparation uses Pillow and NumPy: read the TIFF as RGB, take the maximum RGB
channel as the light signal, remove its year annotation in the empty South
Atlantic rectangle `[3300:3730, 2630:2800]` (x, y; upper endpoints exclusive),
resize with Lanczos to 8,192 × 4,096, and copy the signal into all four RGBA
channels. Black becomes transparent; the renderer supplies the gold color.
The full TIFF spans the entire world stretched to 16:9. Restore the 2:1
geographic aspect ratio without cropping: north is at the top, longitude
runs -180° to +180°, and latitude +90° to -90°. A registration comparison
against the previous geographic light mask confirmed full-frame alignment.
The source's horizontal detail is 7,680 pixels; the small resize to 8,192
supports power-of-two mipmaps and does not add new measured detail.

SHA-256:

- Source TIFF: `2ce960101d4a8c2dbbdb78d9c0624f608c9fe920652764e5c1f6ad24076b2734`
- Bundled PNG: `6392099187b337eea84929cd3026c9d831559192f4b911a9ed53527e98b28de5`

The existing `vnp46a4-viirs-night-lights-2016-3600.png` remains a local fallback.
It was assembled from NASA GIBS `VIIRS_Night_Lights`, dated `2016-01-01`.
The older photographic composite is retained as a legacy asset, not the
active independent-lights source. All runtime night-light assets are local.

## Rendering

The static lamp texture is uploaded once per native imagery host. Cesium's
automatic `czm_sunDirectionWC` drives the GPU night shading every frame;
the minute callback only requests rendering. It does not read image pixels,
rebuild mipmaps or replace layers. Native geometry keeps the effect aligned
with zoom, rotation, photorealistic 3D maps and visual presets such as NVG.

The night layer stays below data imagery. The blue-purple night tint uses
94% darkness, with warm gold lamps and a widened twilight transition. The
lamp fade band lies entirely on the night side, reaching zero at the daylight
boundary. Display can toggle the effect, and zoom transitions fade over 360 ms.

Runtime uses up to 8,192 × 4,096 with trilinear mipmaps and the engine's native
anisotropic filtering. Hardware with a smaller maximum texture size receives
a reduced texture. At 8K, RGBA storage is 128 MiB plus approximately 171 MiB
for the GPU texture including mipmaps; avoid 16K without a memory budget.

`src/maps/nativeRasterImagery.js` adapts both globe and photorealistic model
shaders in **Cesium 1.138**. A reserved brightness selector on the owned night
layer enables its GPU processing and is reset before native color processing.
Other imagery retains ordinary shading. Global model rasters sample geographic
UVs per fragment with periodic derivatives, avoiding the ±180° longitude seam.
These private shader contracts are guarded; revalidate both pipelines before
upgrading Cesium.
