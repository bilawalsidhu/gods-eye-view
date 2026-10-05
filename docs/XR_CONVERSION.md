# God's Eye View — XR Conversion

## Plan and implemented scope

The `XR-Conversion` branch makes a native spatial observatory the default app.
Git refs cannot contain spaces, so this is the valid spelling of the requested
“XR Conversion” branch. The existing Cesium console remains at `?view=console`;
embedded (`?embed=1`) and shared hash URLs retain their existing console route.

The conversion follows these steps, implemented in this branch:

1. Keep the existing source/provider seams and detailed console intact. Load
   Three.js for the spatial experience and Cesium only for the console route.
2. Integrate the supplied template's controllers, hands, rays, spatial pointers,
   capability detection, floor fallback, session lifecycle, panels, locomotion,
   and MR hit testing. Keep the copied interaction modules unchanged.
3. Build a room-scale Earth globe and a desktop/touch preview. Use the bundled
   Natural Earth country pack for the base map, with no imagery token required.
4. Adapt the existing flight, vessel, earthquake and satellite sources into
   bounded, selectable spatial contacts, with visible source and failure states.
5. Provide the full core interaction loop inside the headset: layers, source
   status, contact inspection, region focus, globe rotation/scale, placement,
   workspace recentering, controller visual switching, and Exit headset.
6. Add HTTPS development tooling, regression tests, template integrity checks,
   and a physical-device acceptance checklist.

This is a spatial globe experience, not a stereoscopic Cesium canvas. The
photorealistic tiles, terrain, CCTV/video, voice, radio, annotations, event
director, and the remainder of the detailed console tools stay available in
the console. They are not yet headset-native. The next extension should adapt
each tool through the existing source/service seam into a spatial panel or
geometry, rather than running two continuous renderers on a headset.

## Run

Use the repository's supported Node version, then:

```sh
npm ci
npm run dev
```

Open `http://localhost:4173/` for spatial view, or
`http://localhost:4173/?view=console` for the original detailed console.
`npm run dev:xr` binds the same provider-enabled server on all interfaces.

A headset reaching a LAN address requires **HTTPS with a certificate trusted
by that device**. Supply your existing TLS certificate and private key:

```sh
npm run dev:xr -- --cert /path/to/certificate.pem --key /path/to/private-key.pem
```

Use the printed LAN HTTPS address in the headset. Installing a development CA
and issuing a certificate for the computer's actual LAN address (for example,
with mkcert) is a local device setup step. An untrusted self-signed certificate
does not establish that WebXR will work. Production also requires HTTPS and
the existing provider server/proxy for `/api/*`; `vite preview` and static
hosting alone do not implement those routes. USGS uses its direct public feed.
Do not commit certificate/private key files. Keep them outside this repository.

The older `dev:secure` command loads provider credentials from Keychain; it is
not a TLS server. The spatial view does not require a Google Maps API key.

## Interaction

| Input | Actions |
| --- | --- |
| Mouse / touch | Drag the globe to rotate, click/tap contacts. Mouse wheel scales. DOM buttons mirror headset controls. |
| Keyboard | Left/right arrows rotate; `+` / `-` scales; `R` recenters. Form controls keep their normal keys. |
| Controller | Aim/trigger to inspect contacts and select panel controls. Grab a panel's white bar with trigger or grip. Stick vertical changes held-panel distance. |
| Tracked hands | Pinch for selection. Pinch the white bar to move a panel. Tracking loss cancels ownership through the template. |
| Transient pointer / gaze | The runtime's composed spatial selection reaches controls and contacts. No raw eye-tracking data is requested. |
| VR locomotion | Stick forward previews a valid floor destination; release teleports. Sideways makes a 30-degree snap turn. Workspace footprint is excluded. |
| MR placement | Look at a detected surface and select empty space, or use Place on surface in Workspace tools. The actual globe is placed above the surface. |

MR disables virtual locomotion and hides the floor. Optional hit testing can be
missing; Recenter workspace always provides a virtual placement. Hand teleport
and microgesture locomotion are deliberately disabled for this tabletop app.
Controller VR locomotion remains enabled. Panel options retain the template's
Anchored, Follow me, and Grab & place modes, sizing and collision behavior.
An estimated 1.6 m floor fallback is reported when floor tracking is unavailable.

## Data and performance

- Earthquakes: existing USGS source, M2.5+, past 24 hours, refreshed every 120 s.
- Aircraft: existing OpenSky/ADS-B provider source, refreshed every 30 s when enabled.
- Vessels: existing AISStream provider source, refreshed every 60 s when enabled.
  Requires the console's existing AISStream configuration.
- Satellites: existing CelesTrak `stations` source, propagated with satellite.js
  at refresh time, refreshed every 60 s when enabled. These are **predicted
  positions from orbital elements**, not received telemetry or a full catalog.
- All layers show snapshot status, source, and received age. Failed refreshes
  retain and label the last snapshot. Disabled requests are canceled. An old
  request cannot overwrite a newly enabled layer. Failed feeds respect polling
  intervals, and requests have a 20-second timeout.
- Each layer is bounded to 1,500 spatial contacts, deterministically sampled
  across its records. Displayed/total counts expose sampling. Instanced sphere
  markers keep draw calls bounded. Aircraft receive a slight visual lift;
  satellite altitude is proportional to Earth radius. Contacts are snapshots,
  not interpolated motion or flight/vessel track histories.
- Base map: one 2,048 × 1,024 canvas texture from bundled public-domain country
  boundaries. No third-party texture fetches or fabricated sample contacts.
- Desktop pixel ratio is capped at 1.5. XR uses the template's balanced
  framebuffer pixel budget at entry. No live shadows. Panels repaint on content
  changes; normal feed-status updates are throttled to five seconds.
- Feed polling pauses when the page or XR session is hidden/blurred. The
  template ends sessions on pagehide/freeze and cancels held input at session
  end. Exit restores the desktop camera and workspace.

## Template provenance and synchronization

Base: the user-supplied `WebXR Template/` directory in this checkout. Additional
reference: `/Users/matthew/Documents/GitHub/ProtoGen-WebXR-Development`, inspected
at commit `a2d8a8d6f26a7bb69a0b128a7a659647ba234f81`, including its WebXR development
skill, template docs, panel API and headset compatibility guidance.

`src/xr/vendor/` is the recursive local-module dependency closure of the
template's toolkit, capability/lifecycle/placement modules, and panel manager
and input. The 22 copied modules are byte-identical; SHA-256 values live in
`scripts/xr/template-manifest.json`. No source imports depend on the untracked
reference folder. `public/webxr-profiles/` contains the same local controller
and hand assets, with the upstream asset license.

`npm run test:xr` checks the integrity snapshot and every advertised profile's
local model path, as well as application-specific regression tests. To update
the template: compare the upstream modules, review intentional project
differences, copy the dependency closure, update its manifest, and rerun the
template and app tests/builds plus the device checklist. App branding, globe
behavior and feed adapters belong here. No shared interaction module was
changed, so there is no shared fix to propagate to the reference projects.

The reference template directory is left as supplied. It is not staged as
part of this conversion; only the runtime snapshot and assets are app inputs.

## Validation

```sh
npm run test:xr
npm test
npm run check:boundaries
npm run format:check
npm run build
```

The existing allocation microbenchmarks run on calibrated Node 24 only. Node
26 is supported but the repository test runner explicitly skips those two
budgets. The template's own tests and production build should also pass when
updating its snapshot. See [XR_ACCEPTANCE.md](XR_ACCEPTANCE.md) for the hardware
checks that browser automation and unit tests cannot establish.

### Results for this conversion

- Production app build and reference template build: passed.
- XR regressions: 10 passed; template regressions: 253 passed.
- Repository ordinary regressions: 5,618 passed, 1 existing skip. The existing
  MCP HTTP test file hung when co-scheduled with the complete suite on Node
  26.7.0; it passed all 5 tests when run independently. The final ordinary
  run used four workers and excluded that file, then tested it separately.
  The two Node-24-only allocation probes were not run on Node 26.
- Import/package boundaries, runtime formatting and staged whitespace: passed.
- Browser: base-map rendering, real USGS contacts, aircraft sampling, predicted
  CelesTrak station positions, missing AIS credential status, contact picking,
  keyboard rotation, phone layout, panel layout, and spatial/console navigation
  verified. Both development entry points were exercised.
- The collaborative browser's screenshot endpoint failed during this run;
  DOM inspection, interaction, and direct canvas inspection were available.
  These checks do not substitute for the physical-device checklist.

Session implementation follows the [WebXR Device API](https://www.w3.org/TR/webxr/)
and the [Three.js WebXRManager API](https://threejs.org/docs/pages/WebXRManager.html):
request immersive sessions from the entry click, treat hand/floor/hit-test
features as optional, and apply framebuffer scaling before attaching a session.
