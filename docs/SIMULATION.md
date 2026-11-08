# Simulation: authored aircraft scenarios

The Simulation layer (`simulation`, Movement group) flies aircraft along
hand-written waypoints over the live globe: 3D models from the shared hangar,
a glowing trail behind each aircraft, a faint dashed route ahead, and a clock
with play, pause, speed and seek. Nothing is fetched from the network except
the scenario file itself, served from `public/scenarios/`.

## Running the bundled scenario

1. Start the app (`npm run dev`), add a Google Maps key or Cesium ion token in
   **POWER UP** for photorealistic 3D (optional), and open the **Data Layers**
   panel.
2. Turn on **Simulation** under Movement. It loads `fleet-week-sf`: two fast
   jets on a Bay circuit, an L-39 waterfront pass, a 777 approach into SFO and
   a police helicopter over Crissy Field.
3. The row shows a time slider, a Pause / 0.5× / 1× / 2× / 4× switch and the
   aircraft list. Click an aircraft to fly the camera to it.

Share links keep the layer on (token `01`); the clock always restarts at zero.

## Scenario file

`public/scenarios/<id>.json`, where `<id>` is lowercase letters, digits and
dashes. Select it with the layer param `scenario` (for now from the console
or a share link that already carries it; a picker is a later extension).

```json
{
  "version": 1,
  "id": "my-airshow",
  "title": "My airshow",
  "aircraft": [
    {
      "id": "lead",
      "callsign": "LEAD1",
      "typeCode": "F18",
      "category": "A6",
      "color": "#ffd166",
      "loop": true,
      "waypoints": [
        { "lat": 37.8405, "lon": -122.53, "altFt": 1800, "speedKt": 380 },
        { "lat": 37.8215, "lon": -122.48, "altFt": 900, "speedKt": 400 }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `id`, `title` | File id and the title shown in the row. |
| `aircraft[].id` | Stable id, unique in the file. |
| `aircraft[].callsign` | Label text, up to 12 characters (defaults to the id). |
| `aircraft[].typeCode` | ICAO type code (`B77W`, `F18`, `L39`, `EC35`, …). Picks the 3D model class through `classifyAircraft`. |
| `aircraft[].category` | ADS-B emitter category (`A1`–`A7`, `B1`) used when the type code is unknown. |
| `aircraft[].color` | `#rrggbb` tint for the model, trail and route. |
| `aircraft[].loop` | `true` flies the waypoints as a circuit forever; `false` flies them once and holds the last position. |
| `waypoints[]` | At least two. `lat`/`lon` in degrees; altitude as `altFt` or `altM` above mean sea level; speed as `speedKt` or `speedMps`. |

Limits: 64 aircraft, 512 waypoints each, speeds 5–1200 m/s, altitudes
−500 to 30 000 m. A file that breaks a rule is refused whole and the row says
why.

## Virtual cameras

The **Virtual Cameras** layer (Movement group, next to Simulation) lists the
cameras a scenario declares plus any you place during the session. Picking one
claims the view and aims it at the camera's target every frame; a drag or
scroll on the globe, Cockpit, or picking **Free** hands the view back. Three
types:

| Type | What it does | Fields (defaults) |
| --- | --- | --- |
| `ground` | A tripod at a fixed place that turns to follow the target and zooms so the target keeps a share of the frame. | `lat`, `lon`, `heightM` (2, above the ground; `altitudeReference: "ellipsoid"` for an absolute height), `frameFraction` (0.22), `fovDeg` (auto), `smoothingS` (0.25) |
| `chase` | Rides behind the target. | `distanceM` (250), `heightOffsetM` (60), `lateralM` (0, right of track), `fovDeg` (50), `smoothingS` (0.6) |
| `orbit` | Circles the target with the scenario clock. | `radiusM` (400), `heightOffsetM` (120), `periodS` (40), `phaseDeg` (0), `fovDeg` (45), `smoothingS` (0.4) |

```json
"cameras": [
  { "id": "crissy", "title": "Crissy Field", "type": "ground",
    "target": "lead", "lat": 37.8046, "lon": -122.466, "heightM": 2 },
  { "id": "chase", "title": "Lead chase", "type": "chase", "target": "lead" }
]
```

Every camera has an `id`, an optional `title` and an optional `target`
(an aircraft id; without one the camera follows the first aircraft). The row's
**Target** switch overrides the target for whichever camera is active, and
**Target size in frame** sets how tightly tripods zoom. **Place a tripod here**
adds a session camera at the current viewer position (absolute height) aimed
at the current target; session cameras are not written back to the file yet.

### Director

The **Director** entry in the camera list cuts between the cameras on its own.
Twice a second it scores every camera for the current target: tripods score
best between 300 m and 4 km with a clear line of sight (a ray from the tripod
to the aircraft that hits the 3D tiles or terrain first rules the shot out),
chase and orbit are steady fallbacks, and the current shot gets a small bonus
so equals do not flicker. A shot is held at least four seconds unless it is
ruled out. Every camera also aims a little ahead of a moving target (0.4 s of
its velocity by default; the layer param `leadS`), so the aircraft flies into
the frame instead of trailing out of it.

Tripod ground height comes from the app's cached ground floor (the 3D tiles or
terrain under the point); until that cell is warm the tripod stands on the
EGM96 sea-level datum instead and moves up once the floor resolves.

## Scenario Editor

The **Scenario Editor** layer (Movement group) builds or changes a scenario
without leaving the globe:

1. Turn it on. It adopts the loaded scenario (or starts an empty one).
2. Pick an aircraft in its list, or **New aircraft**. Set **New waypoint
   altitude**.
3. Switch **Editing** to **Add waypoints** and click the globe: each click
   appends a waypoint at that point, at the slider altitude and the previous
   waypoint's speed. As soon as an aircraft has two waypoints the Simulation
   layer flies the edited scenario live, keeping the clock where it was.
4. **Undo last waypoint**, **Clear path**, **Loop → fly once** and **Remove
   aircraft** act on the selected aircraft.
5. **Export scenario JSON** downloads the file, including any tripods placed
   from the Virtual Cameras row; drop it into `public/scenarios/` to make it a
   bundled scenario. **Import scenario JSON** loads one from disk.

While **Add waypoints** is on the editor holds the globe pointer (like Draw),
so clicks do not also select aircraft or cameras; the row says who holds the
pointer when another tool has it. Dragging existing waypoints is a later
extension; today a wrong click is one **Undo** away.

## How motion works

- A leg from one waypoint to the next takes its length divided by the mean of
  the two speeds, so timing follows from distance and speed. The clock length is
  the longest aircraft path; it wraps only when every aircraft loops.
- Between waypoints the aircraft follows a Catmull-Rom spline through the
  neighbouring waypoints, so turns are smooth. Heading and pitch come from the
  spline's tangent; the model banks nothing yet.
- Positions are sampled once per frame on `scene.preUpdate`, and every visual
  and `getTargets()` read that one sample, so a camera engine sees the same
  aircraft the viewer does.

## Programmatic surface

The layer object (in the application catalog under `simulation`) exposes, for
the camera engine and tooling:

- `getTargets()` — this frame's aircraft: id, callsign, `position`
  (Cartesian3), `headingDeg`, `pitchDeg`, `speedMps`, `altM`, `done`.
- `sampleAt(id, timeS)` — where an aircraft will be at any scenario time.
- `getClock()` — `{ timeS, playing, rate, durationS, loop }`.
- `setParams({ playing, rate, timeS, trailS, routes, scenario, focus })` —
  `timeS` seeks, `focus` flies the camera to an aircraft; both are actions,
  not stored state.

Models: a type code or category that maps to a class with a real GLB
(widebody, turboprop, business jet, light, helicopter, UAV) renders that model;
airliners and fast jets share the generic `airplane.glb` until a real asset is
added to `public/models/` and mapped in `src/data/aircraftClass.js`.
