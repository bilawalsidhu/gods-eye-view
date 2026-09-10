// UNTRANSLATED STAGE-3 SEED — Spanish catalog, cockpit namespace.
// Key set mirrors locales/en/cockpit.js exactly; values are still English
// until stage-4 translation (see locales/es/shell.js header for the rules).
export const NAMESPACE = 'cockpit';

export default {
  'hud.sectionLabel': 'Aircraft cockpit view',
  'exit.label': 'EXIT COCKPIT',
  'readout.groundSpeed': 'GROUND SPEED',
  'readout.altitude': 'ALTITUDE',
  'context.kicker': 'CONTACT',
  'context.subjectWindow': 'CONTACTS · 250 KM',
  'brief.kicker': 'LIVE SIGNALS',
  'brief.subtitle': 'OBSERVED / MAPPED PINGS',
  'vision.current': 'CURRENT',
  'radio.station.ready': 'READY',

  // Phase-2 static markup extraction (mirrors locales/en/cockpit.js appendix).
  'presets.activeStyleLabel': 'ACTIVE STYLE',
  'display.cleanViewExitTitle': 'Return UI controls',
  'display.cleanViewExitLabel': 'EXIT CLEAN VIEW',
  'presets.toggleAriaLabel': 'Expand Visual Presets',
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
  'presets.mapSourceLabel': 'MAP SOURCE',
  'presets.mapSourceChipsAriaLabel': 'Map source',
  'presets.miniStyleLabel': 'Style',
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
  'location.toolbarLabel': 'LOCATION',
  'location.collapseTitle': 'Collapse panel',
  'location.pinAriaLabel': 'Pin location tray',
  'location.pinTitle': 'Keep location tray open',
  'location.miniCityInitial': '📍 Location: --',
  'location.miniPoiInitial': 'Landmark: --',
  'location.searchToggleTitle': 'Search any location',
  'location.searchPlaceholder': 'Search any location...',
  'hud.level': 'LEVEL',
  'hud.routeDirectionAriaLabel': 'Estimated destination direction',
  'hud.routeDirectionIdle': 'DEST ---°',
  'hud.visorPlane': 'OPTICAL PLANE · 01',
  'hud.visorLock': 'VISOR LOCK · ACTIVE',
  'hud.firstPerson': 'FIRST PERSON',
  'hud.aircraftMetaInitial': 'LIVE TRACK · COURSE ALIGNED',
  'hud.visionGroupAriaLabel': 'Cockpit vision style',
  'hud.compassAriaLabel': 'Current aircraft heading',
  'readout.rimGroundSpeed': 'GROUND SPEED · KTS',
  'readout.rimAltitude': 'ALTITUDE · FT',
  'vision.previousLabel': 'PREV',
  'vision.previousAriaLabel': 'Previous cockpit vision style',
  'vision.previousTitle': 'Previous vision style',
  'vision.currentAriaLabel': 'Current cockpit vision style: NORMAL. Activate for next style.',
  'vision.currentTitle': 'Current style: NORMAL — click for next',
  'vision.nextLabel': 'NEXT',
  'vision.nextAriaLabel': 'Next cockpit vision style',
  'vision.nextTitle': 'Next vision style',
  'exit.navAriaLabel': 'View switcher',
  'exit.resetAriaLabel': 'Reset cockpit to full globe view',
  'exit.resetTitle': 'Exit cockpit and return to full globe view',
  'exit.resetLabel': 'RESET',
  'exit.ariaLabel': 'Exit cockpit view',
  'exit.title': 'Exit cockpit view',
  'route.cardAriaLabel': 'Estimated flight plan',
  'route.kicker': 'ESTIMATED FLIGHT PLAN',
  'route.statusUnavailable': 'ROUTE DATA UNAVAILABLE',
  'route.fromLabel': 'FROM',
  'route.toLabel': 'TO',
  'route.unknownEndpoint': 'UNKNOWN',
  'brief.carouselAriaLabel': 'Cockpit briefing carousel',
  'brief.actionsAriaLabel': 'Cockpit briefing controls',
  'brief.previousAriaLabel': 'Previous briefing page',
  'brief.previousTitle': 'Previous briefing page',
  'brief.nextAriaLabel': 'Next briefing page',
  'brief.nextTitle': 'Next briefing page',
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

  // ── Phase-3 runtime extraction (src/ui.js), appended ─────────────────────
  // UNTRANSLATED STAGE-3 SEED: same keys as en/cockpit.js, same English
  // values until stage 4.

  // _syncPanelCollapseButton(): composed panel collapse titles. {name} is the
  // panel's own (already localized) .panel-title text.
  'panel.expandTitle': 'Expand {name}',
  'panel.collapseTitle': 'Collapse {name}',
  // Fallback when a panel ships no .panel-title/.pp-header-label node.
  'panel.fallbackName': 'panel',
  // Radio panel collapse state; the expand state reuses the layers.radio.*
  // keys seeded on the static button in phase 2.
  'panel.radioCollapseTitle': 'Collapse Radio',
  'panel.radioCollapseAria': 'Collapse Radio section',
  // _updateLocationMiniStatus(): runtime rewrite of the collapsed LOCATION
  // readout's single-segment search fallback (initial-state keys
  // location.miniCityInitial/miniPoiInitial were seeded in phase 2).
  'location.miniSearchedPlaceholder': 'Searched location',

  // ── Phase-3 runtime extraction batch 2: cockpit + Context renderers ───────
  // UNTRANSLATED STAGE-3 SEED: same keys and English values as en/cockpit.js
  // until stage 4.

  // syncWeatherToggle(): state-sibling keys for the runtime ON/OFF rewrite
  // (context.weatherEnableAriaLabel was seeded on the static button).
  'context.weatherDisableAriaLabel': 'Disable cockpit weather effects',
  'context.weatherStateOn': 'ON',
  'context.weatherStateOff': 'OFF',
  // syncTr3bToggle(): converted-state title sibling of context.tr3bTitle.
  'context.tr3bRestoreTitle': 'Restore real aircraft',
  // setVisionMode(): the style token is dynamic, so the sentence is split out
  // of the seeded vision.currentAriaLabel/currentTitle (whose values pin the
  // NORMAL default) into {style} templates.
  'vision.styleNameNightVision': 'Night vision',
  'vision.styleNameThermal': 'Thermal',
  'vision.styleNameNoir': 'Noir',
  'vision.currentAriaTemplate': 'Current cockpit vision style: {style}. Activate for next style.',
  'vision.currentTitleTemplate': 'Current style: {style} — click for next',

  // Cockpit signal stream (pushCockpitSignal / renderCockpitSignals).
  'signal.trackAcquired': 'TRACK ACQUIRED',
  'signal.trackDetail': '{label} · COURSE {heading}°',
  'signal.selectFlightAria': 'Select flight {title}',
  'signal.contextStandby': 'CONTEXT STANDBY',
  'signal.contextStandbyHint': 'ENABLE GLOBAL CONTEXT FOR PROXIMITY PINGS',
  'signal.contactLostTitle': 'CONTACT LOST · {subject}',
  'signal.contactLostDetail': 'SUBJECT LEFT ITS FEED · READOUT HOLDING LAST KNOWN',
  'signal.classMilitary': 'MILITARY FLIGHT',
  'signal.classCommercial': 'COMMERCIAL FLIGHT',
  'signal.contactCurrent': '{aircraftClass} · CURRENT',
  'signal.contactRange': '{aircraftClass} · {distance}',
  'signal.distanceUnknown': 'DISTANCE UNKNOWN',
  'signal.inputsUnknown': {
    one: '{count} INPUT UNKNOWN',
    other: '{count} INPUTS UNKNOWN',
  },
  'signal.sourceStatusUnavailable': 'SOURCE STATUS UNAVAILABLE',

  // updateHud(): callsign fallback + the composed aircraft meta line (each
  // feed state is its own key so no state can leak English later).
  'hud.fallbackCallsign': 'AIRCRAFT',
  'hud.metaClassMilitary': 'MILITARY',
  'hud.metaClassCommercial': 'COMMERCIAL',
  'hud.metaFeedAcquiringSurface': 'ACQUIRING SURFACE',
  'hud.metaFeedSurfaceFallback': 'SURFACE FALLBACK',
  'hud.metaFeedStale': 'STALE FEED',
  'hud.metaFeedLive': 'LIVE TRACK',
  'hud.aircraftMetaTemplate': '{aircraftClass} · {feedState} · COURSE ALIGNED',

  // updateRoute(): runtime state siblings of the seeded route keys.
  'route.statusArrowEstimated': 'ARROW · ESTIMATED DIRECTION',
  'route.directionLabel': 'DEST {bearing}',

  // updateContext(): uncertainty/nearest/bearing readout states.
  'context.uncertaintyContactLost': 'CONTACT LOST · LAST KNOWN READOUT · NOT AN ALL-CLEAR',
  'context.uncertaintyInputsUnknown': {
    one: '{count} INPUT UNKNOWN · NOT AN ALL-CLEAR',
    other: '{count} INPUTS UNKNOWN · NOT AN ALL-CLEAR',
  },
  'context.uncertaintyInputsCurrent': 'AVAILABLE INPUTS CURRENT · NOT AN ALL-CLEAR',
  'context.nearestTemplate': '{cohort} · {contact}',
  'context.nearestUnavailableAria': '{cohort}, Unavailable',
  'context.bearingNone': 'BRG —',
  'context.bearingAhead': 'AHEAD',
  'context.bearingSide': '{side} {angle}',
  'context.sideLeft': 'L',
  'context.sideRight': 'R',

  // setContextCollapsed()/setSignalCollapsed(): expand-state siblings.
  'context.toggleExpandAriaLabel': 'Expand Contact panel',
  'context.toggleExpandTitle': 'Expand contact panel',
  'brief.expandAriaLabel': 'Expand cockpit briefing panel',
  'brief.expandTitle': 'Expand briefing panel',

  // setBriefAutoRotate(): cycle toggle states + the ON-state help text (the
  // OFF-state help is the seeded brief.autoTitle).
  'brief.autoOn': 'CYCLE ON',
  'brief.autoOff': 'CYCLE OFF',
  'brief.autoTitleOn': 'Stop automatic page cycling. Previous, Next, and the SIG/NEWS/LOCAL tabs stay available.',

  // Briefing carousel pages (kicker/subtitle/source per page; the news/local
  // source lines are provider attribution and stay English).
  'brief.kickerNews': 'REGIONAL NEWS',
  'brief.kickerLocal': 'LOCAL INFO',
  'brief.subtitleNews': 'LATEST LOCATION-MATCHED REPORTING',
  'brief.subtitleLocal': 'PLACE / CONDITIONS / POSITION',

  // Local position + regional brief status states.
  'brief.positionUnavailable': 'POSITION UNAVAILABLE',
  'brief.newsUnavailable': 'REGIONAL NEWS UNAVAILABLE',
  'brief.regionUnavailable': 'REGION UNAVAILABLE',
  'brief.newsEmpty': 'NO RECENT LOCATION MATCHES',

  // renderRegionalBrief(): article metadata, cloud readout, and age chips.
  'brief.metadataSourceFallback': 'SOURCE',
  'brief.articleMetaTemplate': '{domain} · {age}',
  'brief.newsSourceLine': '{source} · LOCATION QUERY',
  'brief.age.timeUnknown': 'TIME UNKNOWN',
  'brief.age.minutes': '{count}M AGO',
  'brief.age.hours': '{count}H AGO',
  'brief.age.days': '{count}D AGO',
  'brief.wind.dirUnknown': 'DIR UNKNOWN',
  'brief.cloudTemplate': 'CLOUD {pct}%',
  'brief.cloudUnknown': 'CLOUD UNKNOWN',

  // ── Phase-3 runtime extraction batch 3: toasts, loading helpers, map tray ─
  // UNTRANSLATED STAGE-3 SEED: same keys and English values as en/cockpit.js
  // until stage 4.

  // Panel-chrome + share/location toasts.
  'panel.layoutResetToast': 'Panel layout updated — positions reset to new defaults',
  'share.toastCopied': 'Link copied!',
  'share.toastCopyFailed': 'Copy failed',
  'location.toastNotFound': 'Location not found',
  'location.toastSearchFailed': 'Search failed',
  'location.toastFlyToPoiFirst': 'Fly to a POI first',
  'actions.clearLayersBusyAria': 'Clearing selected data layers',
  'actions.clearLayersFailedToast': 'Selected data layers could not be cleared',

  // Global status chip notices (_handleShareTrackingRestoreStatus).
  'status.acquiring': 'ACQUIRING',
  'status.subjectFallback': 'entity',
  'status.sharedSubjectDetail': 'SHARED {subject}',
  'status.sharedFollowExpired': 'Shared {subject} follow expired',
  'status.sharedRestoreFailed': 'Shared {subject} could not be restored — feed unavailable',
  'status.sharedUnavailable': 'Shared {subject} is unavailable',

  // Context mode user-facing action failures.
  'context.modeContext': 'Context',
  'context.modeSpaceMissions': 'Space Missions',
  'context.toastStartBlocked': '{mode} could not start because another layer did not stop cleanly',
  'context.toastTransitionFailedContacts': 'Contacts could not complete the requested transition; try again',
  'context.toastTransitionFailedMissions': 'Space Missions could not complete the requested transition; try again',
  'context.toastInstallationsRefreshFailed': 'Nearby installations could not be refreshed; try again',
  'context.toastRestoreFailed': 'Context could not restore every layer; try again',
  'context.toastZoomToSearch': 'Zoom in to search mapped installations',
  'context.toastInstallationsRefreshed': 'Nearby installations refreshed',
  'context.toastLayerUnavailable': 'That layer is unavailable in the current Context mode',
  'context.actionStart': 'start',
  'context.actionStop': 'stop',
  'context.toastLayerLifecycleFailed': '{layerId} could not {action} cleanly',
  'radio.toastLifecycleFailed': 'Radio could not {action} cleanly',

  // CCTV sync chip captions + calibration/availability toasts.
  'cctv.syncLoadingFrames': 'loading frames',
  'cctv.syncGridReady': 'camera grid ready',
  'cctv.toastCalibrationSaved': 'CCTV calibration saved',
  'cctv.toastCalibrationReset': 'CCTV calibration reset',
  'cctv.toastLayerUnavailable': 'CCTV layer unavailable',

  // _renderMapStackState(): status chip fallback when no stack label resolves
  // (stack names themselves are keep-English provider/stack ids).
  'presets.mapStackFallback': 'MAP',

  // ── Phase-3 runtime extraction batch 4: awareness / CCTV / Radio panels ───
  // UNTRANSLATED STAGE-3 SEED: same keys and English values as en/cockpit.js
  // until stage 4.
  // (radio.* and cctv.* state values that layers.js already seeds are reused
  // cross-namespace; these are the runtime-only siblings and compositions.)

  // _applyRuntimeStaticHeaderText(): the key-only standby description span
  // (both mode descriptions in one span split by a literal <br> in phase 2).
  'context.standbyContactsDesc': 'CONTACTS — nearest planes · vessels · sites',
  'context.standbyMissionsDesc': 'SPACE MISSIONS — launches & orbital assets',
  // _syncContextRadioLauncherState(): close-state sibling of the seeded
  // context.radioToggleAriaLabel ('Open compact Radio controls').
  'context.radioToggleCloseAriaLabel': 'Close compact Radio controls',
  'context.toastMissionsCancelRestoreFailed': 'Space Missions cancellation could not restore the previous layer state',
  // Cockpit utility disclosures: collapse-state siblings of the seeded
  // utility.*ToggleAriaLabel expand keys.
  'utility.displayToggleCollapseAriaLabel': 'Collapse Cockpit display options',
  'utility.radioToggleCollapseAriaLabel': 'Collapse Cockpit Radio controls',

  // Radio panel runtime states (state-sibling keys so no state can leak
  // English later; lifecycle enum labels reuse layers.status.*).
  'radio.stateSync': 'SYNC',
  'radio.tunerCategoryBand': '{category} BAND',
  'radio.tunerNoStations': 'NO STATIONS',
  'radio.tunerStationAria': '{name}, station {index} of {total}',
  'radio.tunerNoStationAria': 'No station available',
  'radio.tunerOffAir': 'OFF AIR',
  'radio.tunerStationUnavailable': 'STATION UNAVAILABLE',
  'radio.actionPlay': 'Play',
  'radio.actionPause': 'Pause',
  'radio.actionResume': 'Resume',
  'radio.targetSelected': 'selected',
  'radio.targetNearest': 'nearest',
  'radio.playStateAria': '{action} {target} radio station',
  'radio.miniStateUncertain': 'RADIO STATE UNCERTAIN',
  'radio.miniSyncingDirectory': 'SYNCING DIRECTORY',
  'radio.stationSyncing': 'SYNCING',
  'radio.stationFallback': 'station',
  'radio.playbackReadyFallback': 'Ready',

  // CCTV panel runtime states (layers.cctv.* seeded keys reused where they
  // match; these are the runtime-only compositions and flipped states).
  'cctv.coverageViewshedOn': 'VIEWSHED ON',
  'cctv.frameLoading': 'FRAME · LOADING',
  'cctv.frameUnavailable': 'FRAME · UNAVAILABLE',
  'cctv.calChipEdited': 'CAL · EDITED (UNSAVED)',
  'cctv.calChipTemplate': 'CAL · {badge}',
  'cctv.calBadgeCalibrated': 'CALIBRATED',
  'cctv.calBadgeCurated': 'CURATED',
  'cctv.calBadgeRawPrior': 'RAW PRIOR',
  'cctv.metaProjectionMonitor': 'MONITOR',
  'cctv.metaProjectionOff': 'OFF',
  'cctv.metaTemplate': '{city} · HDG {heading} · FOV {fov} · RANGE {range}m · {projection}{calBadge} · {provider}{status}',
  'cctv.metaCamerasClick': {
    one: '{count} camera loaded · click a camera to activate',
    other: '{count} cameras loaded · click a camera to activate',
  },
  'cctv.metaCamerasEnable': {
    one: '{count} camera loaded · enable CCTV to activate',
    other: '{count} cameras loaded · enable CCTV to activate',
  },
  'cctv.summaryNoneAvailable': 'No summary available.',

  // ── Phase-3 runtime extraction batch 5: remainder + hud.js ────────────────
  // UNTRANSLATED STAGE-3 SEED: same keys and English values as en/cockpit.js
  // until stage 4.

  // _setCelestialRingEnabled(): unsupported-style title sibling of the seeded
  // display.celestialToggleTitle.
  'display.celestialUnavailableTitle': 'Celestial ring — available in Normal style',
  // _updateDetectionButton(): density-profile labels (display.detectionLabel
  // 'DETECT' was seeded on the static button) + composed aria.
  'display.detectionAriaTemplate': 'Detection overlay: {mode}',
  'display.detectionAriaOff': 'Detection overlay: off',
  'display.detectionLabelSparse': 'SPARSE',
  'display.detectionLabelBalanced': 'BALANCED',
  'display.detectionLabelDense': 'DENSE',
  // Globe-reset buttons: idle/working aria states (cockpit variant sibling).
  'hud.resetGlobeAria': 'Reset to full globe view',
  'hud.resetGlobeCockpitAria': 'Reset cockpit to full globe view',
  'hud.resettingGlobeAria': 'Resetting to full globe view',
  'hud.resettingGlobeCockpitAria': 'Resetting cockpit to full globe view',
  // _initOrbit(): indicator caption after the orbit glyph.
  'location.orbitLabel': 'ORBIT',
  // Intel HUD (src/hud.js): summary caption, idle placeholder, REC indicator.
  // Classification banners, terse instrument readout codes (MGRS/GSD/NIIRS/
  // ALT/COLL/ONA/BAND/BITS/LVL), and the AI summary line stay keep-English.
  'hud.summaryLabel': 'SUMMARY',
  'hud.summaryAwaiting': 'Awaiting telemetry...',
  'hud.recLabel': 'REC',
};
