# Director camera directions

Version 4 scene documents can name geographic anchors and describe an explicit
camera move followed by a hold. Existing camera-pose shots still use the ordinary
camera flight. Import, playback, Load, Replay and seek accept the new directions;
[EDIT DETAILS](DIRECTOR-SHARING.md) captures anchors and move starts; a graphical
path editor remains a later extension.

```json
{
  "version": 4,
  "scenes": [{
    "id": "austin",
    "title": "Across Austin",
    "anchors": [
      { "id": "west", "title": "West viewpoint", "lat": 30.2672,
        "lon": -97.76, "alt": 6000, "altitudeReference": "ellipsoid" },
      { "id": "east", "title": "East viewpoint", "lat": 30.2672,
        "lon": -97.73, "alt": 7000, "altitudeReference": "ellipsoid" }
    ],
    "shots": [{
      "id": "crossing",
      "title": "Cross the city",
      "durationSec": 4,
      "holdSec": 2,
      "camera": { "anchorId": "east", "heading": 10, "pitch": -45, "roll": 0 },
      "move": {
        "from": { "anchorId": "west", "heading": 350, "pitch": -45, "roll": 0 },
        "easing": "cubic-in-out"
      },
      "visual": { "style": "normal" },
      "layers": {}
    }]
  }]
}
```

## One owner for each authored value

An anchor is a scene-local geographic position, with a stable `id`, optional
`title`, latitude, longitude, height and explicit altitude reference. Each scene
accepts at most 1,024 anchors. IDs must be unique within that scene. References to
missing anchors fail validation before replacing a project.

The shot's `camera` is its destination. It can be an inline pose or an
`anchorId` plus orientation. The optional `move.from` uses the same pose/reference
shape. References cannot also carry inline coordinates. They do not form chains.
Heading, pitch and roll belong to each camera pose, so two shots can look in
different directions from the same geographic anchor. Omitted orientation uses
heading 0, pitch −35 and roll 0 degrees.

An explicit move requires `move.from`, `move.easing`, `durationSec` and `holdSec`.
Its duration is 0.2–86,400 seconds; the hold is 0–86,400 seconds. The destination
is not copied into another field. `linear` and `cubic-in-out` are the supported
easings. A shot without `move` retains the existing ordinary flight, even in a
version-4 file. Its destination may also reference an anchor.

Capture continues to create ordinary camera-pose shots. Update Shot stores the
current viewport as an inline destination, preserving an explicit move's start
and easing; it does not change a shared anchor and thereby move other shots.
Editing imported directions and anchors currently means editing the scene JSON.

## Coordinates and altitude

Latitude/longitude use WGS84 degrees. Orientation uses the application's Cesium
heading/pitch/roll convention in degrees: heading rotates from local north,
negative pitch looks down, and zero pitch is horizontal. Camera positions use
meters above the WGS84 ellipsoid, matching `Cartesian3.fromDegrees` and captured
camera poses. These heights are not mean-sea-level elevations or heights above
the visible surface.

Every anchor and every inline endpoint of an explicit move must say
`"altitudeReference": "ellipsoid"`. Ordinary legacy poses without that field
already use the same reference. Terrain-relative and mean-sea-level references
are rejected; no terrain request, default ground estimate or implicit conversion
is made. Authors must provide ellipsoidal heights with enough clearance for their
scene. The format does not promise collision avoidance or terrain following.

During an explicit move, latitude and altitude interpolate between endpoints.
Longitude takes the shortest signed arc across the dateline; heading and roll
also take their shortest signed arcs. An exact 180-degree tie takes the negative
arc. This is an authored coordinate interpolation, not a geodesic or a camera
flight with an automatically raised arc. Endpoints are exact, including zero
pitch. Curved paths and look-at targets are later extensions.

## Time, seeking and cancellation

Load and Replay of an explicit move start at its authored `from` pose, regardless
of the current viewport. Play uses that same start. Both live playback and seek
use `sampleCameraMove`; a seek into the hold uses the exact destination. Backward
seeks do not depend on a prior camera position. Existing scene-pack media/reveal
rules can extend holds as before.

Each active explicit move owns one animation-frame callback. Stop, replacement,
import, teardown, a navigation handoff or manual pointer/wheel input revokes that
callback and settles the move. Navigation also cancels a run during an authored
hold, so the next shot cannot retake the camera. Camera claims still respect
Cockpit's refusal. Already queued callbacks cannot move a replacement scene.
The timing diagnostic includes the active authored camera animation.

The renderer-independent `gods-eye-view/director` export provides
`resolveCameraPose(scene, camera)`, `resolveCameraMove(scene, shot)` and
`sampleCameraMove(move, progress)`. These expect validated/normalized data.
Rendering and frame ownership live in `src/scenes/cameraMotion.js`; the existing
scene controller supplies camera application and lifecycle cancellation.

Version-1/2/3 projects migrate to version 4 without converting their ordinary
shots into explicit moves. IDs, positions, durations, visual settings, packs and
source attribution survive. The bloom scale remains independent of the document
version; version-3 bloom is never interpreted as the older inverted scale.
