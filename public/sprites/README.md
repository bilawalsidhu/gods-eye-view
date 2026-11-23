# Aircraft View Sheet

`aircraft-views.webp` is the sheet of shaded sprites far-away aircraft are
drawn with in Flights, Military Flights and Local ADS-B, on a renderer with the
`viewSheets` capability. Each aircraft class is rendered from a sphere of
camera angles; the renderer lays a contact flat on the earth along its course
and draws the frame nearest to where the eye is, as a card that tilts as the
eye moves off its direction until the next frame is the nearer (frames are
not blended), so an aircraft seen at an oblique angle looks solid and turns
with the camera. `aircraft-views.json` is its manifest.

The sprites are rendered from the project's own procedural fleet models
([`../models/fleet/`](../models/README.md)), so, like them, they contain no
third-party artwork and are covered by the repository's
[MIT license](../../LICENSE).

| Path | What it holds |
|---|---|
| `aircraft-views.webp` | 4096 × 3648 px, lossless WebP: 64 px cells, 64 a row, 57 rows. Grey: every pixel's red, green and blue are equal. |
| `aircraft-views.json` | The layout (`cellPx`, `columns`, `rows`, `ringStepDeg`, `rings`, `fill`, `grey`) and each subject's first cell, fleet model and bounding radius in metres. |

## Layout

Each subject owns 302 consecutive cells, row-major: subject `i` starts at
cell `i × 302`. The subjects, in order, are `airliner`, `widebody`, `quadjet`,
`turboprop`, `light`, `glider`, `fastjet`, `bizjet`, `uav`, and `helicopter0`
to `helicopter2` (the helicopter's three rotor frames, `src/data/rotorFrames.js`).

Within a block the frames lie in 17 rings 7.5° apart, from straight above
(ring 0, one frame) to 30° below the horizon, of 1, 4, 7, 10, 13, 16, 18, 20,
22, 23, 24, 25, 25, 25, 24, 23 and 22 frames. A ring runs from the eye dead
ahead of the nose, round the starboard side, to dead astern; the renderer
mirrors a starboard frame for an eye on the port side, so the light is
symmetric about the aircraft's centre plane. A frame is an orthographic view
centred on the model's origin, its bounding sphere spanning 0.92 of the cell,
turned so that straight above the nose points up the image.
`src/data/viewSheet.js` holds the same layout and the maths that picks a frame
(`AIRCRAFT_VIEWS`); `src/data/viewSheet.test.mjs` checks the manifest and the
bake script against it.

The sprites are neutral (white paint, grey shading, dark glass, a dark edge)
so each layer's tint multiplies them, as it does the flat glyphs. They are
exactly grey (`"grey": true`): the renderer keeps the sheet as grey and
alpha, reading its red channel, which halves its memory. The bake refuses a
frame that is not grey, and so does the step that writes the WebP. The thin
glider, UAV, light aircraft and helicopter are thickened a little before
their edge so they still read 20 to 30 px wide. Every cell keeps its outer
2 px transparent, so the renderer's mipmaps never pull in a neighbour.

## Rebuilding

```
npm run build:aircraft-views               # about 7 minutes
npm run build:aircraft-views -- --only glider,uav --out /tmp/views
```

This needs Blender (`$BLENDER`, else `blender` on the `PATH`, else
`/Applications/Blender.app`). It runs `scripts/build-aircraft-view-sheet.py`
headless, which renders every frame with Cycles and refuses a frame whose
pixels reach within 2 px of its cell's edge, then
`scripts/build-aircraft-views.mjs` writes the PNG as lossless WebP here with
the manifest. With `--only`, the other subjects' cells are left empty, so
ship only a full bake.

To review a bake, write a contact sheet per subject (its rings as rows over a
dark sea, pale land and a mid satellite tone, plus a few frames at 40, 30 and
20 px in the fleet, tracked and military tints):

```
node scripts/qa-aircraft-view-sheet.mjs [--manifest public/sprites/aircraft-views.json] [--out qa-shots/aircraft-views]
```
