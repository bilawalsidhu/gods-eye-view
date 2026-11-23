# View Sheets

A view sheet is one image of small shaded sprites: each subject rendered from
a sphere of camera angles. On a renderer with the `viewSheets` capability a
layer lays a contact flat on the earth along its course and the renderer
draws the frame nearest to where the eye is, as a card that tilts as the eye
moves off its direction until the next frame is the nearer (frames are not
blended), so a contact seen at an oblique angle looks solid and turns with
the camera.

- `aircraft-views.webp` holds the far-away aircraft of Flights, Military
  Flights and Local ADS-B.
- `vessel-views.webp` holds the vessels of the vessel layer.

Each has a manifest beside it (`.json`).

The sprites are rendered from the project's own procedural fleet models
([`../models/fleet/`](../models/README.md)), so, like them, they contain no
third-party artwork and are covered by the repository's
[MIT license](../../LICENSE).

| Path                  | What it holds                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aircraft-views.webp` | 4096 × 3648 px, lossless WebP: 64 px cells, 64 a row, 57 rows. Grey: every pixel's red, green and blue are equal.                                          |
| `aircraft-views.json` | The layout (`cellPx`, `columns`, `rows`, `ringStepDeg`, `rings`, `fill`, `grey`) and each subject's first cell, fleet model and bounding radius in metres. |
| `vessel-views.webp`   | 4096 × 2496 px, lossless WebP: 64 px cells, 64 a row, 39 rows. Grey.                                                                                       |
| `vessel-views.json`   | Its manifest, of the same shape.                                                                                                                           |

## Layout

A sheet holds each subject as a block of consecutive cells, row-major:
subject `i` starts at cell `i × frames`. Within a block the frames lie in
rings 7.5° apart from straight above (ring 0, one frame) downward. A ring
runs from the eye dead ahead of the nose or bow, round the starboard side, to
dead astern. The renderer mirrors a starboard frame for an eye on the port
side, so the light is symmetric about the subject's centre plane. A frame is
an orthographic view centred on the model's origin, its bounding sphere
spanning 0.92 of the cell, turned so that straight above the nose points up
the image. `src/data/viewSheet.js` holds the layouts (`AIRCRAFT_VIEWS`,
`VESSEL_VIEWS`) and the maths that picks a frame;
`src/data/viewSheet.test.mjs` checks the manifests, the shipped images and
the bake script against them.

| Sheet    | Frames a subject | Rings                                                                                                 | Subjects, in order                                                                                                                                                                                 |
| -------- | ---------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aircraft | 302              | 17, to 30° below the horizon: 1, 4, 7, 10, 13, 16, 18, 20, 22, 23, 24, 25, 25, 25, 24, 23, 22         | `airliner`, `widebody`, `quadjet`, `turboprop`, `light`, `glider`, `fastjet`, `bizjet`, `uav`, and `helicopter0` to `helicopter2` (the helicopter's three rotor frames, `src/data/rotorFrames.js`) |
| Vessels  | 208              | 13, to the horizon (a ship is never seen from below): 1, 4, 7, 10, 13, 16, 18, 20, 22, 23, 24, 25, 25 | `cargo`, `tanker`, `passenger`, `highspeed`, `fishing`, `tug`, `sailing`, `pleasure`, `military`, `other` (the kinds of `vesselKind`, `src/data/vesselTypes.js`), `dredger`, `pilot`               |

The sprites are neutral (light paint, grey shading, dark glass, a dark edge)
so each layer's tint multiplies them, as it does the flat glyphs. They are
exactly grey (`"grey": true`): the renderer keeps a sheet as grey and alpha,
reading its red channel, which halves its memory. The bake refuses a frame
that is not grey, and so does the step that writes the WebP. Every cell keeps
its outer 2 px transparent, so the renderer's mipmaps never pull in a
neighbour.

Thin subjects are thickened a little before their edge so they still read
20 to 30 px wide: the glider, UAV, light aircraft and helicopter, and every
vessel (the container ship, tanker and patrol boat most).

Vessels differ from aircraft in four ways:

- **Waterline.** A ship model's origin is its waterline. Each model is cut
  there before it is rendered, so no hull below the water is drawn, even from
  the horizon.
- **Paint.** The ship models are many colours (hull paint, decks,
  containers). The vessel paint makes every colour a light grey, black hull
  paint included, except the windows (a dark colour whose blue stands above
  its red), which stay dark.
- **Beam.** Hulls are long and thin, so most are widened across the beam
  (1.2 to 1.5 times; the trawler and tug as built). The side view keeps its
  true height.
- **Sailboat.** The sailboat's mast is taller than its hull is long. Above
  1.2 m it is squashed to 0.4 of its height, so the hull fills its cell from
  above and the sail still reads from the side.

## Rebuilding

```
npm run build:aircraft-views               # about 7 minutes
npm run build:vessel-views                 # about 4 minutes
npm run build:vessel-views -- --only tug,sailing --out /tmp/views
```

This needs Blender (`$BLENDER`, else `blender` on the `PATH`, else
`/Applications/Blender.app`). Each runs `scripts/build-view-sheet.mjs`, which
runs `scripts/bake-view-sheet.py --sheet aircraft|vessels` headless (one
script, with each sheet's layout, models, paint and adjustments). The bake
renders every frame with Cycles and refuses a frame whose pixels reach
within 2 px of its cell's edge. `build-view-sheet.mjs` then writes the PNG as
lossless WebP here with the manifest. With `--only`, the other subjects'
cells are left empty, so ship only a full bake. Cycles is not
bit-reproducible, so a rebuild changes the WebP's bytes slightly; rebuild a
sheet only to change it.

To review a bake, write a contact sheet per subject: its rings as rows, plus
a few frames at 40, 30 and 20 px in each tint the layers draw it with.

- Aircraft: over a dark sea, pale land and a mid satellite tone, in the
  fleet, tracked and military tints.
- Vessels: over a dark sea, pale shallow water and a satellite ocean tone,
  in white and the kind's colour.

```
node scripts/qa-view-sheet.mjs --manifest public/sprites/vessel-views.json [--out qa-shots/vessel-views]
```
