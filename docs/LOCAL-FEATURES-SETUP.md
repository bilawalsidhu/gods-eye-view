# Run the mobile, camera and infrastructure features

This contribution keeps the upstream [MIT license](../LICENSE) and Bilawal Sidhu's
copyright. Public-source data and visual assets retain their separate terms in
[DATA_SOURCES.md](../DATA_SOURCES.md). No personal deployment settings, credentials,
camera captures or generated local datasets are included.

## First launch

1. Install [Git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org/)
   24.14 or newer within 24.x, or 26.x. Use the official installers and verify
   `git --version` and `node --version` in a new terminal.
2. Clone the contribution branch, open its directory, and install its locked dependencies:

   ```sh
   git clone --branch contrib/mobile-camera-infrastructure-20261012 https://github.com/DatafyingTech/gods-eye-view.git
   cd gods-eye-view
   npm ci
   npm run start:local
   ```

3. Open the local address printed by Vite, normally `http://127.0.0.1:4173`.
   No API key is required for the keyless globe. The launcher binds to loopback;
   it does not change a firewall, install a service, configure authentication or
   expose the app to the internet. Stop it with Ctrl+C.

If the port is busy, use the alternate local port printed by Vite. Keep this
checkout separate from any running installation. Reopen the terminal after
installing Node if `node` still reports an older version.

## What is included

- A map-first phone menu, coarse-pointer landscape handling, safe-area/credit
  placement and smaller GPU, tile-cache and HLS budgets for constrained devices.
- Camera Refresh/Close, minimized camera return, mobile fullscreen with modal
  fallback, and animated desktop page expansion with Escape/focus restoration.
  Expansion moves the existing playing surface rather than creating a decoder.
- User-triggered, one-shot Locate me. Once used, URL hashes and copied links use
  a globe overview for this page, including later nearby pans. No follow watch or
  saved device marker is created. Location requires a secure browser context.
- Snapshot preview, original/marked downloads, circle/marker/region annotation,
  separate crop/zoom/contrast/sharpen derivatives, and unverified research notes.
  Enhancement cannot recover missing pixels. CORS restrictions are respected.
- Optional single-original-image OpenAI Q&A with `gpt-6.1-sol` and high reasoning.
  No image is sent by opening the dialog or checking model access. Explicit
  **SEND ORIGINAL TO OPENAI** sends the original, question and normalized marks;
  enhanced pixels and notes are excluded. API charges apply. No model fallback,
  automatic retry, person/plate identification or cross-camera matching is used.
- A Georgia511 adapter for operator-supplied metadata, bounded session refresh,
  registered-host/path validation and throttling. Failed live video stays honestly
  unavailable instead of being represented as Street View or synthetic footage.
- Independent default-off EIA/OSM infrastructure toggles, viewport/tile/entity
  budgets, documented technology filters and source/date/owner/operator details.
  Unknown tags remain unknown; proximity/crossings do not imply connectivity,
  hosted carriers, service coverage or outage dependencies.
- Optional owner-only Tailscale Serve access configured through local environment
  values. Credential settings, OAuth sign-in, logs and MCP remain desktop-only.

## Optional keys and OpenAI

Use the existing Provider Settings panel locally or copy `.env.example` to ignored
`.env` and fill only the keys you need. Never commit `.env`, screenshots of keys,
tokens or browser profiles. OpenAI image Q&A requires your own Responses API
credential; ChatGPT/Codex/voice OAuth is not API access. Model listing establishes
listed access, not successful inference or available quota. The selected model
is documented in the [official Sol page](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

Cancel stops remaining work but cannot recall an image already sent. Downloads
and notes are local user actions; sharing or publishing footage still requires
the provider's permission and appropriate privacy review.

## Georgia cameras: bring permitted metadata

The generated local catalog and camera media are **not shipped**. Public viewing
does not establish permission to redistribute a catalog or automate a service.
Use the [official viewer](https://511ga.org/) or a provider-approved metadata source.

`config/cctv_sources.georgia511.example.json` contains one invented test row, not
a working camera. Its shape documents `cameras[]`: site `id`, published county,
matching `viewerUrl`, location ending with that county, `POINT (lon lat)`, registered
stream `name`, and enabled `views[]` with integer view ID, published GDOT host and
HLS type. After confirming your rights/API-use terms, place your permitted
metadata in ignored `config/cctv_sources.georgia511.json`. Do not include issued
authorization URLs, cookies, credentials, private sources, captured segments or
images. `CCTV_GEORGIA511_ENABLED=0` disables the adapter. Existing upstream camera
packs continue to work without this file.

## Local infrastructure packs

No new generated EIA/Georgia OSM extracts are shipped. The adapters report missing
local data honestly. Obtain permitted public records yourself, retain provider
attribution, collection date, coverage and license, then normalize them to a JSON
array. Each record needs bounded string `id`/`name` and finite `lat`/`lon`; optional
explicit fields include `owner`, `operator`, `network`, `hostedCarriers`,
`technologies`, `capacityMw`, `statuses`, `generatorCount`, `geometry`, `source`,
`date`, `license`, `sourceCoverage` and `sourceUrl`.

```sh
node scripts/prepare-local-infrastructure.mjs --input public-records.json --dataset eia-plants
```

Dataset IDs are `eia-plants`, `osm-ga-sites`, `osm-ga-mapped-plants`,
`osm-ga-substations` and `osm-ga-telecom`. The helper validates input and writes
two-degree `index.json`/tile files into ignored `public/infrastructure/<id>/`.
It does not download or infer data. Switch the corresponding layer on after
preparing its pack. Names/MW are inventory data, not live generation. Existing
submarine cables remain a separate upstream dataset with their existing terms.

Official sources: [EIA-860M](https://www.eia.gov/electricity/data/eia860m/index.php),
[EIA reuse](https://www.eia.gov/about/copyrights_reuse.php),
[Georgia OSM extract](https://download.geofabrik.de/north-america/us/georgia.html),
[OpenStreetMap ODbL](https://www.openstreetmap.org/copyright).

## Optional private phone access

Install [Tailscale](https://tailscale.com/download) yourself if desired, authenticate
your devices and configure owner-only access rules. Use Serve, not public Funnel.
This repository performs none of those system/account/network changes for you.

Keep the app on loopback. In ignored `.env`, set your own exact HTTPS `.ts.net`
origin, owner login and matching `GEV_ALLOWED_HOSTS` hostname. Leave both trust
values blank for ordinary local use. Forwarding headers alone do not establish
trust: the app requires a loopback peer, matching origin/host, HTTPS signal and
exact owner identity. The local machine/proxy configuration remains a trust
boundary; a process on your machine already has the local broker's capabilities.
Never paste actual tailnet names, owner identity or auth details into a public PR.

See [Tailscale Serve documentation](https://tailscale.com/kb/1312/serve) and
[SECURITY.md](../SECURITY.md). Test refusal for other identities and desktop-only
paths before using it. Provider-side budgets remain the spending backstop.

## Validation and troubleshooting

Run `npm run doctor`, `npm run format:check`, `npm run check:boundaries`, `npm test`
and `npm run build`. With a separate dev server/browser, run `npm run test:track`
and `node scripts/qa-cctv-v2.mjs --url <local-url>`. Optional source absence is not
evidence of zero infrastructure or a live camera. Browser fullscreen can be
denied; the in-page modal remains usable. A missing image API key/model produces
an unavailable state without spending inference quota or switching models.

Screenshots in `docs/media/local-features/` use invented camera pixels, location
and metadata only. They illustrate controls; they are not observations of real
people, vehicles, property or provider footage.

## Try the controls

On a phone, open **Menu**, expand a section, then choose **Back to map**. Locate
runs only when you press its target button and allow browser location access.
Choose a camera from Cameras; **Refresh** retries that selection, **Minimize**
returns map space, **Fullscreen/Back** changes presentation, and **Close** clears
the selection. On a desktop, use **Expand**, then **Restore** or Escape.

Press the camera button on a displayed frame to open its snapshot. Use
**Marker**, **Circle** or **Region** to draw; Undo/Clear affect marks. Save original
preserves the original pixels, while Save marked exports a labeled derivative.
Select a region before **Enhance region** to create a separate crop/zoom/
contrast/sharpen preview. Notes remain unverified local research. **Ask AI** shows
provider/model availability; only the explicit send button submits the original
and question. Permission, CORS, missing keys and unavailable media can prevent
these actions; the UI reports that state.

Infrastructure toggles live in Data layers. Prepare a permitted pack first,
enable a layer, zoom in, then select a rendered record to inspect source-reported
fields. Technology filters select explicit tags only; missing metadata is Unknown.
See the [synthetic screenshot gallery](media/local-features/README.md) for the
phone menu, camera presentation and snapshot controls.

## Reproduce the synthetic UI gate

Use a separate keyless checkout with no deployment `.env`. The synthetic example
contains two invented cameras and fetches only the bundled original drawing on
loopback port 4173. It is test data, not an operational source catalog. In one
PowerShell terminal, start that fixture server:

```powershell
$env:CCTV_SOURCES_FILE = (Resolve-Path config/cctv_sources.synthetic.example.json).Path
$env:CCTV_GEORGIA511_ENABLED = '0'
npm run start:local
```

For a POSIX shell, use:

```sh
CCTV_SOURCES_FILE="$PWD/config/cctv_sources.synthetic.example.json" CCTV_GEORGIA511_ENABLED=0 npm run start:local
```

Require port 4173 for this example; if it is busy, stop the fixture server and
choose another checkout/port explicitly, updating only the invented example's
loopback frame URLs. In another terminal, run:

```sh
node scripts/qa-local-observation.mjs --url http://127.0.0.1:4173
```

The gate uses a new headless profile, invented location and mocked OpenAI requests.
If the configured Puppeteer browser is not already present, set
`PUPPETEER_EXECUTABLE_PATH` to your installed supported browser; this gate does not
install one. Screenshots, its private profile and downloads go to ignored
`qa-artifacts/local-observation/`. They are not contribution files. This gate
covers presentation, Refresh, Close, locate privacy and snapshot/Q&A interaction;
server provider and permission failures are also covered by the unit tests.
