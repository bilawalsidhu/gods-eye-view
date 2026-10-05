# WebXR headset compatibility

Both Rooftop Solar and WebXR Template use runtime capability detection, not headset-name checks.

- Prefer immersive-ar; use immersive-vr when AR is unsupported; retain desktop when neither exists.
- If AR session creation returns NotSupportedError, offer an explicit VR retry. This preserves the user gesture required by browsers. Permission denial is reported, not bypassed.
- Hand tracking, hit testing and local-floor are optional. Without floor tracking, use local space with an estimated 1.6 m eye height. This is not measured physical-floor alignment.
- Solar shows its virtual table and backdrop in VR. Real-surface hit testing runs only in MR; virtual placement remains available.
- Template hides its room backdrop in MR and restores it on session exit.
- Inputs: tracked controllers, joint-tracked hands, and transient-pointer/gaze select events. **Pickup is direct on every input**: an object is grabbed by reaching for it (hand pose from joints, or the pinch's grip pose when a runtime exposes no joints), never by aiming at it. The gaze/spatial ray may act only on UI (`targets`) and on objects that opt in with `userData.gaze=true` (Solar's sun). Solar table adjustments are also available through the Tools board.
- No gamepad or haptic actuator is required for lesson completion. Browser permissions and HTTPS are required for immersive entry.
- Render quality (`src/xr-quality.js`) is a persisted user setting -- sharp, balanced, smooth -- with a framebuffer scale cap, a total **pixel budget**, and shadow map size, filtering and refresh cadence. A framebuffer scale of 1.0 is the runtime's *recommended* resolution, which on a high-resolution headset is more pixels than a shadowed WebGL scene can shade at 90 Hz. Before every session entry `attachXR` probes the recommended size with a scale-1 `XRWebGLLayer` and sets the scale that fits the level's budget (`framebufferScaleFor`), so the fix lands on the **first** entry from a measured capability; the bench readout shows the probed size and the chosen scale. Sustained long frames still step the level down as a backstop. No headset names are checked.
- Spatial (transient-pointer / gaze) input: WebXR exposes no eye-tracking data. The platform composes gaze and pinch into an input source that exists only for the duration of the pinch, with a target ray aimed from the eyes at what the user is looking at. The page draws no beam for it -- a beam along that ray reads as cast from the head -- and shows only the cursor at the hit. Grab through it is the same direct, proximity grab as a tracked hand; the ray only reaches the gaze allowlist above. There is no hover before the pinch; that is a platform limit, not a page choice.
- **Thumb microgestures** (`src/microgestures.js`, VR only -- nothing happens in mixed reality; in the template, WebXR Demo, GM Installer, Nuclear and electrical demos): Quest Browser 38.1+ reports a tracked hand as an `oculus-hand` input source (profiles `oculus-hand`, `generic-hand`) whose gamepad carries Meta's recognised thumb gestures as buttons 5-9: `swipe-left`, `swipe-right`, `swipe-forward`, `swipe-backward`, `tap-thumb` (from the profile in immersive-web/webxr-input-profiles; Quest 2, Pro, 3 and 3S). The headset's recognizer makes the call, so the code only edge-detects the buttons and gates them the way Meta's Interaction SDK locomotion does. A **thumb tap** on a free hand (nothing held, no panel, ray not resting on a control) starts locomotion and draws the teleport arc along the hand's own aim ray; from then on a tap teleports, a **left/right swipe** snap-turns 30 degrees, a **forward/back swipe** steps 0.35 m along the head's flattened heading (refused off the floor like a teleport). Rolling the wrist 45 degrees from where locomotion began, pointing the index (`MICROGESTURE_TUNE.indexExtended`), 8 s without a gesture, or picking something up leaves it; outside locomotion every microgesture is ignored. A hand with microgestures skips the finger-gun/fist reader below so one thumb tap cannot fire both; the **Thumb microgestures** setting (in-scene board) turns this off to fall back to it, and a browser or device that does not report the profile (Vision Pro, older Quest Browser) gets the fallback automatically. Every threshold is unmeasured on a headset.
- Hand-only locomotion fallback (`src/hand-gestures.js`, VR scenes that are not tabletop): microgestures are not available on every runtime, so gestures are read from `XRHand` joints every frame. **Finger gun** (index extended, other three fingers curled) arms the teleport arc from the index tip; a **thumb tap** on the side of the index (touch and release within 350 ms, under 2 cm of travel) commits the teleport; a **thumb swipe** along the index (2 cm within 300 ms while touching) snap-turns 30 degrees -- toward the fingertip turns right on the right hand, mirrored on the left (`SWIPE_TURN`). Thresholds live in `GESTURE_TUNE`. Curl is the bend summed over a finger's real hinges (the knuckle and the two finger joints), normalised so 90 degrees at each reads as 1; the rigid metacarpal is not counted -- a metric that included it topped out near .5 on a fist, and the posture could not arm on a headset. Nothing fires without joints: a runtime that exposes hands only during a pinch gets no gesture locomotion, and there is no gaze fallback. Disabled in MR and while holding an object or a panel. Rooftop Solar is tabletop and has none.
- Tracked hands aim with a ray of their own (`createHandAim`, tuned by `HAND_AIM` in `src/xr-ray.js`), not the runtime's targetRaySpace, which on Quest reads high and shifts as the fingers close to pinch. It runs from an estimated shoulder through the web between thumb and index (their knuckles, which a pinch does not move), turned 30% toward where the hand itself points, smoothed more while held still than while sweeping, and starts at about the pinch. The raycast, beam, cursor, panels and selection all use it (`XRToolkit.aimOf`, and `input.ray` for `panels/input.js`); a hand whose knuckles are untracked falls back to targetRaySpace. Controllers and spatial pointers keep the runtime's ray. A tracked hand's beam is drawn only while its ray is on a target or panel, or while pinching; a hand at rest draws none. Controllers keep theirs on.

## Target device matrix (hardware verification outstanding)

| Target | Entry strategy | Input paths to check |
| --- | --- | --- |
| Quest 3 / 3S | MR if exposed, otherwise VR | Touch controllers, hands, repeated input switching |
| Android XR / Galaxy XR | MR if exposed, otherwise VR | Joint tracking, spatial select, optional controllers |
| Vision Pro | VR when AR is unavailable | Transient gaze/pinch, optional joint tracking; direct pinch-grab with and without hand permission; whether joints persist between pinches (gesture locomotion depends on it); probed buffer size and frame timing per level |
| Other WebXR headsets | Detected immersive mode | Tracked pointer or gaze/select |

This is capability-based implementation support, not certification that every browser/OS/device combination works. A headset browser without WebXR remains desktop-only; a site cannot enable unavailable platform features.

## Acceptance

The template's test bench scene exists to make the on-device list below checkable rather than
recalled. Open https://protogen-webxr.pages.dev/demo/ on the headset and work the checklist: each
item that stays unticked is a capability not yet proven on that device. The in-scene panel reports
the session mode, the reference space actually granted, every input source with its type and
handedness, live pinch distance, and frame timing.


Automated: capability combinations, optional features, local reference fallback, permission failure, shader loading, hand reconnect, controller reconnect input regressions, the controller-hand finger mapping and smoothing, settings persistence, and the controller/hand visual swap.

On each actual device: enter/exit twice; deny optional hand permission; complete every mission with available input; move and rotate the tabletop; capture readings; run a full day; test UI readability/stereo, frame timing, hand alignment and tracking recovery. Verify real-surface snapping separately in MR. On Vision Pro and Android XR, explicitly verify transient select start/end and object release before claiming full support.

Controller hands (template and WebXR Demo), on Quest with Touch controllers:

1. Setting off: controller models as before, no hand meshes.
2. Aim at the SETTINGS board; the row lights under the ray; trigger flips it to on. Controller models vanish and hands appear on the same frame; after exiting, the bench button reads on.
3. Trigger: finger off the trigger points, resting on it is slightly hooked, pulling curls smoothly with no snapping at 72/90 Hz.
4. Grip curls middle, ring and pinky; thumb on the stick or A/B plus full grip is a fist; thumb lifted with full grip is a thumbs-up.
5. Put controllers down: tracked-hand visuals only. Pick them back up: controller hands return. Both orders, twice.
6. MR passthrough: the virtual hand overlays the real one within about 1-2 cm; the board parks front-right of the viewer.
7. Vision Pro or another transient-pointer device: neither controller nor hand visual appears; select and grab are unchanged.
8. Frame timing in the bench panel with two hands and two controller models loaded shows no regression beyond about 0.3 ms.

Session exit and the system menu (every project; `src/xr-lifecycle.js`), Quest 3 and Quest Browser, hardware verification outstanding:

1. In a session, press the Meta button: the Resume/Quit banner appears. Leave it up for 30 s, then Resume: the scene is back within a second, no render-quality toast appears, and input works.
2. Meta button, then Quit: the browser returns to the 2D page within about a second; the Enter button works again. Repeat three times in the same tab.
3. Leave through the activity's own Exit (Rooftop Solar and inverter bench tools, electrical workshop lab switch): same result, and no console error.
4. While in a session, close the tab or the browser from the system menu; reopen Quest Browser: it is not stuck on a banner and the page loads normally.
5. Rooftop Solar and inverter bench: start a day run, open the Meta menu, Resume: the run is paused, and its own control resumes it.

Render quality and spatial input (template, WebXR Demo, Rooftop Solar, Nuclear), hardware verification outstanding:

1. Vision Pro, Rooftop Solar: on entry the status line reports the probed eye-buffer size and the scale chosen for `balanced`; frame timing should hold the session rate on the first entry. If it still does not, the level steps to `smooth` with a notice and persists across reload.
2. Vision Pro: pinching shows a cursor at the looked-at point and no beam. Reach for a block or a Solar panel and pinch: it is picked up and follows the hand. Look at a distant block and pinch: nothing is picked up. Look at the sun or a board button and pinch: it responds (the allowlist). Repeat with hand permission denied: pickup still works from the pinch's grip pose.
3. Quest 3, tracked hands: the beam leaves from between thumb and index and lands where the hand points -- not above it -- at a panel 1 m and 3 m away, with the arm reached out and with the hand held low at the waist; pinching does not throw the cursor off the button it is on; small tremor does not shake the cursor at 3 m. Tune `HAND_AIM` (`handWeight` for how much the wrist steers, `shoulderDrop` if the aim runs high or low overall, `slow`/`fast` for steadiness against lag).
4. Quest 3 and Vision Pro, VR (template, Demo, Nuclear, workshop): make a finger gun -- the arc appears from the index tip and the pointer beam hides; tap the side of the index with the thumb -- you teleport; open the hand instead -- the arc clears and you do not move. Rest the thumb on the index and flick it toward the fingertip -- a 30 degree turn (right hand turns right); flick toward the knuckle -- the other way. A slow slide or a long rest does nothing. Fix `SWIPE_TURN` first if the direction feels backwards, then `GESTURE_TUNE`.
5. Quest 3: shadows at `balanced` refresh at 18 Hz; a held block's shadow should not visibly lag or step. Switch levels from the SETTINGS board and confirm shadow filtering changes without a stuck frame longer than the recompile hitch.

Thumb microgestures (template, WebXR Demo, GM Installer, Nuclear, electrical demos), Quest 3 or 3S on Quest Browser 38.1 or later, hands only, VR -- **awaiting device testing**:

1. With remote DevTools attached, log `renderer.xr.getSession().inputSources` once a hand is tracked: `profiles` should list `oculus-hand` first and that `gamepad.buttons.length` is at least 10. If it is not, the fallback finger-gun path is what you are testing; say so.
2. Rest a hand with the palm sideways and the thumb up; tap the thumb on the side of the index. The teleport arc appears from the hand and the toast reads "Thumb tap to teleport. Swipe to turn or step." Tap again: you teleport to the ring. A second tap teleports again without re-entering.
3. Swipe the thumb left, then right, along the index: a 30 degree snap turn each, in the direction of the swipe. If they turn the wrong way on device, swap the two signs in `createMicrogestureTracker` and nothing else. Swipe forward, then back: a short step along where you are looking, not where the hand points; a step toward a wall does nothing.
4. Roll the wrist past about 45 degrees: the arc drops and swipes do nothing. Point the index finger: same. Leave the hand idle 8 s: same. Note which of these fires too early or too late (`exitRoll`, `indexExtended`, `idleTimeout`).
5. Reach for and hold a tool or block: locomotion ends and a swipe while holding does nothing. Point the hand at a panel or a button and tap: it does not start locomotion.
6. Fatigue: cross the room and back with microgestures only; note whether the hand has to sit higher than is comfortable for the field of view to keep tracking it.
7. Settings board: turn Thumb microgestures off; the finger gun and vertical fist work as before and a thumb tap no longer draws an arc. Turn it on again without leaving the headset.
8. Both hands, one after the other, and both at once: no double turn from one swipe, and no teleport from the other hand's tap.

## Platform references

- [Apple WebXR overview](https://developer.apple.com/videos/play/wwdc2024/10066/)
- [WebKit natural spatial input](https://webkit.org/blog/15162/introducing-natural-input-for-webxr-in-apple-vision-pro/)
- [Android XR for WebXR](https://developer.android.com/develop/xr/web)
