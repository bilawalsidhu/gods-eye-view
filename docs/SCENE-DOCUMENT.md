# Scene document format

Scenes exports a UTF-8 JSON project. Version 5 adds [data packs](DIRECTOR-DATA-PACKS.md)
and is the write format. Versions 1, 2, 3, 4 and unversioned legacy files migrate on
import without converting their existing shots into authored moves. Unknown versions or unsupported fields are rejected with
a field path before the current project, selection or saved bytes change.

```json
{
  "version": 5,
  "scenes": [{
    "id": "my-scene",
    "title": "My scene",
    "shots": [{
      "id": "my-shot",
      "title": "Arrival",
      "durationSec": 4,
      "holdSec": 1,
      "camera": { "lat": 51.5, "lon": -0.12, "alt": 800,
        "heading": 0, "pitch": -35, "roll": 0 },
      "visual": { "style": "normal" },
      "layers": { "traffic": { "enabled": true } }
    }]
  }]
}
```

## Fields and migration

The root requires `scenes` (an array, which may be empty). Optional root fields
are `version`, `createdAt`, `updatedAt` and `installedBuiltInSceneIds` (string IDs).
Each scene requires a `shots` array; optional fields are `id`, `title`,
`releaseLayerIds`, `appliedShotPacks` and version-4 `anchors`. A pack marker has `id`, optional numeric
`version` and `shotBindings` (original shot title to saved shot ID). These markers
retain the editor's existing pack-update and rename behavior.

Shots accept `id`, `title`, `durationSec`, `holdSec`, `camera`, `visual`, `layers`,
`sourcePackId`, `sourcePackVersion` and version-4 `move`. Scene IDs are unique within the project;
shot IDs are unique within their scene. Existing IDs and pack bindings survive
migration. Missing IDs are generated once and persisted by the next save/export.
Missing titles and optional camera/visual fields receive the editor's defaults.
Empty scenes and intentionally empty projects remain empty.

Camera latitude/longitude and heading/pitch/roll use degrees. Altitude uses
meters above the WGS84 ellipsoid. Import preserves finite heights below
100 meters and zero pitch, which previously fell through to defaults. Anchors and explicit moves require the `ellipsoid` altitude reference;
terrain-relative inputs are rejected. See the camera contract for exact semantics.
Flight durations retain the editor's minimum of 0.2 seconds and its 4-second
fallback for zero; holds may be zero.

Visual fields are `style`, `mapStack`, `styleParams`, `bloom`, `sharpen`, `hud`, and
`detection`, and `scope`. Bloom has `enabled`, `intensity`, `version`; sharpen has `enabled`,
`intensity`; HUD has `visible`, `variant`; detection has `mode`, `density`,
`allocation`, `fadePct` and `outsideOpacityPct`. Scope has `enabled`, `featherPct`.
The latter settings were written by Update Shot but previously lost during
normalization; they now survive import and capture.
Version-1/2 bloom without an explicit scale version uses the original inverted
scale and migrates once to scale 2. The scene document and bloom scale versions
are separate. Legacy numeric strings are accepted for numeric fields.

Layer entries accept a boolean shorthand or `{ "enabled": true, "params": {} }`.
Parameters and style parameters retain nested JSON data. They are interpreted by
already registered components; importing a file does not fetch its URLs, register
modules, evaluate code or apply its layers. Unsupported structural fields are
rejected instead of silently dropping potential edits. Map-stack selection
retains the existing registered-stack behavior.

## Validation limits

`gods-eye-view/director` exports `parseSceneDocument(text)`,
`validateSceneDocument(project)`, `stringifySceneDocument(project)`,
`SceneDocumentError`, `SCENE_DOCUMENT_VERSION` and `SCENE_DOCUMENT_LIMITS`.
Validation is independent of the renderer, storage and recipes. Parsing checks
UTF-8 size before JSON decoding; the file importer also checks file size before
reading it. Migration/defaults live separately in `src/scenes/project.js`.

Limits are 5 MiB, 256 scenes, 10,000 total shots, 10,000 entries per collection,
24 levels of nesting, 200,000 visited values, 65,536 characters per JSON string,
256 characters per field/ID, and 4,096 characters per title. Numeric values must
be finite. Camera limits are latitude ±90, longitude ±180, altitude −12,000 to
1 billion meters, heading/roll ±360 and pitch ±90; durations/holds are at most
86,400 seconds. Post-processing values are bounded and normalized to the existing
slider ranges. Object prototype keys are refused at every depth.

An invalid import leaves the current project and playback untouched. A valid
import cancels and settles pending playback before replacing the project. If
multiple files are read concurrently, only the newest request can replace it.
Disposal prevents a pending import from publishing.

The browser storage key remains `godsEyeView.sceneProject.v2` for compatibility;
that key's suffix is not the document version. An unreadable saved project stays
in storage. The app supplies temporary defaults and a visible warning, but blocks
saving over the original bytes until a valid file is explicitly imported. Export
can preserve temporary edits. Storage writes use the same validation before replacing saved bytes; invalid
edits and storage write failures surface an unsaved toast.

Only authored project fields belong in this file. Runtime clocks, camera flights,
loading progress and run diagnostics remain separate. Camera anchors and authored
moves arrived in version 4; data packs follow in version 5. Declarative
interactions remain a planned extension. No scene assets, source links, licenses or contributor attribution
change with this document boundary.

Version 5 additionally accepts scene `dataPacks` and shot `dataPackIds`, as
defined in [data packs](DIRECTOR-DATA-PACKS.md). Version-4 camera documents
continue to import without adding any packs.
