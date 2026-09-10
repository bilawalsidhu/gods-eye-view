// English catalog — cockpit namespace (phase-1 seed).
//
// Owns the first-person cockpit HUD, its Contact summary, and the briefing
// carousel. Keys are namespace-relative; the registry prefixes them with
// `cockpit.`.
export const NAMESPACE = 'cockpit';

export default {
  // index.html #cockpit-hud section aria-label
  'hud.sectionLabel': 'Aircraft cockpit view',
  // index.html #map-view-switch button label
  'exit.label': 'EXIT COCKPIT',
  // index.html .cockpit-readout-label
  'readout.groundSpeed': 'GROUND SPEED',
  'readout.altitude': 'ALTITUDE',
  // index.html .cockpit-context-kicker / #cockpit-context-subject (initial)
  'context.kicker': 'CONTACT',
  'context.subjectWindow': 'CONTACTS · 250 KM',
  // index.html #cockpit-brief-kicker / #cockpit-brief-subtitle (initial)
  'brief.kicker': 'LIVE SIGNALS',
  'brief.subtitle': 'OBSERVED / MAPPED PINGS',
  // index.html #cockpit-vision-current small label
  'vision.current': 'CURRENT',
  // index.html #cockpit-radio-station (initial)
  'radio.station.ready': 'READY',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (ai_docs/i18n-ownership.md cross-surface rule); these keys land here because
  // src/ui.js and src/hud.js own the surfaces' runtime half in phase 3.

  // index.html #style-indicator / #clean-view-exit (visual-style chrome)
  'presets.activeStyleLabel': 'ACTIVE STYLE',
  'display.cleanViewExitTitle': 'Return UI controls',
  'display.cleanViewExitLabel': 'EXIT CLEAN VIEW',

  // index.html control panel — Visual Presets dock tray
  'presets.toggleAriaLabel': 'Expand Visual Presets',
  // Key-only: the .panel-title node shares its element with the dock-label-icon
  // span, so a data-i18n write would wipe the icon; phase 3 wires this via t().
  'presets.title': 'VISUAL PRESETS',
  'presets.pinAriaLabel': 'Pin visual presets',
  'presets.pinTitle': 'Keep visual presets open',
  'presets.styleNormalTitle': 'Show the globe without a visual filter.',
  'presets.styleNormalLabel': 'Normal',
  'presets.styleCrtTitle': 'Emulate a green phosphor CRT with scanlines and screen curvature.',
  'presets.styleCrtLabel': 'CRT',
  'presets.styleNvgTitle': 'Simulate night-vision goggles with green intensification and a tube vignette.',
  'presets.styleNvgLabel': 'NVG',
  'presets.styleFlirTitle': 'Simulate FLIR-style thermal contrast. Turn up Ironbow for color.',
  'presets.styleFlirLabel': 'FLIR',
  'presets.styleAnimeTitle': 'Apply bright cel-shaded color and illustrated outlines.',
  'presets.styleAnimeLabel': 'Anime',
  'presets.styleNoirTitle': 'Apply high-contrast monochrome film-noir grading.',
  'presets.styleNoirLabel': 'Noir',
  'presets.styleSnowTitle': 'Add a cold, snowy whiteout treatment to the scene.',
  'presets.styleSnowLabel': 'Snow',
  // Key-only: the static span text is pinned verbatim by mapStackChips.test.mjs
  // (id="map-source-label">MAP SOURCE<), so no attribute can be added without
  // touching that test; phase 3 owns the swap.
  'presets.mapSourceLabel': 'MAP SOURCE',
  // Key-only: the chip-row tag is pinned literally by mapStackChips.test.mjs.
  'presets.mapSourceChipsAriaLabel': 'Map source',
  'presets.miniStyleLabel': 'Style',

  // index.html #pp-toggles DISPLAY rail
  // Key-only: .pp-header-label text is pinned verbatim by panelStackLayout.test.mjs.
  'display.title': 'DISPLAY',
  'display.collapseTitle': 'Collapse panel',
  'display.hudToggleTitle': 'Intelligence HUD (H)',
  'display.hudLayoutLabel': 'Layout',
  'display.hudLayoutAriaLabel': 'HUD layout',
  'display.hudLayoutTactical': 'Tactical',
  'display.hudLayoutOperator': 'Operator',
  'display.hudLayoutMinimal': 'Minimal',
  'display.detectionToggleTitle': 'Detection Overlay (D)',
  'display.detectionAriaLabel': 'Detection overlay',
  'display.detectionLabel': 'DETECT',
  'display.densityLabel': 'Density',
  'display.densityAriaLabel': 'Detection label density',
  'display.allocationLabel': 'Allocation',
  'display.allocationAriaLabel': 'Detection label allocation',
  'display.allocationElastic': 'Elastic',
  'display.allocationWeighted': 'Weighted',
  'display.fadeLabel': 'Fade',
  'display.fadeAriaLabel': 'Detection fade distance',
  'display.fadeTitle': 'World-overlay fade distance outside the keyhole as a percentage of its radius',
  'display.outsideLabel': 'Outside',
  'display.outsideAriaLabel': 'Detection opacity outside the keyhole',
  'display.outsideTitle': 'World-overlay label and card opacity beyond the fade distance',
  'display.parametersTitle': 'PARAMETERS',
  'display.parametersCollapseTitle': 'Collapse panel',
  'display.modelsToggleTitle': '3D aircraft — flat icons zoomed out, 3D models up close',
  'display.modelsLabel': 'Models',
  'display.modelsCoverageAriaLabel': '3D model coverage',
  'display.modelsModeProximity': 'Proximity',
  'display.modelsModeAll': 'All',
  'display.scopeToggleTitle': 'Scope — the circular viewport mask',
  'display.scopeLabel': 'Scope',
  'display.featherLabel': 'Feather',
  'display.featherTitle': 'Scope edge feather as a percentage of the keyhole radius',
  'display.celestialToggleTitle': 'Celestial ring — reveal the full globe',
  'display.celestialLabel': 'Celestial',
  'display.cleanViewToggleTitle': 'Hide UI chrome',
  'display.cleanViewLabel': 'Clean UI',
  'display.bloomToggleTitle': 'Bloom / Glow',
  'display.bloomLabel': 'Bloom',
  'display.sharpenToggleTitle': 'Sharpening',
  'display.sharpenLabel': 'Sharpen',

  // index.html location bar (dock locations tray; ui.js owns the runtime half)
  // Key-only: .location-toolbar-label shares its element with dock-label-icon.
  'location.toolbarLabel': 'LOCATION',
  'location.collapseTitle': 'Collapse panel',
  'location.pinAriaLabel': 'Pin location tray',
  'location.pinTitle': 'Keep location tray open',
  // Initial mini-status values; ui.js rewrites both once a place resolves.
  'location.miniCityInitial': '📍 Location: --',
  'location.miniPoiInitial': 'Landmark: --',
  'location.searchToggleTitle': 'Search any location',
  'location.searchPlaceholder': 'Search any location...',

  // index.html cockpit HUD statics
  'hud.level': 'LEVEL',
  'hud.routeDirectionAriaLabel': 'Estimated destination direction',
  // Initial idle readout; ui.js rewrites it with a live bearing.
  'hud.routeDirectionIdle': 'DEST ---°',
  'hud.visorPlane': 'OPTICAL PLANE · 01',
  'hud.visorLock': 'VISOR LOCK · ACTIVE',
  'hud.firstPerson': 'FIRST PERSON',
  // Initial meta line; ui.js rewrites it from live track state.
  'hud.aircraftMetaInitial': 'LIVE TRACK · COURSE ALIGNED',
  'hud.visionGroupAriaLabel': 'Cockpit vision style',
  'hud.compassAriaLabel': 'Current aircraft heading',
  'readout.rimGroundSpeed': 'GROUND SPEED · KTS',
  'readout.rimAltitude': 'ALTITUDE · FT',

  // index.html cockpit vision controls
  'vision.previousLabel': 'PREV',
  'vision.previousAriaLabel': 'Previous cockpit vision style',
  'vision.previousTitle': 'Previous vision style',
  // The NORMAL token inside these two is the style name; phase 3 splits the
  // dynamic token out when the runtime half is extracted.
  'vision.currentAriaLabel': 'Current cockpit vision style: NORMAL. Activate for next style.',
  'vision.currentTitle': 'Current style: NORMAL — click for next',
  'vision.nextLabel': 'NEXT',
  'vision.nextAriaLabel': 'Next cockpit vision style',
  'vision.nextTitle': 'Next vision style',

  // index.html view switcher
  'exit.navAriaLabel': 'View switcher',
  'exit.resetAriaLabel': 'Reset cockpit to full globe view',
  'exit.resetTitle': 'Exit cockpit and return to full globe view',
  'exit.resetLabel': 'RESET',
  'exit.ariaLabel': 'Exit cockpit view',
  'exit.title': 'Exit cockpit view',

  // index.html cockpit route card
  'route.cardAriaLabel': 'Estimated flight plan',
  'route.kicker': 'ESTIMATED FLIGHT PLAN',
  'route.statusUnavailable': 'ROUTE DATA UNAVAILABLE',
  'route.fromLabel': 'FROM',
  'route.toLabel': 'TO',
  'route.unknownEndpoint': 'UNKNOWN',

  // index.html cockpit briefing carousel
  // (brief.kicker 'LIVE SIGNALS' is seeded above but is KEY-ONLY: #cockpit-brief-kicker
  // shares its element with the live-dot <i>, so no data-i18n attribute can target it.)
  'brief.carouselAriaLabel': 'Cockpit briefing carousel',
  'brief.actionsAriaLabel': 'Cockpit briefing controls',
  'brief.previousAriaLabel': 'Previous briefing page',
  'brief.previousTitle': 'Previous briefing page',
  'brief.nextAriaLabel': 'Next briefing page',
  'brief.nextTitle': 'Next briefing page',
  // Title is static prose; the visible label + aria-label are CYCLE ON/OFF
  // states that belong to the phase-3 runtime extraction.
  'brief.autoTitle': 'Cycle briefing pages automatically every 9 seconds (Signals → News → Local). Pauses while you hover or focus the panel. Live signal data refreshes continuously either way.',
  'brief.collapseAriaLabel': 'Collapse cockpit briefing panel',
  'brief.collapseTitle': 'Collapse briefing panel',
  'brief.signalsAriaLabel': 'Live signals',
  'brief.newsAriaLabel': 'Latest regional news',
  'brief.localAriaLabel': 'Location-based information',
  'brief.newsAcquiring': 'ACQUIRING REGIONAL NEWS',
  'brief.localResolving': 'RESOLVING REGION',
  'brief.labelTemp': 'TEMP',
  'brief.labelWind': 'WIND',
  'brief.labelSky': 'SKY',
  'brief.labelPrecip': 'PRECIP',
  'brief.sourceNote': 'SOURCE-BACKED EVENTS · NO SYNTHETIC NEWS',
  'brief.tabSignalsAriaLabel': 'Show Live Signals',
  'brief.tabNewsAriaLabel': 'Show Regional News',
  'brief.tabLocalAriaLabel': 'Show Local Info',

  // index.html cockpit context panel (right-rail Global Context included)
  'context.panelAriaLabel': 'Contact cockpit summary',
  'context.navAriaLabel': 'Contact navigation',
  'context.previousAriaLabel': 'Previous — prior visited contact in the 250 km window',
  'context.previousTitle': 'Previous — prior visited contact in the 250 km window',
  'context.nextAriaLabel': 'Next — nearest unvisited contact in the 250 km window',
  'context.nextTitle': 'Next — nearest unvisited contact in the 250 km window',
  'context.toggleAriaLabel': 'Collapse Contact panel',
  'context.toggleTitle': 'Collapse contact panel',
  'context.qualifier': 'CONTEXT ONLY',
  'context.cohortsAriaLabel': 'Nearby cohort counts',
  'context.nearestLabel': 'NEAREST OBSERVED / MAPPED',
  'context.nearestEmpty': 'NO AVAILABLE EXAMPLE',
  'context.uncertaintyNote': 'AVAILABLE INPUTS ONLY · NOT AN ALL-CLEAR',
  'context.weatherEnableAriaLabel': 'Enable cockpit weather effects',
  'context.weatherEnableTitle': 'Enable cockpit weather effects',
  'context.panelTitle': 'CONTEXT',
  'context.collapseTitle': 'Expand panel',
  'context.modesAriaLabel': 'Context mode',
  'context.contactsTabAriaLabel': 'CONTACTS',
  'context.contactsTabTitle': 'Cycles the nearest contacts of whatever type you select — planes, vessels, installations. Satellites track independently.',
  'context.contactsTabLabel': 'CONTACTS',
  'context.missionsTabLabel': 'SPACE MISSIONS',
  'context.standbyTitle': 'SELECT CONTEXT',
  'context.actionsAriaLabel': 'Contact Context actions',
  'context.cockpitEntryLabel': 'COCKPIT',
  'context.searchNearbyLabel': 'SEARCH NEARBY SITES',
  'context.tr3bAriaLabel': 'Reclassify tracked contact as TR-3B',
  'context.tr3bTitle': 'Reclassify as TR-3B',
  'context.awarenessOffTitle': 'CONTACTS CONTEXT OFF',
  'context.awarenessOffHint': 'SELECT CONTACTS TO LOAD OBSERVED / MAPPED PROXIMITY',
  'context.rosterAriaLabel': 'Available Space Missions',
  'context.rosterTitle': 'AVAILABLE MISSIONS',
  'context.rosterHint': 'SELECT A MISSION TO INSPECT',
  'context.rosterLoading': 'LOADING 30-DAY MISSION INDEX',
  'context.radioToggleAriaLabel': 'Open compact Radio controls',
  'context.radioToggleTitle': 'Open compact Radio controls',
  'context.radioMiniGroupAriaLabel': 'Compact Radio controls',
  'context.radioMiniTitle': 'RADIO',
  'context.radioMiniReady': 'RADIO READY',
  'context.radioDetailsAriaLabel': 'Open detailed Radio controls',
  'context.radioDetailsTitle': 'Open detailed Radio controls',
  'context.radioCloseAriaLabel': 'Close compact Radio controls',
  'context.radioCloseTitle': 'Close compact Radio controls',
  'context.radioMiniEnable': 'ENABLE',
  'context.radioMiniPrevAriaLabel': 'Previous filtered radio station',
  'context.radioMiniPrevTitle': 'Previous station',
  'context.radioMiniPlayAriaLabel': 'Play selected radio station',
  'context.radioMiniPlayTitle': 'Play',
  'context.radioMiniNextAriaLabel': 'Next filtered radio station',
  'context.radioMiniNextTitle': 'Next station',
  'context.radioMiniVolumeLabel': 'VOLUME',
  'context.radioMiniVolumeAriaLabel': 'Compact Radio volume',

  // index.html cockpit utility controls + compact radio popover
  'utility.controlsAriaLabel': 'Cockpit display and Radio controls',
  'utility.displayLabel': 'DISPLAY',
  'utility.radioLabel': 'RADIO',
  'utility.displayToggleAriaLabel': 'Expand Cockpit display options',
  'utility.displayToggleTitle': 'Expand Cockpit display options',
  'utility.displayPanelAriaLabel': 'Cockpit display options',
  'utility.radioToggleAriaLabel': 'Expand Cockpit Radio controls',
  'utility.radioToggleTitle': 'Expand Cockpit Radio controls',
  'utility.radioPanelAriaLabel': 'Cockpit compact Radio controls',
  'radio.enable': 'ENABLE',
  'radio.prevAriaLabel': 'Previous filtered radio station',
  'radio.playAriaLabel': 'Play selected radio station',
  'radio.nextAriaLabel': 'Next filtered radio station',
  'radio.volumeLabel': 'VOLUME',
  'radio.volumeAriaLabel': 'Cockpit Radio volume',
};
