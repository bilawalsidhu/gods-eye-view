# Director: reusable scene playback

Director is the scene playback system. The first extraction separates ordered
shot execution from the scene editor and application rendering. This document
also records the proposed next steps; the sharing format and interactions below
are a design plan, not features already available.

## Implemented boundary

`src/director/playback.js`, exported as `gods-eye-view/director`, provides:

- `buildPlaybackQueue(scenes, startSceneId, { single })`: ordered scenes/shots,
  retaining the existing round-robin behavior.
- `playSceneQueue(queue, { token, adapter, previousScene, releaseOnFinish })`:
  sequential execution, cancellation checks and scene release.

The runner imports no renderer, UI, storage, recipe or dataset. An adapter supplies
these phases, in order: `selectShot`, `applyVisual`, `applyLayers`, `travel`,
`settle`, `hold`, `completeShot`. Each receives `{ scene, shot, index, total,
token }`. It also supplies `releaseScene(scene, token?)` and optionally `complete()`.
Callbacks may return promises. Each playback invocation requires its own adapter
state and token; the caller owns camera arbitration and concurrent-run refusal.

The runner checks cancellation after each phase. Adapters must also pass the
abort signal or liveness predicate into pending work: a check between phases
cannot stop a camera flight or network request already in progress. Cleanup
between scenes and on preview exit runs without an aborted token. A refused
initial handoff starts no shot. Final cleanup runs on completion, Stop or failure;
`releaseOnFinish: false` retains the final scene for ordinary playback. Exceptions
propagate so the caller can restore its controls. Empty/already-cancelled queues
acquire no resources. This low-level API expects normalized scene objects;
untrusted file validation belongs at the import boundary.

`src/scenes/playbackAdapter.js` connects this runner to the existing
`SceneDirector`. The latter still owns editor state, saved-project import/export,
camera ownership, seeking, clocks and presentation. Pack-specific layer states,
media holds and map preferences retain their current implementation. This first
slice does not make the entire scene controller renderer-independent.

All authored scenes, assets, IDs, source links, attribution and existing JSON
projects are preserved. The Nepal sequence remains the contribution introduced
by @manjunath22466 in #590. Its clips use source links/embeds; comparison images
and river coordinates are bundled. See the
[event pack provenance](../public/events/bhote-koshi-2026/README.md).

## Next changes, in order

1. **Timeline and content separation.** Extract pure duration/seek calculations
   and a clock with an explicit lifetime. Move content-specific hold, layer and
   presentation rules behind registered scene-pack adapters. Keep existing
   recipes and content intact. Test direct load, forward/backward seek, replay,
   media timeout and Stop at every pending transition.
2. **Versioned scene document.** Build on the existing version-3 project export
   and its importer. Specify a schema and migrations before changing writes.
   Keep old imports and local-storage projects readable; reject unsupported
   versions without replacing the current project. Include stable scene, shot,
   anchor, pack and action IDs. Separate portable authored state from transient
   loading state and run diagnostics. Bound document size, collection lengths,
   numeric values and nesting; show errors at the affected field.
3. **Camera directions.** Define named geographic anchors and explicit
   move/hold segments: start and destination, duration, easing, heading, pitch,
   roll and stop duration. State coordinate units, altitude reference and
   terrain-relative behavior. Support the current camera-pose shots first;
   paths, look-at targets and pauses follow with deterministic seek behavior.
4. **Data packs and placement.** Define a pack manifest with format/version,
   source, attribution/license and optional integrity/size metadata. Distinguish
   where bytes live (relative files, a URL, or an eventual bundle) from where
   features appear (geographic bounds, anchors, transforms and elevation rules).
   Start with existing GeoJSON/image/media adapters. Resolve relative paths
   against an explicit document base; define CORS, caching, missing-asset and
   offline behavior. Fetch only through registered source adapters with bounded,
   cancellable loading. Scene files carry no credentials or executable modules.
5. **Declarative interactions.** Give pickable features stable IDs and connect
   clicks to a small action registry: show a text/source card, focus an anchor,
   seek a shot, or change an allowed layer state. Define selection feedback,
   keyboard equivalents and precedence with drawing/tracking controls. Validate
   target references and cancel pending actions on Stop, replacement or teardown.
   No JavaScript evaluation or arbitrary HTML in scene files. Branching must
   have explicit loop/transition limits and reproducible reset/seek semantics.
6. **Sharing and authoring.** Add validated preview/import/export, missing-pack
   diagnostics and an optional self-contained bundle. Preserve attribution with
   each pack; a share link does not change an asset's license. A future node graph
   could author this same document, but playback and the format will not require
   a graph editor.

Each step must preserve existing scene editing, keyboard playback, camera
arbitration, layer cleanup, media timing and provider fallback. Acceptance includes
portable runner tests, existing Director regressions and browser playback with
Stop/seek/replay, plus tracking and voice checks. Use reproducible local fixtures
for failures and cancellation, alongside live visual checks for actual content.
