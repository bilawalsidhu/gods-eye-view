# Director scene actions

Version-6 scene documents can attach actions to stable GeoJSON feature IDs in a
shot's selected data packs. Existing versions 1–5 migrate without adding actions.
Import validates data and references; it does not load assets or execute actions.

Add `interactions` to a shot, for example:

```json
{
  "id": "read-outline",
  "label": "About this outline",
  "target": { "packId": "outline", "featureId": "boundary" },
  "action": {
    "type": "card",
    "text": "An authored explanation, displayed as plain text.",
    "url": "https://example.org/source"
  }
}
```

The target must be a feature in a GeoJSON pack selected by that shot. Points,
lines and polygons retain stable pack/feature identities. Assets load before
feature existence is checked; a missing feature refuses the entire action set.
Images and native media are not interaction targets in this version.

| Action  | Fields                       | Behavior                                                                          |
| ------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `card`  | `text`, optional `url`       | Show plain text and an optional HTTPS source link; never HTML                     |
| `focus` | `anchorId`                   | Set a top-down camera pose at a scene anchor through camera ownership arbitration |
| `shot`  | `shotId`                     | Load another shot in the same scene at its authored start                         |
| `layer` | `layerId`, boolean `enabled` | Request an explicit state through the ordinary layer admission path               |

There are at most 64 interactions per shot. Card text is limited to 4,096
characters; source links cannot contain credentials, query strings or fragments.
No script, module, arbitrary fetch endpoint or request header is accepted.

Actions appear after LOAD or seek finishes. Click a pack feature to select its
actions and focus the first button; choose a button explicitly to execute it.
Tab traverses buttons and Enter/Space activates them. The selected buttons have
visible outlines, and status feedback is announced to assistive technology.
There are no global keyboard shortcuts to collide with navigation or typing.
Drawing ownership blocks both pointer selection and action execution. Camera
focus uses existing navigation admission, including Cockpit restrictions.

Actions are inactive during automatic playback and camera travel. They do not
introduce automatic branching or loops. A chain of user-triggered shot changes
is limited to 64 transitions; an explicit LOAD starts a new chain. Import/Stop,
replacement, playback and teardown remove selection, cards and picking handlers,
and abort pending layer requests. No per-frame interaction loop runs.

A layer action must name a layer with an explicit baseline in the current shot.
A target shot must declare a baseline for every layer the departing shot can
change. LOAD and seek reapply those baselines and clear selection. Stop cancels
pending transitions; already completed layer changes remain visible, consistent
with ordinary scene controls. Camera focus is an immediate anchor pose, not a
new timeline segment; seek restores the authored camera pose. Scene JSON is not
modified by executing an action.

The portable interaction session owns action admission/cancellation. The scene
interaction owner supplies accessible DOM and picking; pack renderers own the
feature identities and release them with their geometry. Layer/source admission
and camera arbitration remain with their existing owners.

Author actions in scene JSON or the validated EDIT DETAILS draft.
[Import preview and file sharing](DIRECTOR-SHARING.md) preserve those declarations. Existing content, assets, notices and contributor credit are preserved.
