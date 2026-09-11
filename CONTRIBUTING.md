# Contributing to God's Eye View

Thanks for being here. God's Eye View is an open foundation for live spatial intelligence in the browser, and it gets better when more people run it, break it, and extend it.

## Getting set up

Use Node.js 24.14.x or 26.x (also enforced by `package.json`).

```bash
git clone https://github.com/bilawalsidhu/gods-eye-view.git
cd gods-eye-view
nvm install 24.14.0
nvm use 24.14.0
npm install
npm run doctor
./scripts/dev-fresh.sh        # or: npm run dev (keys are optional)
```

No key is required to start: the app boots on keyless Esri World Imagery with
keyless terrain, and OSM takes over automatically if Esri is unreachable.
Google Maps provides direct photorealistic 3D and place search; Cesium ion
provides ion-hosted Google 3D plus optional Bing/world-terrain stacks.
On macOS the launcher pulls optional keys from
the Keychain; on any platform you can pass them as env vars or use a `.env`.
People who only want to run the app can instead install the repository directly
through Pinokio; the terminal path above remains the contributor path.

Open `http://localhost:4173`. Before sending a PR run `npm run build`, `npm test`, and `npm run test:track` (dev server must be up) — **all three must stay green.**

## Feature regression gates

Those three are the baseline, not the whole story. Most features also have a
dedicated headless gate under `scripts/qa-*.mjs` that drives the real app and
asserts that feature's contract. **Run the gate covering whatever you touched**,
and say which one you ran in the PR.

The scripts are the canonical list, and each one documents itself:

```bash
ls scripts/qa-*.mjs            # every gate
head -20 scripts/qa-radio.mjs  # what this gate proves, and how to run it
```

Every gate opens with a comment naming what it asserts. Most take
`--url http://localhost:<port>` and need a dev server up; some need a specific
provider key or a particular port, and the header says which. Run them directly
with `node scripts/qa-<name>.mjs` — only `qa:map-source-tray` has an `npm run`
alias.

If you aren't sure which gate covers your change, search `docs/CURRENT-STATE.md`
for the feature: it names the gate for many of them, and it's the authoritative
runtime reference either way.

> **CI does not cover this for you.** The workflow runs the unit suite, the
> setup policy checks and the production build (plus a Windows onboarding job).
> It runs neither `npm run test:track` nor any `qa-*.mjs` gate — both need a live
> dev server and a browser. For anything outside the unit suite, your local run
> is the only check before it reaches `main`.

## Good first contributions

The highest-leverage places to jump in:

- **🌆 Add a CCTV source pack.** Austin is the reference camera source. Adding another city means a clean public camera catalog with coordinates, attribution, and server-registered frame URLs (the proxy only fetches registered URLs — never client-supplied ones, see [SECURITY.md](SECURITY.md)). City packs are the best first lane.
- **🛰️ Add or improve a data layer.** Each layer is one self-contained module in `src/data/<layer>.js` implementing the layer interface (`init/enable/disable/update/destroy/getStats`, optional `getDetectableObjects`/`getStats`). Use an existing layer as a template.
- **🎙️ Extend voice control.** Voice tools are declared server-side (`GEV_REALTIME_TOOLS` in `vite.config.js`) and executed client-side (`src/voice/gevActions.js`). Keep the tool surface tight and the responses honest (confirm only what actually happened).
- **🎨 Add a visual style.** Styles are GLSL post-process shaders in `src/styles/`.
- **🐛 Fix bugs / improve the first-run experience.** See [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).

## Architecture in one minute

- **No framework.** Vanilla JS + [CesiumJS](https://cesium.com/platform/cesiumjs/) + [Vite](https://vitejs.dev/).
- **UI lives in `src/ui.js`** (panels, HUD, styles, the control facade). **Layer logic lives in `src/data/<layer>.js`.** Keep them separate.
- **Secrets stay server-side.** Anything needing a private key goes through a Vite proxy in `vite.config.js`. The browser only ever sees the Google Maps key (which you restrict) and ephemeral tokens.
- `docs/CURRENT-STATE.md` is the authoritative runtime reference — read it first.

## Coding style

- ES modules, **2-space indent, single quotes, semicolons.**
- JSDoc on exported/public functions.
- Match the surrounding code — comment density, naming, and idiom.
- Prefer small, reviewable commits. Conventional-commit-style prefixes (`feat:`, `fix:`, `perf:`, `docs:`) are appreciated but not required.

## Pull requests

1. Branch off `main`.
2. Keep `npm run build`, `npm test`, and `npm run test:track` green and avoid new console errors, plus the [feature gate](#feature-regression-gates) for the area you touched.
3. If you change runtime behavior, update `docs/CURRENT-STATE.md` and `CHANGELOG.md` in the same PR.
4. If you add or change a data source, update [DATA_SOURCES.md](DATA_SOURCES.md) with its license and attribution. **Don't add data you don't have the right to redistribute** — fetch it at runtime instead.
5. Describe what you changed and how you verified it (screenshots welcome for anything visual).

## Maintainers

God's Eye View is maintained by [Bilawal Sidhu](https://github.com/bilawalsidhu)
and [Sameh Khamis](https://github.com/samehkhamis) at
[Halfpixel](https://halfpixel.ai). Either maintainer can review and merge
contributions.

## Ground rules

- This is a tool for **public** data. Don't add scraping of sources whose terms forbid it, private/paywalled datasets, or anything that misrepresents public-data inference as authoritative intelligence.
- Be decent to each other. Assume good faith, keep it constructive.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
