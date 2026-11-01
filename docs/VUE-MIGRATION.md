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

`src/ui/kit/` holds the generic components: `UiRail`, `UiTooltip`, `UiIcon`,
`UiButton`, `UiPanel`, `UiSegmented` and `UiSlider` so far, with more
(`UiSelect`, `UiChip` and so on) joining as the controls they serve are
converted. One component
serves every use of a control, with props for the differences (`UiPanel`'s
`sideways`, `glow`, `scroll`), rather than a copy per panel. Names, props,
events and class names follow Halfpixel's `ui-vue` kit so the two can merge
later, but the components are written for this repository and styled by its
existing stylesheet and custom properties; a kit class such as
`ui-button--icon` carries no Core style yet, and a converted control keeps
its own classes beside it. They contain no application state.
`UiPanel` takes ui-vue's `title`, slots and `v-model:collapsed`, but its
`collapsed` drives only the button and `ui-panel--collapsed`: the panel's
owner hides the body by writing the root's `collapsed` class at once, and
there is no `closable`, since Core's panels collapse rather than close.
`UiSegmented` adds `keyboard` (`none`, `arrows` as in ui-vue, or `radio` with
Home and End), since each of Core's groups keeps its own keyboard policy, and
`itemClass`/`activeClass` for Core's segment classes. A key moves focus at
once and asks for a change only when it lands on another option. Every
segmented group in Core is a `UiSegmented`; the old `segmentedControl.js`
adapter is gone.
`UiButton` adds `pressedClass`, Core's class on a pressed toggle (most use
`active`); its pressed classes toggle through `classList`, so a class other
code adds (a voice highlight) survives a press. Every pressed toggle in the
views is a `UiButton` except Bhote Koshi's cinematic button and the
tilt-map button, whose owners still write their state into the DOM. Core's
pressable chips and pills (rail card chips, map sources, cities and places)
are `UiButton`s too; `UiChip` is ui-vue's non-interactive label chip, used by
the voice card.
`UiSelect` renders the bare native select (Core's labels sit outside it or
come as an `aria-label`) with ui-vue's `v-model`, `options` and `disabled`;
options that carry their own attributes come through the slot, a caller's
`@change` still reaches the select, and `hold` works as in `UiSlider`.
Without `hold`, a select takes its model back after its own change renders,
so a pick its owner refuses goes back; an owner that answers later (the SDR
gain) takes `hold`. Every select in the views is a `UiSelect`.
`UiBadge` takes ui-vue's `tone` and carries Core's `gev-status-badge`; its
density variants and colours stay caller classes, and it renders the CCTV
source and calibration badges and the rail card badges. `UiEmpty` takes
ui-vue's `title` and `hint`, but Core's empty states are one line, so the title
is the text itself rather than a bold heading; the Scene shot list, mission
roster and imagery strip use it. The locale picker's and the mission tables'
empty rows stay a paragraph and table cells, and no Core block matches
`UiSection`'s header and well, so none uses it yet.
`UiSlider` keeps the native range input where ui-vue draws a
`role="slider"` track, so Core's keyboard, form behaviour and styling stay;
it takes ui-vue's `v-model`, `min`, `max`, `step` and `disabled`, emits a
number, and adds `hold` (never rewrite a focused handle, and take the model
back on blur). It is a functional render-function component, so the
portable `./ui/input` rows use it without a component compiler. The
Display, Radio, RTL-SDR, Cockpit, mission replay and style parameter
sliders are `UiSlider`s; Street Level's date slider, Bhote Koshi's split
and progress ranges and the rail card settings' ranges keep their own
inputs for now. Merging the kits means settling native input against the
drawn track.

Controls share one skin, so every panel reads the same. Every scrolling
surface carries the kit's `.ui-scroll` (ui-vue's name), which draws the thin
themed scrollbar from `--scroll-thumb` and `--scroll-track`; the Cyber theme
sets those two tokens, and Cockpit's HUD windows keep their accent tint. A
surface without it would draw the platform's light scrollbar, because the
page declares no dark `color-scheme`. Selects and number fields are
`.gev-field`, which draws its own chevron in place of the platform's arrow
and keeps native spinners dark; ranges are `.gev-quantitative-slider`, with
a feature supplying only its accent.

## Phases

1. **Foundation.** Vue, Pinia and the Vite Vue plugin join the browser build
   (`build/vite.js`, so host applications receive them too). One Vue runtime is
   created by the shell (`src/ui/vueRuntime.js`) with one Pinia instance that
   every view shares; disposing the shell unmounts them. Stores are added
   when a view needs one, mirroring state an owner already publishes, so
   there is never a second owner of the same state.
2. **Rail.** `PanelChrome` enforces one panel per side; the panel store
   mirrors each side's panels and the rail renders from it. The rail panels
   are `RailPanel`s: the kit's `UiPanel` drawing Core's panel markup, bound to the `gev-panel-chrome`
   store, with their titles rendered by `t()` rather than `data-i18n`. Each panel's
   collapse button, the dock tray toggles and the
   dock pins render the open and pinned state PanelChrome presents to the
   `gev-panel-chrome` store, and their clicks call it there. Each panel's
   root draws its own state from there too (`v-panel-state`: `collapsed`,
   `dock-pinned`, `dock-pinned-top`, `layout-auto-collapsed`,
   `accordion-collapsed`): PanelChrome, the rails and the accordion present
   it rather than writing classes. The directive applies it in a synchronous
   watcher, not on Vue's next render, because the rails measure a panel in
   the same task that opens or closes it. Done.
3. **Panels.** Each template and its wiring become a component, keeping ids,
   classes and CSS; text a template renders with `t()` drops its `data-i18n`
   marker. The page places each view with a
   `.gev-view` host (`display: contents`), and `mountApplicationViews()`
   (`src/ui/views/index.js`) renders the view into it before the page is
   translated and wired. `createApplication()` calls it too, removing the
   hosts of any views its `omitViews` names. Views belong to the page and are
   unmounted only when a later call omits them. The loading screen is static markup in the page so it
   paints before any script runs. Markup
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
   `SceneShotList` over the `gev-scenes` store; the panel's buttons, status
   line, progress bar and the runtime chip render the panel SceneControls
   presents there, and the buttons and file chooser call its actions), Weather (done: the owner
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
   descriptor before acting), Display (in progress: `DisplayPanel` renders
   the HUD, Sonar, Scope, Celestial, detection, bloom and sharpen from the
   `gev-display` store, which VisualSettings publishes to, and the 3D
   aircraft group, the Draw controls and the imported file list, which
   AircraftDisplay, the draw tool and the file import publish beside it;
   the controls call DisplayBindings, the draw tool and the file import
   through the store's `connect`/`act`, the newest owner of an action
   answering it; `GeoImport` hands keyboard focus on before a focused row
   goes, with `v-focus-safe-children`; the
   style parameter rows render through Vue behind `createStyleParameters()`,
   as a render function so the portable `./ui/input` entry needs no
   component compiler; the other groups follow one owner at a time),
   Context and Radio (in progress: `RadioPanel` renders the directory row,
   station card, transport, volume and playback line from the `gev-radio`
   store that RadioControls publishes to and whose controls it answers
   through the store's `connect`/`act` (the shared `createOwners()`; a
   refused station tag gets the kept tag back from `act`), and `SdrCard` the
   local RTL-SDR card that LocalSdrControls publishes beside it and answers
   the same way; fields a person edits take their value through
   `v-field-value`, which never writes a focused field;
   `RadioTuner` renders the directory tuner, where RadioControls keeps the
   drag and its slot, takes the slider's pointer, key and value events
   through the store and publishes the band, readouts, slider and needle,
   and the component lays out the tick tape against the dial's measured
   width and lays out the snapped needle before it drops the drag class;
   `ContextView` renders the mode switch and the nearby sites
   search from the `gev-context` store, which ContextControls reaches only
   through its `publish` option, so `./ui/context` needs no Vue;
   `AwarenessPanel` renders the Contacts panel that the awareness layer
   publishes through `subscribePanel()`, the first layer to hand its rail
   content to a view, and `MissionRoster` and `MissionDetail` the Space
   Missions roster and selected mission that the launches layer publishes
   the same way), the command dock (in progress: the style buttons, the
   dock's style mini status and the ACTIVE STYLE corner render the style
   VisualSettings publishes to the `gev-display` store; the buttons keep
   their owner's listeners; the map source chips and status badge render
   what `createMapSourceControls()` publishes beside it, so `./ui/maps`
   needs no Vue; the location tray's city and landmark pills, mini status
   and search error render what `LocationControls` publishes to the
   `gev-location` store, and the search field keeps its listeners; beside
   the voice control, the dock teleports each voice pointer reticle to the
   body where its `PointerReticle` presents it in the `gev-pointer-reticle`
   store), the phone shell (`PhoneTabBar` renders the tabs and open sheet the shell
   publishes to the `gev-display` store, teleporting the tab bar and sheet
   backdrop to the end of the page from the first publish until the shell
   is destroyed; the shell takes their clicks from the document), the
   imagery dividers (`ImagerySplitView`, in the scene chrome, teleports each
   before/after divider that `createImagerySplit` publishes to the
   `gev-imagery-split` store to the body; the split keeps the
   drag, keyboard, CSS position and scene split), the status chips
   (the top-center loading status and the road network and camera grid
   chips render what ShellFeedback and CctvControls publish to the
   `gev-status` store; `SplitFlapText` plays the departure-board flip that
   `splitFlap.js` plans, writing only the label's one text node; the toast
   renders what each owner's `createToast()` publishes there, on that
   owner's own timer, and the title bar's FPS readout what
   `createFrameRateMonitor()` publishes), the Scene actions panel (`SceneInteractions`
   teleports what the scene interactions owner publishes to the
   `gev-scene-interactions` store into the viewer's container; the owner
   keeps the pick handler and focuses the picked action), the data-pack
   attribution cards (`DataPacks` teleports what the data-pack presentations
   publish to the `gev-data-packs` store into the viewer's container and
   stops a removed card's player), the wind inspection marker
   (`WindInspectionMarker` teleports the marker into the wind layer's
   container where `createWindInspectionMarker()`, now in
   `src/layers/wind/inspectionMarker.js` so the portable `./tools` entry
   needs no Vue, places it after each rendered frame; an unchanged frame
   publishes nothing), the Space Missions replay vehicle
   (`MissionReplayOverlay` teleports into the globe container what the
   launches layer presents through `subscribeReplayOverlay()`, which the
   application shell publishes to the `gev-mission-replay` store, so the
   portable `./layers/launches` entry needs no Vue), the Bhote Koshi
   reconstruction panel (`BhoteKoshiPanel`, last in the context rail,
   renders what the event layer publishes to the `gev-bhote-koshi-panel`
   store: each control's text, hidden, disabled, value and attributes as
   the layer writes them, unchanged frames sending nothing; the rail takes
   `bhote-event-active` while it shows), the full-globe celestial ring
   (`CelestialRing` teleports into the globe container what `CelestialRing`
   in `src/celestialRing.js` publishes to the `gev-celestial-ring` store and
   hands its two canvases back for the owner to paint; the application shell
   passes the store in, so the keyhole helpers other packages import need no
   Vue), the screen-space map annotations (`ScreenAnnotations` teleports to
   the body the board the screen annotation renderer publishes to the
   `gev-screen-annotations` store after each rendered frame: each mark's SVG
   parts as attribute records, the fading marks until they leave; the view
   hands back the callout text and mark groups the renderer measures, and
   the tracked-entity fade is measured once the frame is in the document;
   the styles it injected now live in `src/ui/styles/annotations.css`), the
   visible map target list (the scene chrome renders the buttons and status
   the world overlay presents through `subscribeWorldOverlayActions()`, which
   the application shell publishes to the `gev-world-overlay-actions` store
   and answers with `activateWorldOverlayAction()`; the module needs no Vue
   for the portable transit entry, and its card and detection canvases stay
   painting surfaces it draws on, like the Cesium canvas), the Global
   Context compass and contact bearings (`AwarenessDirection` teleports into
   the globe container what the awareness layer presents through
   `subscribeDirectionOverlay()`, which the application shell publishes to
   the `gev-awareness-direction` store, so the portable `./layers/awareness`
   entry needs no Vue), the Intel HUD (the `intel-hud` view renders
   `#intel-hud`, its corners, edges and bottom bar from the `gev-hud`
   store, which IntelHUD publishes to through its `publish` option: the
   readouts, the typing summary, the REC blink, visibility, layout variant
   and style colors; the vessel layer presents the selected vessel's
   readout through `src/hudReadouts.js` instead of writing into the HUD),
   the first-run mission launcher (the welcome view renders the card's
   visibility, busy state, status line, copy and scroll fade from the
   `gev-first-run` store that `initFirstRunExperience` publishes to, and its
   choices, DISMISS and "Don't show this again" call the launcher's
   controls; a refused save hands the tick back to the view to revert. The
   launcher still reads the rendered card for its hit test, keyboard trap,
   focus and overflow measurement), then
   Cockpit (in progress: `CockpitBriefing` renders the briefing card's
   pages, cycle toggle, regional news and local conditions, and
   `CockpitContext` the Contact card's scope, navigation, counts, nearest
   contact and weather toggle, `CockpitView` the instruments, destination
   arrow and vision selector, and `CockpitRoute` the flight plan card, from
   the `gev-cockpit` store that the Cockpit controller publishes to,
   starting from `cockpitBriefPages.js`, `cockpitContextState.js` and
   `cockpitInstrumentState.js`, which both read; the odometer readouts
   (`CockpitRollingValue`) keep their throttle and roll in
   `cockpitRollingValue.js`. `CockpitSignalList` renders the live signal
   rows; `v-focus-safe-children` turns Vue's move of the focused row into
   moves of the rows around it, and hands focus to the shown briefing tab
   before the focused row is removed, so a keyed list reorders several times
   a second without dropping keyboard focus. The instruments publish on
   every HUD update (about 10 Hz); in a dev build their Vue patch costs
   about 0.5 ms, close to the DOM writes it replaced. The controller also
   publishes which surfaces are shown: the entry button and TR-3B chip in
   the Context panel, the HUD with its exit and reset buttons and briefing
   card, and the Contact card. Focus moves to the exit button, and back to
   the entry, only after Vue renders them. The cards' collapse is part of
   that presence too: each card's `data-collapsed` and its toggle's words
   and icon render from it. The controls keep the controller's listeners,
   and the cards' layout stays with the controller, which reads their
   visibility when it lays them out.
   `CockpitUtilityControls` renders the Display
   and Radio launchers, which popover is open and the compact Radio
   controls from the `gev-radio` store that RadioControls publishes to and
   answers through; the Display popover's slots stay static for the Cockpit
   display portal).
   Layers that write into the right rail directly gain a slot instead.

4. **Cleanup.** The build-time template expansion is retired: `index.html`
   lists the view hosts and the loading screen itself. The attribute
   translation pass goes with the move to vue-i18n. Hosts register panels
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
