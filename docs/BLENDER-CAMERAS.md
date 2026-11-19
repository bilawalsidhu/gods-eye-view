# GEV cameras in Blender

Export the cameras of one saved Director scene as a camera-only USD stage
(`.usda`, plain text) and open it with Blender's built-in importer. The export
needs no API key, network, browser or Blender add-on and contains no imagery or
geometry, so use independently licensed assets for your set.

## Export a saved scene

Save a Director project as JSON, then run from the repository root:

```sh
mkdir -p output
node tools/export-blender-camera.mjs --input scene.json --output output/cameras.usda --scene my-scene-id --origin 39.7,-105,1600 --fps 30000/1001 --width 1920 --height 1080 --horizontal-fov-deg 70
```

Paths are relative to the current directory; `output/` is ignored by git.
Omit `--scene` only when the document contains exactly one scene. `--output`
is required and must be a new file ending in `.usda`; the tool refuses to
overwrite it. No environment files are read.

`--origin` is latitude, longitude and **WGS84 ellipsoid height in meters**.
Positions and sampled paths must remain within 100 km of that origin. Heights
are never implicitly converted from mean sea level or above ground level.
Positions must be complete; legacy documents without saved IDs or positions
need to be saved again in GEV before export.

Projection and fps are required because Director documents do not record a
viewport lens, aspect ratio or video frame rate. `--horizontal-fov-deg` is the
horizontal perspective FOV in degrees, even for portrait output. If deriving it
from a Cesium `PerspectiveFrustum`, use
`2 * atan(tan(fovy / 2) * aspectRatio) * 180 / π` (`fovy` is in radians).
Do not assume `frustum.fov` is horizontal: it is the wider-dimension FOV.
The optional `--sensor-width-mm` defaults to 36; focal length is
`sensorWidthMm / (2 * tan(horizontalFovRadians / 2))`.

The exporter supports integer fps or an integer ratio such as `30000/1001`,
with an effective rate from 1 to 240. Image dimensions are integers from 4 to
16384, pixels are square, horizontal FOV is 1 to 179 degrees and sensor width
is 1 to 100 mm. A lens shorter than Blender's 1 mm minimum is rejected.
Input must be a regular file within the existing 5 MiB scene-document limit;
output is limited to 100,000 frames and 64 MiB. Every shot needs at least one
sampled frame.

## Timing and camera semantics

Timing is the Director's **runtime** seek timing. The exporter loads the
document as Director does, so ordinary shots fly for at least 0.2 s, and takes
each shot's length and hold from `shotRuntimeTiming` in
`src/scenes/shotPresentation.js` with the default scene packs. Registered hold
overrides, minimum holds and evidence-sequence durations therefore move later
shots as they do when seeking in the app. Live playback can run longer when it
waits for a layer's media. Saved shots are never rewritten; each camera
records both the authored and the runtime hold.

Each frame's camera is the Director's `sceneSeekState` pose at that time.
Named anchors and explicit `move.from` endpoints resolve through the existing
camera owner, and explicit linear/cubic moves use its sampler. Ordinary shots
interpolate cubically, by the shortest angle, from the previous shot's camera;
a shot that opens the scene starts at its own camera. A cut can be authored as
an explicit move with identical start/end poses.

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
  east/north/up in meters around `--origin`, in the geodetic ENU frame (axes
  from the WGS84 ellipsoid normal at the origin's latitude and longitude), so
  Blender applies no axis or unit conversion.
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
  attribution text, as `userProperties:` attributes. No referenced assets are
  fetched.

## Import into Blender

1. In Blender, choose **File > Import > Universal Scene Description**, select
   the `.usda` file and keep **Set Frame Range** enabled.
2. Set **Output Properties > Format** to the exported `--width`, `--height` and
   frame rate, with **Aspect X:Y** at 1:1. USD carries the time codes but not
   render resolution, and Blender does not take its scene frame rate from the
   file.
3. Pick a shot camera as the active camera, or bind cameras to timeline markers
   at each shot's `gevFrameStart` (shown under **Object Data Properties >
   Custom Properties**).

How Blender maps the lens: its USD importer multiplies `focalLength` and the
apertures by `100 * metersPerUnit` to get millimeters. With this exporter's
`metersPerUnit = 1` that is ×100, so the imported **Focal Length** and
**Sensor Width** equal the `lensMm` and `--sensor-width-mm` values. Blender
chooses horizontal sensor fit when the horizontal aperture is at least as large
as the vertical one and vertical fit otherwise, so portrait exports import with
vertical fit and the same field of view. This mapping is in Blender's
`usd_reader_camera.cc`.

Blender imports animated USD transforms as a **Transform Cache** constraint
that keeps the absolute path of the imported `.usda`. Put the file in its
permanent place before importing, or update the path in the constraint after
moving it. For a self-contained file, select the cameras and use **Object >
Animation > Bake Action…** with **Visual Keying** and **Clear Constraints**.
Blender stores object transforms in single precision: up to about 4 mm of
rounding at 100 km, less closer to the origin.

## Checks

```sh
node --test src/tooling/blender*.test.mjs
```

The tests compare the export with an independent Cesium camera and the
Director's runtime timing, and parse the stage with OpenUSD's `usdcat` when it
is installed.
