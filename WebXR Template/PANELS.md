# Information panels

The template and WebXR Demo share `src/panels/`. The template uses the neutral brand;
the demo uses its existing ProtoGen pack. Panel content does not contain brand colors,
font names, customer logos, or training logic.

## Try it

Open **Information panels** in the desktop test bench. Show a panel, choose Anchored,
Following, or Grab & place, and optionally switch between glass and solid surfaces.
**Focus panel view** hides the desktop overlays; **Show test bench** restores them.
In a headset, the Settings panel opens the guide and workspace. Each panel's Options
button exposes placement mode, appearance, and recentering.

- Trigger selects a button on release. Grip grabs the white bar, nearby or by ray.
- Hand pinch selects, or grabs the targeted white bar. A transient pointer also works.
- Held controller thumbstick vertical changes distance. A hand ray uses hand translation
  along the acquisition direction. Maximum distance acquisition is 3 metres.
- Desktop: click controls; drag the white bar; wheel while dragging changes depth.
  This captures the pointer instead of rotating the camera.
- Recenter: desktop **R**, the bench button, the Settings action, a controller's primary
  face button where exposed, or a one-second pinch in empty space with no object held.
- All content actions also have keyboard-operable DOM equivalents in the bench.

There are **no learner size presets, resize handles, or two-hand scaling gestures**.
Sizing follows the content. This intentionally incorporates the later sizing correction
to the original design plan; there is no `setTextSize` API.

## Author a panel

```js
import {PanelManager} from './src/panels/manager.js';
const panels = new PanelManager({scene, renderer, brand, logo: brandLogo, onStatus: say});
const panel = panels.createPanel({
  id: 'instructions', mode: 'movable',
  content: {
    taskId: 'inspection', eyebrow: 'ACTIVITY', title: 'Inspect the object',
    description: 'Check the markings before continuing.',
    blocks: [
      {type: 'reading', label: 'Reading', text: '480 V'},
      {type: 'checklist', column: 1, label: 'Checks', items: [
        {label: 'Markings visible', checked: true},
        {label: 'Condition inspected', checked: false},
      ]},
    ],
    actions: [{id: 'continue', label: 'Continue', primary: true, enabled: false}],
    footer: 'Activity-specific contextual note.', closable: true,
  },
  onAction(id) { /* application validates and updates its own state */ },
  onState(state) { /* following, held, placed, blocked, recovering */ },
});
panel.setContent(nextContent);
panel.setMode('following');
panel.setAppearance('solid');
panel.hide(); panel.show(); panel.recenter();
panel.setPose({position: [0, 1.5, -1.25], quaternion: [0, 0, 0, 1]});
// On teardown:
panel.dispose();
```

Supply `pose` for authored anchored placement. It is validated against registered solids;
invalid authored panels remain hidden and report a diagnostic. Without a pose, initial
placement searches for a clear location in front of the current viewer. All anchors are
session-local; no cross-session spatial anchoring or room-data persistence is implemented.

Supported blocks: paragraph/instruction/reading (`text`, optional `label`), list/checklist
(`items`), keyValue (`rows: [{label,value}]`), progress (`value`, `max`, `text`), image
(`src`, `alt`, optional logical `height`). `column: 1` requests a second column. Images
use their intrinsic aspect ratio; supply a local asset URL and meaningful alt text.
Selection rows and segmented choices use actions with `selected`; disabled actions use
`enabled: false`. Actions require unique non-reserved IDs. The `@` and `panel:` prefixes
belong to the framework. Keep header/footer prose brief; move long text into body blocks.
An impossibly large persistent heading/footer produces a diagnostic rather than illegible text.

## Labels

A panel is at least about 20x21 cm, because body text must subtend 0.65 degrees at the
distance it is read from and the width floor is 240 layout units. Annotations on an object
are smaller than that, so they use a second variant:

```js
const tag = panels.createPanel({
  id: 'readout', variant: 'label', parent: table,   // rides the parent's transform and scale
  content: {text: '12:00 · 0.32 kW', align: 'center'},
  layout: {distance: .45},                          // how far away it is actually read from
  pose: {position: [0, .16, .91], quaternion: [0, 0, 0, 1]},
});
tag.setContent({text: nextReading, align: 'center'});
```

A label keeps the same angular legibility rule, applied at its own reading distance, and
keeps the brand shell, tint, rim and corner radius. It drops the options button, pagination
reserve, grab handle and the width floor. Content is `title`, `text`, `image` and `align`
only. Labels are excluded from collision, following, recovery and hit-testing: they never
obstruct a panel and never take input. `parent` is optional; without it the label is added to
the scene like any other panel. `distance` is also accepted by `layoutPanel` and defaults to
1.25 m, so ordinary panels are unaffected.

Labels are for short annotations. Anything a learner reads at length, or interacts with,
belongs in a real panel.

## Layout and rendering contract

Brand fonts load before measurement. Layout units, raster pixels, and world metres are
separate. Body and secondary glyph heights target at least 0.65° and 0.5° at 1.25 m.
The simple/wide limits are 36°/44°, with a 32° height limit. Smaller camera frusta reduce
layout capacity. Content uses 32-unit padding, 24-unit section gaps, 16-unit control gaps,
28-unit panel corners, and minimum 64-unit buttons. Dense panels use 55/45 columns,
with controls under the left column. Font size is never reduced to make content fit.

Overflow uses explicit pages. Primary actions stay available; extra actions have action
pages. A task ID change resets paging; reading changes preserve it. Dimensions are reserved
within a task, so short numeric updates do not make the panel breathe. Layout is frozen
during presses/grabs; queued content applies at most 10 times per second. Size changes
ease over 180 ms after checking the larger footprint. A blocked expansion paginates
within the existing footprint. Content updates do not change physical size while held.

The backplate uses a rounded canvas mask, brand tint and restrained rim, with opaque text
and more opaque reading surfaces. It is simulated glass, not passthrough blur/refraction.
Solid mode is available. Texture resolution is at most twice layout size and is capped by
4096 and `MAX_TEXTURE_SIZE`. Textures repaint only when content, layout, state or hover changes.
The white pill alone is visible; its larger invisible grab bounds do not overlap controls.

## Movement and collision

Following is world-space lazy follow, not head parenting. Default distance is 1.25 m,
centered 8° below forward view. Entry thresholds are 8°/6° for 200 ms; exit thresholds
are 3°/2°. Translation uses critically damped 0.25-second smoothing capped at 1 m/s.
Grabs use 0.06-second smoothing, preserve the acquisition offset, keep text upright,
and stop on release without gravity or throw velocity. Small head movements leave the
panel still. Following preserves angular size at 1–1.5 m; placed panels retain metre size.

Placement tries the center, closer readable depths, then offsets within ±10° horizontally
and ±6° vertically. A candidate must persist for 300 ms; returning from constrained
placement to the preferred distance waits one second. Side preference prevents oscillation.
When blocked, retain the last valid pose. If no central position physically fits, central
visibility cannot be guaranteed. Recenter retries; it never forces a panel through a wall.

Large turns (>60°), teleport/snap turns and blocked paths recover with a 120 ms fade-out,
hidden relocation to a revalidated destination, and 180 ms fade-in. No content action runs
during recovery. New geometry invalidating the current pose cancels ownership and initiates
recovery. Room tracking interruption pauses autonomous following and retains cached barriers.

Register collision geometry before updating the manager:

```js
const remove = panels.collision.registerBox('equipment', mesh);
panels.collision.registerTriangles('room-fragment', triangles); // world-space THREE.Triangle[]
// Per frame, after scene/input poses are current:
panels.prepare(viewCamera, xrFrame, referenceSpace);
// Update the PanelInput adapter / XRToolkit, then physics and scene transforms.
panels.collision.refresh(panels.panels);
panels.updateHover();
panels.update(dt);
panels.updateDomStatus();
// remove() unregisters the equipment later.
```

Box registrations follow object transforms and visibility, including parent visibility.
Use suitable box proxies for irregular virtual solids. The demo registers its floor,
walls, pedestal, tray, blocks and collision course; hidden virtual room geometry is excluded
in MR. The full panel and handle use 3 cm clearance. Conservative swept envelopes include
translation, rotation and scale, so endpoints alone cannot allow thin-wall tunneling.
Dragging tries axis slides when blocked. Full view-pyramid clipping detects occluders
between the head and panel. Hands/controllers are interaction inputs, not solid barriers.
Triangle sets have a spatial hierarchy; static transforms and room geometry are cached.

## Mixed reality

MR requests plane/mesh detection optionally. `RoomGeometry` consumes finite plane polygons
and mesh triangles, updates poses independently of geometry timestamps, and removes lost
entities. Detected surfaces also render into depth only (no color), occluding panels behind
known physical walls without painting over passthrough. Its status distinguishes unavailable, waiting for room data, active, and tracking
interrupted. A user-triggered Scan room button appears only if the runtime exposes capture.
Session end clears room geometry; reference-space reset clears and reacquires it.

Runtime support and scanning coverage vary. Collision is against supplied geometry, not
unknown people/furniture/walls. No claim of complete physical-room coverage is made. Virtual
collision continues when room geometry is unavailable. No room information is persisted.

## Verification and synchronization

Run `npm test` and `npm run build` in each affected workspace. `tests/panels.test.js` covers
measurement, overflow, press ownership, following, continuous collision, occlusion, and MR
geometry lifecycle without requiring WebGL. `?panel=guide&preview=1` and
`?panel=movable&preview=1` provide repeatable browser review views.

The shared panel modules and tests are mirrored byte-for-byte in WebXR Demo, Nuclear and
Electrical Demos. There is no sync script; re-copy `src/panels/*.js` and `tests/panels.test.js`
to all three after any change here, and diff to confirm.

Nuclear still uses its specialized survey-map panel and menu handling. Electrical Demos'
Rooftop Solar activity now uses this framework for its mission panel, its Table & controls
panel and its tabletop labels; its own poke input, occluders, training actions and the
battery/BESS laboratory rebind lifecycle were kept and mapped onto the framework rather than
replaced. The battery/BESS lab still has its own `board.js` placement system.
BESS sample content and obstacle courses remain demo-only.

Hardware acceptance is still required: controller/hand transitions, direct and distance
grabbing, head clearance, central following comfort, narrow passage/corner/overhead behavior,
room capture, loss/reset recovery, legibility in both eyes, and frame-rate comparison against
the unchanged scene. Record device/browser versions. Browser tests do not establish these.

### Surface refinement

The shared view uses a shallow beveled shell, a restrained light-catching rim, inset reading surfaces, and raised control gradients. Each dense column sizes its own reading surface; actions have a separate 24-unit section gap. Instrument readings receive stronger type hierarchy. Press feedback begins on acquisition and clears on cancellation; actions still commit only on valid release. Brand fonts and colors remain authoritative. This follows the material hierarchy and immediate-feedback guidance in [Apple Design](https://github.com/emilkowalski/skills/blob/main/skills/apple-design/SKILL.md). Nuclear and Electrical retain their legacy panel renderers and are unaffected.
