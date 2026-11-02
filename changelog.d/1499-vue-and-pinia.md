- The language picker switches language in place instead of reloading the
  page. Views re-render; code that publishes translated text words it again
  through `onLocaleChange` (`src/i18n/index.js`), and `<html lang>`/`dir` and
  the page's `data-i18n` markup follow. `persistLocale` replaces
  `persistLocaleAndReload`, and `registerUnsavedWork` and the switch's
  unsaved-work prompt are removed, since a switch no longer loses anything
  (samehkhamis, #1499).

- A map source's `unavailableReason` may be a function, read when the reason
  is shown so it follows the locale; the sources from `createDefaultMapSources`
  (`./maps/defaults`) give functions. `MapSourceController` reads either form
  (samehkhamis, #1499).

- The application views translate their text with `t()` as they render,
  so it follows the active locale; they no longer carry `data-i18n*`
  attributes, and `npm run i18n` rejects those in a Vue template. The boot
  pass (`applyDocumentTranslations`) still translates static page markup
  such as the loading screen and a host's own markup (samehkhamis, #1499).

- The page's locale lives in a vue-i18n instance installed in every
  application view, and `t()`, `tn()` and the Intl formatters read it from
  there, so a view that translates while rendering renders again when the
  locale changes. `bindLocale` (`src/i18n/index.js`) keeps the locale in a
  given ref; Core's Vite config builds vue-i18n without its message
  compiler. Catalogs, messages and call sites are unchanged
  (samehkhamis, #1499).

- Cockpit's Display popover shows the Display panel's own HUD, Detection,
  Parameters and 3D groups through Vue teleports: `CockpitDisplayPortal`
  publishes the popover's slots (`publish`, with `afterRender` to lay out once
  they have moved) instead of moving the groups itself (samehkhamis, #1499).

- The Cockpit utility strip's measured layout renders from the `gev-cockpit`
  store: the layout pass publishes `utilityLayout` (the HUD's
  `--cockpit-utility-*` lengths, `primaryOnly` and `hideCollapsed`), and a host
  constructing `CockpitController` passes `publish.utilityLayout` beside its
  other publishers (samehkhamis, #1499).

- The Cockpit Contact and briefing cards' collapse renders from the
  `gev-cockpit` store: the controller publishes `contextCollapsed` and
  `signalCollapsed` in its presence, and each card's `data-collapsed` and its
  toggle's state, words and icon follow it (samehkhamis, #1499).

- The panels' own state classes (`collapsed`, `dock-pinned`, `dock-pinned-top`,
  `layout-auto-collapsed`, `accordion-collapsed`) render from the
  `gev-panel-chrome` store: the shell, the rails and the accordion present each
  panel's state there instead of writing its classes. `layoutLeftPanelRail` and
  `layoutRightPanelRail` (`./ui/layout`) now call
  `onCollapse(panel, {collapsed, auto})` and leave drawing it to the host.
  Without a shell to own the panels, the voice tools' `set_panel_open` now
  reports that there is no panel to open instead of writing its classes
  (samehkhamis, #1499).

- The shell's panel chrome no longer writes the panels' collapse buttons, the
  dock tray toggles' names or the dock pins' pressed state: it presents each
  panel's open and pinned state to the `gev-panel-chrome` store, and the
  buttons, now views, call it there. `bindPanelDisclosure` (`./ui/panels`) binds
  only a panel's Escape; it no longer takes `buttons` or `onChange`. `UiButton`
  joins the component kit (samehkhamis, #1499).

- `SceneControls` (`./ui/scenes`) no longer takes `elements` or writes the Scene
  panel's buttons, status, progress or runtime chip: it presents them to the
  `gev-scenes` store and the panel's buttons call its actions there.
  `sceneElements`, `presentSceneButtons`, `presentSceneProgress` and
  `presentSceneRuntime` give way to `sceneButtonsDisabled` and `scenePercent`.
  It no longer stands down when the page has no Scene panel: ESC still stops a
  playing scene and the runtime chip still shows (samehkhamis, #1499).

- `initFirstRunExperience` (via `./application/chrome`) no longer writes the
  launcher's classes, attributes or text, or removes the card: it presents them
  to the welcome view's `gev-first-run` store (its new `store` option) and
  connects the controls the view's buttons call (samehkhamis, #1499).

- `IntelHUD` (`./ui/hud`) no longer builds or writes `#intel-hud`: it hands its
  readouts, visibility, layout variant and style colors to its `publish` option,
  and Core's `intel-hud` view renders them. A page places that view with
  `<div class="gev-view" data-gev-view="intel-hud">` instead of a bare
  `#intel-hud` element. `./layers/vessels` shows the selected vessel's HUD
  readout through `services.readouts.presentSelectedVessel()` instead of writing
  `#hud-ais-vessel`; the application passes `src/hudReadouts.js`, which IntelHUD
  follows (samehkhamis, #1499).

- `LocationControls` (`./ui/location`) no longer builds the city and landmark
  pills or writes the mini status: it presents the tray, including the search
  error (`setSearchError()`), and hands it to its `publish` option, and Core's
  dock renders it and calls `chooseCity()` and `choosePoi()`. Its `elements` are
  now only `search`: `resetButtons` and `searchToggle` are gone, and the reset
  buttons and the search toggle call its new `reset()` and `toggleSearch()`. It
  presents the search field's open and searching state too (`searchExpanded`,
  `searching`; a `searchExpanded` option starts it open), set through
  `setSearching()`, `settleSearch()` and `closeSearch()`, and a host renders the
  field's `expanded` and `searching` classes from it; `LocationSearch` takes a
  `setSearching` option in place of writing the field's class, and
  `NavigationController` a `settleSearch` option in place of `searchInput`.
  `createOrbitIndicator()` is replaced by `showOrbit(active)`, which adds the
  ORBIT indicator to the presented tray as `orbit: { active }` (null until
  offered) (samehkhamis, #1499).

- `createMapSourceControls()` (`./ui/maps`) no longer renders the map source
  chips into a `container` or writes a `statusElement`: it presents the chip row
  and status badge and hands them to its `publish` option, and Core's dock
  renders them and calls `select()`. `renderMapStackChips`, `syncMapStackChips`
  and `MAP_STACK_CHIP_CLASS` are removed (samehkhamis, #1499).

- `./layers/launches` no longer writes the Space Missions roster or the selected
  mission panel into `#space-mission-panel-host`: the layer publishes both
  through `subscribePanel(listener)` and Core's Space Missions views render
  them, calling the layer's panel commands (`selectMissionAt`,
  `selectPreviousMission`, `selectNextMission`, `deselectMission`,
  `focusSelectedLaunchSite`, `startSelectedReplay`, `toggleReplayPause`,
  `cancelReplay`, `setReplaySpeed` and the `roster*` preview inputs). The
  `bindMissionRosterItemKeyboardPreview`, `captureMissionRosterFocus` and
  `restoreMissionRosterFocus` helpers are gone; the roster keeps focus itself
  (samehkhamis, #1499).

- `./layers/awareness` no longer writes the Contacts panel into
  `#military-awareness-panel`: the layer publishes a plain panel view through
  `subscribePanel(listener)` and Core's Contacts view renders it, calling the
  layer's `navigatePrevious`, `focusCurrent`, `navigateNext` and `focusTarget`.
  The `awarenessPanelControlKey`, `captureAwarenessPanelFocus` and
  `restoreAwarenessPanelFocus` helpers are gone; the view keeps focus itself
  (samehkhamis, #1499).

- `./ui/cctv` and `./ui/radio` import Vue and Pinia: their controllers publish
  the panel's state to a store that the CCTV and Radio views render, instead of
  writing the panel's markup themselves (samehkhamis, #1499).

- `./ui/display`'s `bindDisplayControls` is gone: the Display panel's controls
  and the dock's style buttons call their owner through the display store's
  `connect`/`act`, and its allocation and 3D model choices are the kit's
  `UiSegmented`. `initDrawTool` takes `connect(actions)`, which returns their
  disconnect, and no longer listens on the Draw controls; its view publishes
  `color` and `label` too, and the shape choice is a `UiSegmented`.
  `initGeoFileImport` takes `connect(actions)` the same way and no longer
  listens on the Import button, picker or list, nor restores focus itself: the
  `GeoImport` view does both, and its `publish` need not settle once the list
  renders. Street Level's fit and panorama filters and Recent Imagery's mode are
  `UiSegmented` too: the Street Level store's owner answers `setPano` and
  `setRenderMode`, and `RecentImageryReadout` takes `onSetMode`. The Radio
  panel's and Cockpit's internet radio controls and the tuner slider's events
  call `RadioControls`, and the local RTL-SDR card's controls
  `LocalSdrControls`, through the radio store's new `connect`/`act`; the card
  labels its gain options itself. `act` returns what the answering action
  returned. The Display, Radio, RTL-SDR, Cockpit, mission replay, style
  parameter, rail card, observation timeline, imagery opacity, Street Level date
  and Bhote Koshi sliders are the kit's `UiSlider`, a native range input that
  emits numbers, and the pressed toggles are the kit's `UiButton`, which gains
  `pressedClass`; so are the rail card chips, map source chips and location
  pills (which now report `aria-pressed`), and the voice card's chips are the
  kit's new `UiChip`. The selects are the kit's new `UiSelect`, the status
  badges its new `UiBadge` and the one-line empty states its new `UiEmpty`. The
  top-center clear, share, tilt, north-up and reset buttons, and the cockpit's
  reset, call the shell through the new globe actions store, which also carries
  the camera's tilt and compass heading. The recording safe frame renders what
  `RecordingControls` publishes to the new recording store. `syncScopeControls`
  (`./ui/display`), `shouldHideCollapsedRightPanels` (`./ui/layout`),
  `bindClearLayersControl` (`./ui/layers`) and `createStyleParameters`
  (`./ui/input`; the Display panel renders the style parameters VisualSettings
  publishes to the display store) are deprecated: the Display view, the rail and
  the globe actions view now own what they did. `./ui/input` imports Vue
  (samehkhamis, #1499).

- `./scenes` presents the scene sharing dialogs and the EDIT DETAILS / SHARE
  SCENE bar through a store that the scene panels view renders, so a page that
  omits `layer-panels` shows neither (samehkhamis, #1499).

- `./voice/control`'s `createVoiceControl({ panel })` returns the voice
  control's presenter instead of element handles: owners write it by part
  (`update('detail', { text })`) and listen with `on('button', fn)`, and the
  command dock renders it from a store. `createVoiceCommands`' `createControl`
  and `VoiceCardControls` (`{ ui }` instead of `{ root }`) take the same
  presenter; the `reset` option is gone, since a newer control replaces the
  previous one (samehkhamis, #1499).

- Pages place each view with a `<div class="gev-view" data-gev-view="NAME">`
  host and write their own loading screen; the `build/html` template expansion
  and its `gev:template` markers are gone. `createApplication` takes `omitViews`
  (for example `['provider-settings']`) for views an application leaves out
  (samehkhamis, #1499).

- The page's panels, dock, cockpit and dialogs are Vue views with the same
  markup as before. Hosts that do not initialize Core's locale pass
  `localePicker: false` to `createApplicationControls` to drop the language
  picker, and Node tests that import application modules register the component
  loader with `--import=<core>/build/register-vue` (samehkhamis, #1499).

- The Data, Authoring, Weather, Recent Imagery, Context, CCTV, Street Level and
  Radio panels are one component, `UiPanel` (`src/ui/kit/`), with the same
  markup plus the kit's `ui-panel` classes, their titles translated by `t()`
  rather than `data-i18n`; `RailPanel` binds it to the panel chrome store.
  `PanelCollapseButton` drops its `initial` and `initialTitle` props and takes
  `startCollapsed`, so before startup presents a panel its button already shows
  that state's glyph, words and `aria-expanded` (samehkhamis, #1499).

- The Authoring, shot list and CCTV buttons and Street Level's nearest button
  are the kit's `UiButton` (danger buttons in the `alert` tone, primary ones the
  `primary` variant), keeping their classes; the CCTV on/off, coverage,
  auto-hop, projection and adjust toggles now say their state with
  `aria-pressed` (samehkhamis, #1499).

- Each desktop sidebar has an icon rail that lists every panel on that side and
  opens one with a click. One panel is open per side in every HUD layout, so the
  collapsed panel headers no longer take up the sidebars. Phones keep the bottom
  tab bar. The rail is the first view built with Vue and Pinia, which now ship
  with the app; see docs/VUE-MIGRATION.md (samehkhamis, #1499).
