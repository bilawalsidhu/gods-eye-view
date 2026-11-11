# CCTV integration workflow

Use this workflow when adding a camera provider or repairing an existing feed.
The CCTV catalog comes through the local server; media normally does too. Keep
provider-specific URL policy on the server, including any validated browser-only
media URL permitted by the exception below.

## 1. Check the source before coding

- Identify the catalog endpoint and the actual frame or live-media endpoint.
  They may be different hosts or use different formats.
- Read the provider's license, terms, attribution, rate limits, and access
  requirements. Publicly reachable data is not automatically licensed for
  reuse. Record whether the app may display it and whether any use is
  restricted.
- Prefer a public, keyless feed. If credentials are required, keep them in a
  server-only environment variable; never put a secret in browser code or a
  Vite-exposed variable. A pack that needs a key is opt-in by that key: with
  the variable unset it makes no request and logs once (Ontario 511 and
  Ottawa). Keep the key out of catalog URLs and add it only at fetch time. Use
  the provider's documented API, not a website endpoint that skips its key. If
  access terms require an agreement or remain unconfirmed, make the pack
  opt-in and ensure it makes no request by default.
- Confirm the feed can be fetched from the app's Node server environment. A URL
  opening in a browser does not prove the server can reach it, and browser CORS
  behavior does not diagnose a server-side fetch.
- Treat camera directories and aggregators such as [TW Live](https://tw.live/)
  as discovery aids. Trace each listing to the original agency or camera owner;
  their data and media terms govern reuse. For example, SkylineWebcams says
  only camera hosts may embed its live feed and its terms restrict copying or
  retransmitting footage, so do not proxy its stream without written
  authorization ([FAQ](https://www.skylinewebcams.com/support/faq.html),
  [terms](https://www.skylinewebcams.com/en/terms-of-use.html)).
- Decide whether the provider supplies still snapshots or continuous video.
  Prefer stills unless live video is necessary and supported by the existing
  proxy path.

## 2. Add and register the provider pack

Use the smallest existing provider as a template. Current owners are:

- `server/providers/cctv/sources.js` for standard open-data loaders.
- `server/providers/cctv/<provider>.js` for a provider with its own parser,
  fallback, or more involved URL policy.
- `server/providers/cctv/catalog.js` to import the loader and add it to
  `LIVE_PACKS`. Each pack is independently gated and the shared catalog cap
  allocates space across packs.
- `server/providers/cctv/constants.js` for provider endpoints, caps, and
  timeouts.

Return normalized camera records with stable unique IDs, readable names,
`city`/`cityId`, provider attribution, valid `lat`/`lon`, and the correct
`feedType`. Include camera heading only when the source actually provides a
bearing; descriptive direction text is not a numeric heading. Mark uncertain
heading data with the existing low-confidence conventions. Set `sourceKind` so
health and source diagnostics identify the provider. Apply a bounded per-pack
camera limit and geographic filtering where appropriate; avoid one provider
silently consuming the whole shared catalog cap.

Camera coordinates need their own verification. Prefer the original provider's
camera coordinates, then corroborate them against its location description,
route/mile marker, or official map. An aggregator's map dot, a town/county name,
or a geocoded attraction name is not a precise camera position. Do not pin a
camera to a city center or nearby landmark; if its actual location cannot be
verified, leave it out until it can. For manually curated coordinates, record
the evidence in the provider data or an adjacent comment. For example, TW Live
camera pages identify the originating agency; use that agency's catalog for
the camera point when available.

If the source becomes opt-in, use the catalog's opt-in gate (`envOptIn`) and
document the flag and reason in `DATA_SOURCES.md`. Otherwise use the normal
enabled-by-default flag pattern and document how to disable the pack.

## 3. Keep frame and media requests server-registered

The browser should request the local `/api/cctv/frame/:id` or
`/api/cctv/media/:id` endpoint. Do not pass an arbitrary upstream URL from the
browser, and do not fetch an unvalidated URL supplied by a catalog record.
Every provider must have a server-side rule that pins frame and media URLs to
the expected scheme, host, and path; use HTTPS where the provider supports it.
Use `pinnedCameraUrl()` for URLs that belong under a fixed provider directory,
or a stricter provider-specific validator when hosts or paths vary. Register
any new permitted image/media origin in the existing
`server/providers/cctv` media policy.

Catalog and media loaders must also:

- refuse unsafe schemes, credentials, unexpected ports, redirects outside the
  registered origin/path, and malformed identifiers;
- set request deadlines and cap catalog and buffered frame bodies;
- parse only the expected format and validate coordinates before returning a
  camera;
- handle offline cameras and partial provider failures without failing the
  entire merged catalog; and
- avoid persistent frame storage unless the provider's terms explicitly allow
  it and the design has been reviewed.

For live media, prefer the existing proxy and supported feed type (`mjpeg`,
`mp4`, `webm`, or `hls`). A direct browser-only video is a narrow fallback for
a source whose terms allow embedding when the browser can play it but the app
server cannot fetch it. Unconfirmed embedding terms make it opt-in like any
other pack, and the browser loads it only after an explicit play action, never
on selection, because the provider sees the viewer's IP address. Build its URL
from a validated provider ID on the server; never accept a browser-supplied
media URL. Render it in a native DOM
`<video>` without `crossOrigin`, and do not read its pixels into canvas, WebGL,
or a Cesium texture. If a map preview is needed, a second video request may be
paused as a DOM overlay at the camera location; label it as an approximate
still and scale it with map distance. If terms disallow embedding, use a source
link instead. Read [SECURITY.md](../SECURITY.md) before changing URL
validation, redirects, or proxy behavior.

When an image provider sets a minimum refresh interval, enforce it at the
server frame boundary as well as in the client. A bounded in-memory cache and
single-flight request per camera prevent projection, panel, and re-selection
paths from multiplying upstream requests; do not persist frames unless the
provider's terms explicitly allow it.

## 4. Add focused regression coverage

Add provider tests under `src/data/` following the existing CCTV test naming
and fixtures. Cover at least:

- representative valid catalog rows and their normalized output;
- missing or invalid IDs, coordinates, and frame URLs;
- duplicate records and the pack's cap/filter behavior;
- unsafe host/path, credentials, and redirect cases;
- timeout, oversized, malformed, and unavailable upstream responses; and
- the frame or live-media content type the provider actually serves.

Use `src/data/cctvProxy.test.mjs` for shared proxy/media behavior and
`src/data/cctvCatalogCap.test.mjs` for shared catalog allocation. For a
browser-only source, verify native playback, denied canvas pixel access, the
paused second-player overlay, and its cleanup separately from proxy tests. Run
the focused provider and proxy tests, then the standard checks from
[CONTRIBUTING.md](../CONTRIBUTING.md) that apply to the change. For runtime
verification, inspect `/api/cctv/sources`, `/api/cctv/health`, and the camera's
`/api/cctv/frame/:id` or `/api/cctv/stream/:id` response locally. Confirm a
successful frame is from the upstream camera by checking its content type and
`X-CCTV-Source`; a fallback image is not proof that the upstream feed works.

## 5. Update source documentation and submit

- Add the provider, endpoint, terms/license, required attribution, key status,
  caching behavior, and any restrictions to `DATA_SOURCES.md`.
- Update the CCTV source section in `docs/CURRENT-STATE.md` when runtime
  behavior, flags, caps, or fallback behavior changes.
- Register in-app attribution through the existing source/provider credit
  fields; update `src/data/dataCredits.js` when the source needs a layer-level
  credit.
- Add the required `changelog.d/<pr-number>-<slug>.md` entry for a runtime
  change, and include the source, license, attribution, key/runtime-fetch
  details, and verification evidence in the PR description.
- For a new layer, also follow the camera/source requirements in the
  [new-layer PR checklist](../CONTRIBUTING.md#adding-a-new-layer).
