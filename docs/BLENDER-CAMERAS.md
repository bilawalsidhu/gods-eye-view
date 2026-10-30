# GEV cameras in Blender

Export one saved Director scene into a camera-only JSON manifest, then import
editable shot cameras into a new Blender scene. This offline path requires no
API key, browser, imagery, terrain, model provider or rendering. It does not
export any tiles or geometry. Use independently licensed assets for your set.

The source remains the existing Director scene document. This adapter adds no
new tour authoring format or playback UI. It complements the scripted-camera
work discussed in [issue #1081](https://github.com/bilawalsidhu/gods-eye-view/issues/1081).

## Export a saved scene

Use the repository's supported Node runtime and installed dependencies. Save a
Director project as JSON, then run from the repository root:

```sh
node tools/export-blender-camera.mjs --input scene.json --output cameras.json --scene my-scene-id --origin 39.7,-105,1600 --fps 30000/1001 --width 1920 --height 1080 --horizontal-fov-deg 70
```

Quote paths containing spaces. Omit `--scene` only when the document contains
exactly one scene. Output must be a new file; the tool refuses to overwrite it.
No environment files are read.

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
to 100,000 frames and the CLI also enforces 64 MiB. Every shot needs at least
one sampled frame.

## Timing and camera semantics

Sampling uses GEV's Director **seek** interpolation and authored timing. Named
anchors and explicit `move.from` endpoints resolve through the existing camera
owner; explicit linear/cubic moves reuse its sampler. Ordinary shots use the
same cubic, shortest-angle interpolation as Director seeking from the previous
shot camera. The first ordinary shot starts at its own camera. A cut can be
authored as an explicit move with identical start/end poses.

The bridge does not reproduce Cesium's implicit live `flyTo` trajectory,
provider readiness, registered data-pack timing overrides, runtime layer holds,
layer-owned camera motion, lens changes, visual effects, media or geometry.
Export authored camera moves when repeatable playback framing is required.
This feature does not depend on GEV video export.

Frame 1 samples time zero. Frame `n` samples `(n - 1) * denominator / numerator`
seconds. The final sample precedes the exclusive scene end; frame count is the
ceiling of duration times fps, with rounding noise at integer boundaries removed.
Shot ranges are half open: `frameStart <= frame < frameEndExclusive`. Fractional
shot boundaries switch at the first sampled time at or after the boundary.
Both authored seconds and sampled frame ranges are retained.

## Import into Blender

The importer is a standalone Python file using the standard library and
Blender's bundled Python API. Tested with Blender 5.2.2 LTS; other versions
need their own check before use.

```sh
blender --background --factory-startup --disable-autoexec --threads 1 --python-exit-code 1 --python tools/blender/camera_import.py -- cameras.json cameras.blend
```

Both paths after `--` are required. Choose a new filename ending in lowercase
`.blend`; a missing or different extension is rejected before creating a scene. The importer
validates the entire manifest before changing Blender data and creates a new
scene, preserving existing scenes. It adds an identity ENU origin object,
one perspective camera per shot, sampled location/quaternion keyframes and
camera-bound timeline markers. Camera local X points right, local Y points up,
and local negative Z looks forward. Scene X/Y/Z are east/north/up, in meters.
Sensor fit is explicitly horizontal. Quaternion signs are kept continuous and
keyframe interpolation is linear between sampled frames.

Scene custom properties `gev_source`, `gev_coordinates` and `gev_timeline`
preserve geographic, attribution and rational-fps metadata. Camera custom
properties preserve source scene/shot IDs, titles, pack identifiers, endpoints
and authored timing. Source data-pack attributions are retained as text; no
referenced assets are fetched. The original fps ratio is preserved exactly in
metadata; Blender's `fps_base` is floating point, so its effective rate has a
small representation error. Cameras use a 0.01 m near plane and 200 km far
plane; adjust clipping for your separately authored set if needed.

For an existing Blender session, load this trusted module and call
`import_file(path)`; it also creates and selects a new scene. When writing your
own headless checks, activate that scene before evaluating its animation.

## Reproducible, provider-free check

Use a fresh output directory for each run. These commands create synthetic
camera data, run standard Python validation, import the actual cameras, compare
landmark projection to a separate Cesium Camera oracle, then save/reopen a
`.blend` and repeat. They do not render or launch a browser.

```sh
node --test src/tooling/blenderCamera.test.mjs
python tools/blender/test_camera_import.py
node tools/blender/make_fixture.mjs --output output/blender-camera-check
blender --background --factory-startup --disable-autoexec --threads 1 --python-exit-code 1 --python tools/blender/check_import.py -- output/blender-camera-check
```

The check covers moving and held cameras, nonzero roll, scene-local tangent
frames, a cut, landscape/portrait projection, rational fps, source metadata,
timeline marker selection, rejected malformed input and preservation of existing
scenes. `blender-receipt.json` records measured projection error and Blender
version. A successful run prints `BLENDER_CAMERA_PROJECTION_OK`.

Run the repository's normal unit, build, format and boundary checks too. The
contribution guide additionally requires live tracking/browser checks before
submission; this camera check does not replace them.
