# Auto-Director: narrated tours from live data

"Make me a 60-second tour of the busiest airspace right now." The local voice
assistant (`AI_PROVIDER=ollama`) answers by building a Director scene from the
records that are loaded at that moment, playing it through the existing scene
playback engine and speaking one line per shot. Nothing here is a new player:
the tour is an ordinary scene document, visible in the Scenes panel while it
runs and replayable, editable and shareable afterwards like any other scene.

## Tools

The pack lives in `src/voice/tools/director.js` and registers through
`src/voice/tools/index.js`; the pure planner is `src/voice/tourBuilder.js`.

| Tool        | Arguments                                                         | Result                                                                                                                                      |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `make_tour` | `theme` (default `airspace`), `seconds` (8-900, default 60), `narrate` (default true) | `{ ok, mode, theme, layer, place, durationSec, shots: [{ title }], saved, sceneId, fallback?, note?, hint }`                                    |
| `stop_tour` | none                                                              | `{ ok, wasRunning }`                                                                                                                        |
| `save_tour` | `name`                                                            | `{ ok, name, sceneId, persisted, downloaded, file?, bundleBytes }`                                                                          |

`theme` accepts a key or the user's words: `airspace` (flights, planes, air
traffic), `ships` (vessels, harbor, port), `fires` (wildfires, hotspots),
`quakes` (earthquakes, seismic), `military` (jets) or `view` (here, around,
this). Anything else means `view`.

## How a tour is chosen

1. **Focus.** The theme's layer (`flights`, `ais-live-vessels`, `local-firms`,
   `earthquakes`, `military`) is read through the same `getAnalystRecords()`
   snapshot the analyst engine uses; flights are enriched with airline and
   route from `getAllPositions()`. If the layer is off, `make_tour` turns it on
   through the upstream `set_layer_visibility` action and waits up to eight
   seconds for a first snapshot. The densest 1° cell wins; its centroid is the
   focus and the spoken count is every record within 60 km of it. `airspace`
   falls back to military records when no civil flights are loaded.
2. **Highlights.** Airspace: the highest aircraft, then the fastest, then one
   per distinct operator. Ships: the fastest, then one per ship type. Fires by
   radiative power; quakes by magnitude.
3. **Shots.** `shotCountFor(seconds)` gives one shot per ten seconds, 4-8. The
   sequence is an establishing wide (pitch about -58°, 130 km up for airspace),
   a pose-to-pose **sweep** around the focus (an authored `move` with
   `cubic-in-out` easing and ellipsoidal heights, so seek and playback share the
   Director's sampler), one shot per highlight standing off behind and above the
   target and looking at it, and a closing wide from the other side.
4. **Budget.** `budgetShots()` splits the requested seconds across the shots
   (flight 40-80 % of each share, hold the rest, at least 0.3 s of hold) and
   the final hold absorbs rounding, so the scene's `durationSec + holdSec` total
   is the requested length. The Director's own progress bar reflects it.
5. **Narration.** One line per shot, for example
   "Now over Dallas–Fort Worth: 42 aircraft within 60 km; the highest is
   United UAL1234 at 11600 m." Places come from a bundled hub gazetteer
   (`TOUR_HUBS`, nearest within 150 km) and otherwise from the app's reverse
   geocoder with a 2.5 s cap, falling back to coordinates.

With no records for the theme and a usable camera, the tour becomes an orbit of
the point the camera is looking at (`theme: 'view'`, `fallback: 'no-data'`),
counting whatever other layers have within 100 km. With neither, `make_tour`
returns `ok: false`.

## Director integration

The tour is loaded with the Director's validated document path rather than by
editing playback state:

- The scene (`id: auto-tour`) is appended to a copy of the current project,
  replacing any earlier auto tour, and handed to
  `sceneDirector.importProjectFile(file, { prepared: { project, assets }, selection })`
  — the same seam the Scenes panel's EDIT DETAILS uses. It validates the
  document (`stringifySceneDocument`), stops any running scene, persists the
  project and publishes `project-imported`, so the tour appears in the Scenes
  panel. The current project is read from `sceneDirector._project` and bundle
  assets from `sceneDirector._bundleAssets.snapshot()`; there is no public
  getter for either yet.
- Playback is `sceneDirector.startScene('auto-tour', { single: true })`, the
  same call the `control_scene` voice action makes, so recording preview, camera
  ownership and layer reconciliation behave exactly as for an authored scene.
- Narration subscribes to `sceneDirector.subscribe()` and speaks a shot's line
  when the Director publishes `run-event` / `shot_start` for that shot id,
  unsubscribing on `scene_run_complete`, `scene_stopped` or `scene_run_error`.
  Lines go through the voice session (`context.speak`), or a toast plus browser
  speech when no session is open. With `narrate: false` the shot title is
  toasted instead.
- Each shot declares only the theme's layer (`layers: { flights: { enabled: true } }`)
  and the scene has no `releaseLayerIds`, so playback never turns other layers
  off and leaves the theme layer on when it ends. The shots carry the current
  `getVisualState()` so the look you had is the look the tour has.

If the Director cannot take a document (no `importProjectFile`, validation
failure or a rejected import) the pack falls back to a camera sequence:
`styleManager.applyCameraState(pose, durationSec)` per shot with timed holds,
narrated the same way. The result reports `mode: 'camera-sequence'` and
`saved: false`; nothing is written to the project in that mode.

`stop_tour` calls `sceneDirector.stopScene('Tour stopped by voice')`, drops the
narration subscription and cancels any fallback sequence.

## Saving and sharing

`save_tour { name }` renames the last tour, re-ids it as `tour-<slug>` so the
next `make_tour` does not overwrite it, persists it through the same
`importProjectFile` path, and downloads `<slug>.gevbundle.json` produced by
`createSceneBundle()` from `src/director/sharing/bundle.js`. Tours declare no
data packs, so the bundle carries the scene document and an empty asset list;
IMPORT in the Scenes panel reads it back, and EXPORT PRESETS / SHARE SCENE keep
working on it as on any scene.

## Tests

- `src/voice/tourBuilder.test.mjs`: theme resolution, densest cell, hub
  naming, highlight order, the time budget, per-theme narration, the empty-data
  orbit and the no-camera error; every generated scene passes
  `parseSceneDocument`.
- `src/voice/tools/director.test.mjs`: the import-and-play path against a fake
  SceneDirector, narration on `shot_start`, `narrate: false`, `stop_tour`,
  layer enabling and the view fallback, a refused start, the camera-sequence
  fallback, reverse-geocoded naming and `save_tour` persistence plus bundle
  output.
- `scripts/qa-auto-director.mjs`: headless smoke. With a dev server on port
  4323 (`npx vite --port 4323`), `QA_BASE_URL=http://127.0.0.1:4323 node
  scripts/qa-auto-director.mjs 10` builds a 10 s tour, checks it played through
  the Director with one spoken line per shot, that `save_tour` persisted and
  bundled it, and that no page or console errors were raised during the tour.
  `QA_BASELINE=1` idles for the same time instead, to attribute boot-time errors.
