# Spatial observatory — device acceptance

Status: **awaiting physical-device testing**. Capability detection is not
hardware certification. Test Quest 3/3S (controllers and hands), Vision Pro
(transient pointer and optional hands), and Android XR (available input paths)
over trusted HTTPS. Record browser/OS versions and results here.

1. Start with no provider keys. The base map loads, USGS connects or reports its
   failure, and MR/VR entry matches the capabilities that browser exposes.
2. Enter MR; then test VR explicitly. Deny hand and floor permissions in a
   separate run. Unsupported optional features never block entry. A rejected
   MR mode offers a user-initiated VR retry. Permission denial stays visible.
3. Confirm both eyes see the same globe with correct depth. Read the left
   Spatial controls and right Observatory panels at their default positions.
   Verify text legibility and contact picking near the limb, including that
   contacts behind Earth cannot be selected through it.
4. Toggle all four layers from the headset. Verify source and snapshot ages;
   inspect contacts, rotate/focus the globe, change size and refresh feeds.
   A missing vessel key must report failure without inventing contacts.
5. Controller: trigger release activates a panel control once; grab the white
   bar with grip or trigger, change depth with the stick, and release. Tracked
   hands: repeat with pinch. Remove tracking while holding and confirm the
   panel does not stay attached or activate an interrupted control.
6. Spatial pointer: pinch while looking at a control/contact; the cursor shows
   at the hit and no head-cast beam appears. Test with hand permission denied.
7. Put down controllers, use hands, then pick controllers up; repeat both
   orders twice. Switch controller/hand visuals from Workspace tools. Check
   alignment, reconnect behavior, and the absence of ghost models.
8. MR: the virtual floor is absent. Stick movements never teleport/snap turn.
   Surface reticle places the globe's base above a real tabletop; repeat after
   moving the head. Selecting a panel/contact never places the globe. Test
   without hit-test support: virtual recentering remains reachable.
9. VR: valid stick-forward teleport preview commits on release; destinations
   outside the grid or inside the globe footprint are refused. Sideways turns
   30 degrees once per deflection and accounts for physical head offset.
   Recenter panels after moving away; confirm globe controls remain reachable.
10. Open the system menu for 30 seconds, resume, then quit. Repeat entry/exit
    three times. Exit through Workspace tools as well. The desktop camera and
    workspace return; the entry button still works. Close the tab mid-session
    and verify the compositor is released.
11. With all feeds enabled, move both hands and inspect contacts for two
    minutes. Record sustained fps, missed frames, overheating and readability.
    High-resolution devices should receive the balanced pixel budget on first
    entry. Do not treat desktop timings as headset evidence.
12. Test touch preview and keyboard-only desktop controls at phone, tablet and
    desktop sizes. Open map console and a saved shared link; confirm the
    detailed map/tools and embed behavior still work.
