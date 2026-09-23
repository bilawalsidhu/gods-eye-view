# Director authoring and file sharing

Open Scenes and select a scene and shot. Existing capture, update, playback and
whole-project export controls remain available. Authored scene content, source
links, assets and contributor credit are preserved.

## Review imports before applying

IMPORT accepts scene JSON (including older supported versions) or a
`.gevbundle.json` asset bundle. A preview lists scenes, shots, data-pack attribution,
configured or unavailable sources, missing layer IDs and bundled bytes. Preview
makes no asset requests and does not change the current project. Configured
sources do not guarantee that a file exists: ordinary assets are checked on LOAD.
Bundle preview verifies the manifest and byte integrity; format decoding and
geometry limits are still enforced when rendering.

Apply replaces the current project after validation and playback cleanup. Export
your current project first if you want to keep both. Cancel or Escape discards
the staged import. A changed project invalidates an open draft rather than being
overwritten. Invalid files leave the existing project and browser save intact.
The programmatic `importProjectFile(file)` API still applies trusted callers'
imports directly; the installed file chooser supplies the review step.

## Edit scene details

EDIT DETAILS provides validated JSON fields for:

- Scene anchors and data-pack manifests.
- The selected shot's camera, optional move, duration, hold, pack IDs and actions.

Capture camera as anchor adds a named geographic position to the draft. Set move
start to current camera creates a pose-to-pose move ending at the shot's existing
camera; Use ordinary flight removes that explicit move. Heights are meters above
the WGS84 ellipsoid. Apply details validates the complete project, preserves IDs,
layer declarations and content notices, and keeps the selected shot. Cancel
leaves the project unchanged. See [camera directions](DIRECTOR-CAMERA.md),
[data packs](DIRECTOR-DATA-PACKS.md) and [actions](DIRECTOR-INTERACTIONS.md) for
field definitions. This is a basic draft editor, not a node graph or path editor.

## Share a selected scene

SHARE SCENE exports only the selected scene. Download scene JSON preserves its
camera, timing, layers, anchors, manifests, interactions and attribution, but
contains no asset bytes. The recipient needs the referenced source registrations
and files. Existing EXPORT PRESETS continues to export the entire project.

For a bundle, select the declared pack files or a folder, then Download asset
bundle. Folder paths match a manifest path either directly or after removing the
chosen root directory. Individual filenames must be unambiguous across all pack
sources; ambiguous or missing matches fail without downloading a partial bundle.
Previously imported bundle files can be reused. Export never automatically fetches
remote files or copies registered recipe media. Existing integrity declarations
must match the files you supply.

Bundles include only declared data-pack files. Registered scene content, linked
media, map tiles and live data are not included. Source notices and licenses remain
in the document; packaging a file does not grant permission to redistribute it.

## Bundle format and limits

A bundle is uncompressed JSON with these fields:

```json
{
  "format": "gev-scene-bundle",
  "version": 1,
  "project": { "version": 6, "scenes": [] },
  "assets": []
}
```

Each asset contains `path`, `mimeType`, `base64` and lowercase hexadecimal `sha256`.
Export copies the document and rewrites pack references to the reserved
`scene-bundle` source, adding exact `byteLength` and `sha256`. Paths are confined
relative names; URLs, traversal, duplicate or unreferenced assets, unknown fields,
missing packs and mismatched hashes are rejected. Scene documents remain bounded
at 5 MiB. A bundle allows 50 MiB of JSON, 64 files, 8 MiB per file and 32 MiB of
asset bytes in total. Supported MIME types are JSON/GeoJSON, PNG, MP4/WebM video
and MPEG/Ogg/WAV/WebM audio. Normal pack format and geometry checks still apply.
There are no executable modules, request headers or credentials in the format.

Imported bytes stay in memory for the current project and session. Stop releases
rendered resources while retaining these bytes for replay. Project replacement
or application teardown releases them. Only scene JSON is saved in browser
storage: **reimport the bundle after reloading the app**. Missing bundle bytes
fail explicitly, with no network fallback. This is file sharing, not a storage
service or an offline basemap.

Portable helpers are exported through `gods-eye-view/director`: `parseSceneShare`,
`readSceneShare`, `createSceneBundle`, `createBundleAssets`, `describeSceneShare`,
`editSceneDetails` and `selectSceneDocument`. Loading and UI remain separate owners.
`getSharingState()` reports copied dialog/asset counts for lifecycle diagnostics.

Run `node scripts/qa-director-sharing.mjs` against the local server for installed
controls, cancellation, stale drafts, export/import round trips, resource cleanup
and narrow-screen acceptance. Fixtures are synthetic and carry their own notices.
