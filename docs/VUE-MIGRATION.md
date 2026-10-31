# Vue migration

The application UI moves from static templates plus imperative DOM wiring to
Vue 3 components with Pinia stores. The migration keeps the experience the
same: element ids, classes, the global stylesheet, translations, keyboard
shortcuts, voice actions, share links and the phone layout all behave as
before. The one intended change is the panel rail described below.

## Goals

- Views are Vue single-file components; state that several views read lives in
  Pinia stores rather than in DOM classes.
- The owners listed in [UI-OWNERSHIP.md](UI-OWNERSHIP.md) keep their
  responsibilities. A component replaces DOM construction; it does not add a
  second owner of the same state.
- Public methods used by layers, scene playback, voice and host applications
  (`setPanelCollapsed`, `setContextMode`, `setStyle`, share and location
  subscriptions) keep their signatures.
- Ids and classes used by browser QA and host applications stay stable until a
  host can use an explicit extension point instead.

## The panel rail

Each desktop sidebar gets a floating icon rail that lists every panel available
on that side. Selecting an icon opens that panel; selecting it again closes it.
One panel is open per side at a time, so the rail replaces the accordion
stacking. Panels that are not available in the current mode (for example
Weather before a weather layer is active) are shown disabled or omitted as the
panel's own availability rule dictates. The rail hides with the rest of the
chrome in Cockpit, scene playback, recording and the clean view.

Phones keep the existing bottom tab bar and sheets; the rail is desktop only.

Voice and keyboard openings go through the same panel store, so they follow the
one-panel rule too. Share links continue to record which panels are open.

## Component kit

`src/ui/kit/` holds the generic components (`UiRail`, `UiPanel`, `UiButton`,
`UiChip`, `UiTooltip` and so on). Names, props and events follow Halfpixel's
`ui-vue` kit so the two can converge later, but the components are written for
this repository and styled by its existing stylesheet and custom properties.
They contain no application state.

## Phases

1. **Foundation.** Vue, Pinia and the Vite Vue plugin join the browser build
   (`build/vite.js`, so host applications receive them too). One Vue runtime is
   created by the shell (`src/ui/vueRuntime.js`) with one Pinia instance that
   every view shares; disposing the shell unmounts them. Stores are added
   when a view needs one, mirroring state an owner already publishes, so
   there is never a second owner of the same state.
2. **Rail.** `PanelChrome` enforces one panel per side; the panel store
   mirrors each side's panels and the rail renders from it. Done.
3. **Panels.** Each template and its wiring become a component, keeping ids,
   classes, `data-i18n` text and CSS. A converted template is listed in
   `build/applicationViews.js`; its `gev:template` marker then expands to a
   `.gev-view` host (`display: contents`), and `mountApplicationViews()`
   (`src/ui/views/index.js`) renders the view into it before the page is
   translated and wired. `createApplication()` calls it too, so host pages
   need no change. Views belong to the page and are never unmounted. The
   loading screen stays static so it paints before any script runs. Markup
   tests read `renderApplicationHtml()` from `src/testSupport`, which renders
   the views on the server. Templates compile with Vue's `preserve`
   whitespace, which keeps the whitespace between elements as a single
   space, so a view renders as its template did; no view markup sits under a
   `white-space: pre` rule. Application views (`src/ui/views/*View.vue`) are
   kept out of Prettier; other components are formatted with strict
   whitespace sensitivity, so their source spacing is what renders. The
   markup has moved, unchanged:
   every template except the loading screen is a view.

   Next each view takes over its wiring: markup an owner builds with
   `createElement` becomes component markup that renders from a Pinia store
   the owner publishes to, and user actions come back to the owner through
   the store, so the owner keeps every decision. Static markup that the
   translation pass rewrites (`data-i18n*`) stays outside `v-if` and
   `v-for`, because re-rendering it would bring back the English; component
   text uses `t()` instead. Shared builders become components first and
   keep their imperative entry points until their owners are components:
   the rail cards, card blocks and timeline (`src/ui/rail/`) render through
   Vue's synchronous `render()` behind `createRailCards()`,
   `createRailCardBlocks()` and `createRailTimeline()`. Order: Scenes (done: `SceneOptions` and
   `SceneShotList` over the `gev-scenes` store), Weather (done: the owner
   renders `WeatherReadout` from the view it computes), Recent imagery
   (done: `RecentImageryReadout` and its day cards, the same way),
   Street level (done: `StreetLevelPanel` renders the `gev-street-level`
   store that `StreetLevelControls` publishes to; the controls keep their
   listeners, EXPAND, focus and resizing), CCTV (done: `CctvPanel` renders
   the whole panel from the `gev-cctv` store, including the camera picker,
   the inline pose editor, the frame preview, source badge and typed
   summary; `CctvControls` keeps its listeners, the frame requests and the
   live video surface), Layers (done: `LayerPanel` presents each row and
   renders `LayerRows` synchronously; keyed chips and list items keep focus
   through the refresh their own click triggers, and clicks re-read the live
   descriptor before acting), Display, Context and Radio, the command dock,
   the phone shell, then Cockpit. Layers that write into the right rail
   directly gain a slot instead.

4. **Cleanup.** The build-time template expansion and the attribute
   translation pass are retired once nothing uses them. Hosts register panels
   and rail items through an explicit API instead of editing markup.
   Markup-string tests are replaced by component tests.

## Verification

- Unit tests: stores and components run under `npm test`. Single-file
  components are compiled by a test loader; component tests render with
  `@vue/test-utils` and `happy-dom`. `npm test` registers the loader; to run
  one file that reaches a component (including anything importing the
  shell), use `node --import=./build/registerVue.js --test <file>`.
- Never pass happy-dom nodes to `assert.equal` or `deepEqual`: a failure
  prints both operands, and a node reaches the whole page and window, which
  runs the process out of memory. Compare nodes with `assertSameNode()`
  (`src/testSupport/domAssert.mjs`).
- Panels lifted out of a view keep its verbatim markup in
  `src/ui/views/panels/`, which Prettier leaves alone like the views.
- Visual parity: before/after screenshots of every panel at desktop and phone
  widths, in the default and Cyber themes, with the rail as the only expected
  difference.
- Browser QA: the selector-based `scripts/qa-*.mjs` suites keep passing.
- `npm run format:check`, `npm run check:boundaries`, `npm run i18n` and
  `npm run build`.
