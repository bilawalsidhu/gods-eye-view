# GEV cameras in Blender

Export one saved Director scene as a camera-only USD stage (`.usda`, plain
text), then open it with Blender's built-in importer: **File > Import >
Universal Scene Description**. The exporter is a Node script with no new
dependency. This offline path requires no API key, browser, imagery, terrain,
model provider, rendering or Blender add-on. It does not export any tiles or
geometry. Use independently licensed assets for your set.

The source remains the existing Director scene document. This adapter adds no
new tour authoring format or playback UI. It complements the scripted-camera
work discussed in [issue #1081](https://github.com/bilawalsidhu/gods-eye-view/issues/1081).

## Export a saved scene

Use the repository's supported Node runtime and installed dependencies. Save a
Director project as JSON, then run from the repository root:

```sh
node tools/export-blender-camera.mjs --input scene.json --output cameras.usda --scene my-scene-id --origin 39.7,-105,1600 --fps 30000/1001 --width 1920 --height 1080 --horizontal-fov-deg 70
```

Quote paths containing spaces. Omit `--scene` only when the document contains
exactly one scene. Output must be a new file ending in `.usda`; the tool
refuses to overwrite it. No environment files are read.

`--origin` is latitude, longitude and **WGS84 ellipsoid height in meters**.
Positions and sampled paths must remain within 100 km of that origin. Heights
are never implicitly converted from mean sea level or above ground level.
Positions must be complete; legacy documents without saved IDs or positions
need to be saved again in GEV before export.

Projection and fps are required because Director documents do not record a
viewport lens, aspect ratio or video frame rate. `--horizontal-fov-deg` is the
horizontal perspective FOV, even for portrait output. If deriving it from a
Cesium `PerspectiveFrustum`, use `2 * atan(tan(fovy / 2) * aspectRatio)`.
Do not assume `frustum.fov` is horizontal: it is the wider-dimension FOV.
The optional `--sensor-width-mm` defaults to 36; focal length is
`sensorWidthMm / (2 * tan(horizontalFovRadians / 2))`.

The exporter supports integer fps or an integer ratio such as `30000/1001`,
with an effective rate from 1 to 240. Image dimensions are integers from 4 to
16384, pixels are square, horizontal FOV is 1 to 179 degrees and sensor width
is 1 to 100 mm. A lens shorter than Blender's 1 mm minimum is rejected.
Input is bounded to the existing 5 MiB scene-document limit; output is limited
to 100,000 frames and 64 MiB. Every shot needs at least one sampled frame.

## Timing and camera semantics

Shot timing is the Director's **runtime** timing, not only the saved
`durationSec` and `holdSec`. Each shot's length and hold come from
`shotRuntimeDurationSec` and `effectiveShotHoldSec` in
`src/scenes/shotPresentation.js` with the installed default scene packs, the
same functions Director playback and seeking use. Registered pack hold
overrides, minimum holds and evidence-sequence durations therefore move later
shots exactly as they do in the app. Saved shots are never rewritten; each
camera records both the authored and the runtime hold.

Camera poses follow GEV's Director **seek** interpolation. Named anchors and
explicit `move.from` endpoints resolve through the existing camera owner;
explicit linear/cubic moves reuse its sampler. Ordinary shots use the same
cubic, shortest-angle interpolation as Director seeking from the previous shot
camera. The first ordinary shot starts at its own camera. A cut can be authored
as an explicit move with identical start/end poses. Unit tests compare every
exported sample with the Director's `sceneSeekState`.

The bridge does not reproduce Cesium's implicit live `flyTo` trajectory,
provider readiness, layer-owned camera motion, lens changes, visual effects,
media or geometry. Export authored camera moves when repeatable playback
framing is required. This feature does not depend on GEV video export.

Frame 1 samples time zero. Frame `n` samples `(n - 1) * denominator / numerator`
seconds. The final sample precedes the exclusive scene end; frame count is the
ceiling of duration times fps, with rounding noise at integer boundaries removed.
Shot ranges are half open: `frameStart <= frame < frameEndExclusive`. A shot
boundary switches at the first sampled time at or after the boundary.

## What the USD stage contains

- Stage metadata `upAxis = "Z"` and `metersPerUnit = 1`. Scene X/Y/Z are
  east/north/up in meters around `--origin`, so Blender applies no axis or
  unit conversion.
- USD time codes equal frame numbers: `startTimeCode = 1`, `endTimeCode` is the
  last frame, and `timeCodesPerSecond`/`framesPerSecond` hold the effective
  rate. The exact fps ratio is kept as text.
- A root `GEV` transform at identity, with one perspective `Camera` per shot
  named `Shot_001_<id>`, `Shot_002_<id>` and so on. Each camera has an
  `xformOp:transform` matrix time sample on every frame of its own shot range,
  and holds its first or last pose outside that range. Camera local X points
  right, local Y up and local -Z forward, which is both the USD and the Blender
  camera convention.
- Lens attributes in USD's units: `focalLength`, `horizontalAperture` and
  `verticalAperture` are in **tenths of a scene unit**, so with
  `metersPerUnit = 1` one unit of these attributes is 100 mm. A 25 mm lens on
  a 36 mm sensor is written as `focalLength = 0.25` and
  `horizontalAperture = 0.36`. The vertical aperture is the sensor width times
  `height / width`, so it matches the output aspect.
- Clipping range 0.01 m to 200 km; adjust it for your set if needed.
- Source scene and shot IDs, titles, pack identifiers, authored and runtime
  timing, frame ranges, origin, fps ratio, image size and data-pack
  attribution text, as `userProperties:` attributes and as JSON in the layer's
  `customLayerData`. No referenced assets are fetched.

## Import into Blender

1. In Blender, choose **File > Import > Universal Scene Description**, select
   the `.usda` file and keep **Set Frame Range** enabled.
2. Set **Output Properties > Format** to the exported `--width`, `--height` and
   frame rate. USD carries the time codes but not render resolution, and
   Blender does not take its scene frame rate from the file.
3. Pick a shot camera as the active camera, or bind cameras to timeline markers
   at each shot's `gevFrameStart` (shown under **Object Data Properties >
   Custom Properties**).

How Blender maps the lens: its USD importer multiplies `focalLength` and the
apertures by `100 * metersPerUnit` to get millimeters. With this exporter's
`metersPerUnit = 1` that is ×100, so the imported **Focal Length** and
**Sensor Width** equal the `lensMm` and `--sensor-width-mm` values. Blender
chooses horizontal sensor fit when the horizontal aperture is the larger one
and vertical fit otherwise, so portrait exports import with vertical fit and the
same field of view. This mapping is in Blender's
`source/blender/io/usd/intern/usd_reader_camera.cc` and is the same in 4.2 LTS,
4.5, 5.0 and current `main`.

Blender imports animated USD transforms as a **Transform Cache** constraint
that reads the `.usda` file, so keep the file next to the `.blend`, or select
the cameras and use **Object > Animation > Bake Action…** with **Visual
Keying** and **Clear Constraints** for a self-contained file. Blender stores object transforms in single precision;
within the 100 km origin limit this is millimeter-level at the edge and finer
closer to the origin.

## Checks

```sh
node --test src/tooling/blenderCamera.test.mjs
```

These Node tests run in CI. They cover camera axes against an independent
Cesium Camera, ENU translation, landscape and portrait lenses, rational fps,
cuts, anchors and moves, runtime holds from registered packs (including the
Director's Mailung trim, which plays a 7.65 s hold where 15 s was saved), every
sample against `sceneSeekState`, the USD stage metadata, lens units and
per-frame matrices, CLI overwrite and extension refusals, and input limits.

Run the repository's normal unit, build, format and boundary checks too. The
contribution guide additionally requires live tracking/browser checks before
submission; this camera check does not replace them.
