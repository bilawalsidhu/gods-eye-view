# WebXR Starter Template

A brand-neutral Vite + Three.js + WebXR + cannon-es starting point extracted from the interaction foundation of the Electrical Demos project. It has no customer logo, lessons, SCORM packaging, or project-specific UI. Its `brand.json` and `src/brand.css` provide neutral defaults; new projects may opt into a pack from `../brands/`.

## Included

- Desktop scene fallback: mouse look and WASD movement
- WebXR entry preferring immersive-AR, falling back to immersive-VR, then desktop
- Official controller and hand models, vendored for offline headset loading
- Physics-backed grab and throw objects
- Teleport arc and valid-floor check
- Real-surface placement in MR through the optional `hit-test` feature
- A self-reporting MR/VR test bench scene

## The test bench

The starter scene is built to be put on a headset and prove the basics work. It reports on itself
through a panel rendered *inside the scene* -- visible in the headset, not just in the DOM -- and
mirrored in the page's bench panel:

| Row | What it tells you |
| --- | --- |
| Session | `immersive-ar`, `immersive-vr`, or desktop |
| Reference space | `local-floor`, or `local` with a 1.6 m estimate when floor tracking was refused |
| Hit test | ready, unsupported, or not requested |
| Inputs | each connected source: handedness, tracked-pointer / hand / transient-pointer / gaze, gamepad, haptics |
| Hands | live pinch distance in millimetres and pinch state |
| Frame | rolling frame rate and frame time |

Below it is a checklist that confirms itself as you perform each action, so you can tell at a glance
what has actually been proven on this device and what has not:

desktop fallback · controller select · controller grab · throw · teleport · teleport correctly
blocked · snap turn · hand pinch grab · hand pinch select · haptics · MR surface placement

Three pads sit on the pedestal: a green probe pad (plain select), an amber pad that fires a haptic
pulse and reports when an input has no actuator, and the red reset pad. The panel redraws at 4 Hz
rather than per frame -- rasterising a 1024px canvas every frame would distort the very frame timing
it reports.

A deployed, ProtoGen-branded build of this scene lives at
**https://protogen-webxr.pages.dev/demo/** (`projects/WebXR Demo/`), because a headset needs HTTPS.

## Run

This folder can be opened directly in Codex or Claude Code. Its local `AGENTS.md`, `CLAUDE.md`, `.codex/`, and `.mcp.json` carry guidance and Blender MCP setup even if the template is copied outside the parent repository. Install the Blender MCP runtime and enable its Blender add-on separately if you need Blender tools.

```sh
npm install
npm run sync:xr-profiles
npm run dev
```

For an actual headset, serve over HTTPS (for example, a deployed preview); browsers generally do not enable immersive VR from a LAN HTTP origin.

## Where to extend

- `src/scene.js`: replace the demonstration room and register your own grabbables, targets, and collision blockers.
- `src/xr-toolkit.js`: controller/hand models, trigger actions, grabbing, and teleport input.
- `src/controller-hand.js` and `src/hand-pose.js`: the controller-driven hand mesh and its finger mapping.
- `src/settings.js` and `src/panels/bench.js`: persisted settings and the shared in-scene information panels.
- `src/locomotion.js`: testable teleport path and standing-space rules.
- `src/grab.js`: release velocity behaviour.
- `src/diagnostics.js`: the checklist, the readout rows, and the in-world panel.
- `src/mr-placement.js`: hit-test reticle and real-surface marker placement.

`XRToolkit` accepts an optional `onEvent(name, detail)` observer alongside `onToast`. It fires for
`select`, `grab`, `release`, `teleport`, `teleport-rejected`, `snapturn`, `step` and `step-rejected`, and defaults to a
no-op, so an application can react to interaction outcomes without reaching into toolkit internals.
`applyBrand()` takes its page-title suffix from `<html data-app-title="...">`.

Every target is a Three.js object in `targets` with `object.userData.action = () => { ... }`. Every grabbable requires a Three.js `object`, cannon-es `body`, and initial transform.

## Build

```sh
npm run build
npm run preview
```

## Check the deployment

```sh
npm run check:deploy
```

Reads `wrangler.toml` for the Cloudflare Pages project, then reports three signals that fail
independently: whether every entry page the build produced returns 200 at the URL Pages actually
serves (it redirects `/page.html` to `/page`), whether the content-hashed asset references served
match this build's, and which commit Cloudflare has deployed. A local build older than its own
sources is flagged, because the asset comparison would otherwise pass against stale output.

This template has no `wrangler.toml` and reports "not deployed", which is correct -- it publishes
nowhere by design, and `projects/WebXR Demo/` is the deployed build of this scene. The script never
deploys; it prints the command. It is copied into every project so it keeps working in a project
opened on its own or spun out.

## Tracked hands

On compatible headsets, enable hand tracking and put down controllers. Reach near a block, pinch thumb and index finger to hold it, and open to release. Aim and pinch to select buttons. Controller locomotion remains available. Lost tracking releases objects without a throw.

**Thumb microgestures (VR).** On Quest Browser 38.1+ a tracked hand reports Meta's microgestures as buttons on an `oculus-hand` input source, and `src/microgestures.js` turns them into locomotion the way Meta's own design does. Rest the hand with the palm sideways and tap the thumb on the side of the index finger to start moving; an arc appears along the hand's aim. Tap again to teleport, swipe the thumb left or right to snap turn 30 degrees, swipe forward or back to take a 0.35 m step. Rolling the wrist about 45 degrees, pointing the index finger, 8 seconds of quiet, or picking something up ends it, and nothing happens in mixed reality. **Settings → Thumb microgestures** turns it off, which (like a browser without the profile) leaves the joint-read finger gun and fist in `src/hand-gestures.js`. `XRToolkit` emits `step` and `step-rejected` events beside `teleport` and `snapturn`. Thresholds are in `MICROGESTURE_TUNE` and have not been tuned on a headset.

`src/xr-hands.js` supplies self-hosted left/right hand models and translucent soft-white toon shading with a subtle gray edge and faded wrist. This is a Meta-inspired WebXR visual, not the native Meta SDK. Run `npm run sync:xr-profiles` to refresh local assets. Verify alignment, occlusion, tracking recovery and pinch comfort on device.

## Controller hands

Holding controllers, the scene shows the runtime's controller model by default. **Settings → Controller
hands: on** swaps it for an animated hand in the UE 5 VR-template style: the same `generic-hand` GLB
the tracked hands use, parented to the grip and posed from the gamepad every frame. The trigger
drives the index finger (resting on it: slightly hooked; off it: a point), the grip drives the other
three, and the thumb drops onto the stick or a face button when a capacitive touch says it is there
(nothing under it: thumbs-up; full grip with the thumb down: a fist). Values are smoothed, never
snapped. The setting is in the in-scene board beside the pedestal and in the bench panel, persists
in this browser under `webxr-template:settings`, and swaps connected inputs immediately. Tracked
hands and transient/gaze pointers are unaffected: they show neither visual.

- `src/hand-pose.js`: the posing core and the pure trigger/grip/thumb mapping. The Hand Lab
  (`materials/lab`) imports this same file, so what it previews is what a headset shows.
- `src/controller-hand.js`: the grip-attached visual. `GRIP_TUNE` holds the per-hand fit (tilt,
  roll, yaw, offset); everything else is derived from the skeleton. Tune it in MR passthrough with
  the setting on -- the real hand shows through the virtual one -- adjusting tilt, then offset, then
  roll until palm and knuckles overlay with the trigger half pulled. Shipped values are for Quest
  Touch controllers.
- `createControllerHandMaterial()` in `src/xr-hands.js` is the controller hand's own material
  slot; `materials/hands/manifest.json` `controller` names its source spec.
- Capacitive touch is what makes the thumb and index rest realistically. Runtimes that do not
  report it still curl on a pull or a stick deflection, but thumbs-up fidelity is device-dependent.

## Settings

`src/settings.js` defines each setting once (values, default, label) and persists the store;
`src/panels/bench.js` binds the store to the shared panel manager and its release-to-activate
input. The older `settings-panel.js` export remains for compatibility but is not used by the
starter. Adding a setting is one entry in `SETTINGS`, a subscriber in `main.js`, and a
mirrored button in the bench if it should be reachable before entering the headset.

## Reusable interaction hooks

The template preserves its soft-white tracked hands, wrist fade, reconnect protection, spatial-pointer input, and local hand/controller assets. Joint tracking loss releases a held object without throwing it.

Controller thumbstick forward aims teleport; releasing commits a valid destination. Sideways performs a 30-degree snap turn, requiring a return to center before another turn. Both movements account for the headset position within the play space.

Optional `XRToolkit` constructor settings:

- `canTeleport(point)`: replace the default demo floor/bounds validation.
- `onTeleport()`: notify the application after movement.
- `handTeleport: true`: allow an empty-space hand pinch to teleport along the floor arc. Disabled by default to avoid accidental movement in tabletop/MR applications. Nearby grabs and button actions take priority; transient spatial pointers retain their existing select/grab behavior.

A grabbable can supply `onDrop(throwObject)`. It runs after release; `false` indicates tracking loss, disconnect, or session cleanup, so applications can distinguish cancellation from an intentional placement.

`controllerVisual: 'controller' | 'hand'` sets the initial controller visual; `setControllerVisual(mode)` changes it at runtime.

Hardware verification remains required for hand alignment, controller-hand grip alignment, tracking recovery, teleport comfort, and controller/hand switching. The automated tests and production build do not replace headset testing.

## Session exit and the system menu

`src/xr-lifecycle.js` owns what happens when the headset's system menu opens over a session and
when the page goes away under one. `watchSession(session,{onVisibility})` reports
`visible` / `visible-blurred` / `hidden`, ends the session on `pagehide` and `freeze` so a closed
tab or browser never leaves the compositor holding it, and gives the page one `end()` that is safe
to call twice or after Quit. While the session is not `visible`, the frame budget takes no samples,
so an automatic render-quality step-down (which recompiles materials) cannot land while the
browser needs the main thread for its Resume/Quit banner; sampling restarts when focus returns.
The framebuffer probe in `attachXR` is built without MSAA, depth or stencil, so measuring the eye
buffer no longer holds a second full-size buffer. Every project that enters a session uses it;
the tabletop solar scenes also pause playback while the menu is up.

## Controller pose and MR behavior

Controller hands retain a relaxed finger wrap at zero squeeze. Trigger controls the index;
thumb contact (including touchpads) controls thumb opposition independently of grip pressure.
Alignment uses the bind-pose wrist-to-knuckle palm centre, correcting the previous roughly
3 cm forward bias. Physical controller fit still needs validation on both hands in a headset.

MR disables teleportation and snap turning and clears pending destinations. VR retains both.
The bench has labeled select/reset/haptic pads, a block tray, a correctly oriented physics floor,
and reset clears both sides of an active grab. Surface placement ignores selections on UI or held objects.

These shared fixes are maintained in the template and WebXR Demo. Nuclear and the electrical
workshop use VR-only locomotion and do not use controller hand visuals; the electrical solar MR
scene already has no teleportation, so those integrations need no changes. Hand Lab imports the
template poser and receives its thumb improvement automatically. Saved hand materials are unchanged.

## Information panels

The shared information-panel framework supports Anchored, Following and Grab & place,
using the active brand pack. Panels size themselves to their content; there are no learner
resizing controls. See [PANELS.md](PANELS.md) for the authoring API, collision contract,
input mappings, accessibility, optional MR room geometry, and headset acceptance checklist.
Open **Information panels** in the bench, or use the in-world Settings launcher.
