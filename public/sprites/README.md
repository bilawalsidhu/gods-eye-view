# Aircraft View Sheet

`aircraft-views.webp` is the sheet of shaded sprites far-away aircraft are
drawn with in Flights, Military Flights and Local ADS-B, on a renderer with the
`viewSheets` capability. Each aircraft class is rendered from a sphere of
camera angles. The renderer chooses the frame for the camera's direction.
Its manifest is [`src/data/aircraftViews.json`](../../src/data/aircraftViews.json),
which the app imports.

The sprites are rendered from the project's own procedural fleet models
([`../models/fleet/`](../models/README.md)), so, like them, they contain no
third-party artwork and are covered by the repository's
[MIT license](../../LICENSE).

| Path                          | What it holds                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aircraft-views.webp`         | 4096 × 3648 px, lossless WebP: 64 px cells, 64 a row, 57 rows. Grey: every pixel's red, green and blue are equal.                                  |
| `src/data/aircraftViews.json` | The layout (`cellPx`, `columns`, `rows`, `ringStepDeg`, `rings`, `fill`) and each subject's first cell, fleet model and bounding radius in metres. |

## Layout

Each subject owns 302 consecutive cells, row-major: subject `i` starts at
cell `i × 302`. The subjects, in order, are `airliner`, `widebody`, `quadjet`,
`turboprop`, `light`, `glider`, `fastjet`, `bizjet`, `uav`, and `helicopter0`
to `helicopter2` (the helicopter's three rotor frames, with angles set in `src/data/aircraftIcons.js`).

Each frame is an orthographic view centred on the model's origin. Its bounding
sphere spans 0.92 of the cell. The bake script's constants are the one source
of the layout: it writes them into the manifest, and `AIRCRAFT_VIEWS` in
`src/data/aircraftViews.js` is built from the manifest. `src/data/viewSheet.js`
describes the frame maths. Each class is baked from the fleet model it is
drawn with up close (`CLASS_MODELS` in `src/data/fleetModels.js`), which
`src/data/aircraftViews.test.mjs` checks. The airliner, which has no class
model, uses the A320.

The sprites are neutral (white paint, grey shading, dark glass, a dark edge)
so each layer's tint multiplies them, as it does the flat glyphs. They are
exactly grey: the renderer keeps the sheet as grey and
alpha, reading its red channel, which halves its memory. The bake refuses a
frame that is not grey. The thin
glider, UAV, light aircraft and helicopter are thickened a little before
their edge so they still read 20 to 30 px wide. Every cell keeps its outer
2 px transparent, so the renderer's mipmaps never pull in a neighbour.

## Rebuilding

```
npm run build:aircraft-views               # about 7 minutes
npm run build:aircraft-views -- --only glider,uav --out /tmp/views
```

This needs Blender 5.2 or newer (`$BLENDER`, else `blender` on the `PATH`, else
`/Applications/Blender.app`). It runs `scripts/build-aircraft-view-sheet.py`
headless, which renders every frame with Cycles and refuses a frame whose
pixels reach within 2 px of its cell's edge, then
`scripts/build-aircraft-views.mjs` writes the PNG as lossless WebP here and
the manifest to `src/data/aircraftViews.json`. With `--out`, both go into that
directory. With `--only`, the other subjects' cells are left empty, so the build
refuses an `--out` inside `public/sprites` and a manifest at
`src/data/aircraftViews.json`. Give `--out` a separate directory.

`npm test` never starts Blender. The bake's tests that need the real Blender
run with `npm run test:blender`.

To review a bake, write a contact sheet per subject (its rings as rows over a
dark sea, pale land and a mid satellite tone, plus a few frames at 40, 30 and
20 px in the fleet and military tints):

```
node scripts/qa-aircraft-view-sheet.mjs [--manifest src/data/aircraftViews.json] [--out qa-shots/aircraft-views]
```
