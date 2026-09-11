// Français international neutre (fr). Glossaire : docs/TRANSLATORS.md.
export const NAMESPACE = 'cockpit';

export default {
  // index.html #cockpit-hud section aria-label
  'hud.sectionLabel': 'Vue du cockpit de l’aéronef',
  // index.html #map-view-switch button label
  'exit.label': 'QUITTER LE COCKPIT',
  // index.html .cockpit-readout-label
  'readout.groundSpeed': 'VITESSE SOL',
  'readout.altitude': 'ALTITUDE',
  // index.html .cockpit-context-kicker / #cockpit-context-subject (initial)
  'context.kicker': 'CONTACT',
  'context.subjectWindow': 'CONTACTS · 250 KM',
  // index.html #cockpit-brief-kicker / #cockpit-brief-subtitle (initial)
  'brief.kicker': 'SIGNAUX EN DIRECT',
  'brief.subtitle': 'PINGS OBSERVÉS / CARTOGRAPHIÉS',
  // index.html #cockpit-vision-current small label
  'vision.current': 'ACTUEL',
  // index.html #cockpit-radio-station (initial)
  'radio.station.ready': 'PRÊTE',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (ai_docs/i18n-ownership.md cross-surface rule); these keys land here because
  // src/ui.js and src/hud.js own the surfaces' runtime half in phase 3.

  // index.html #style-indicator / #clean-view-exit (visual-style chrome)
  'presets.activeStyleLabel': 'STYLE ACTUEL',
  'display.cleanViewExitTitle': 'Réafficher les commandes de l’interface',
  'display.cleanViewExitLabel': 'QUITTER LA VUE ÉPURÉE',

  // index.html control panel — Visual Presets dock tray
  'presets.toggleAriaLabel': 'Développer les Préréglages visuels',
  // Key-only: the .panel-title node shares its element with the dock-label-icon
  // span, so a data-i18n write would wipe the icon; phase 3 wires this via t().
  'presets.title': 'PRÉRÉGLAGES VISUELS',
  'presets.pinAriaLabel': 'Épingler les Préréglages visuels',
  'presets.pinTitle': 'Garder les Préréglages visuels ouverts',
  'presets.styleNormalTitle': 'Affiche le globe sans filtre visuel.',
  'presets.styleNormalLabel': 'Normal',
  'presets.styleCrtTitle': 'Émule un CRT à phosphore vert avec lignes de balayage et courbure d’écran.',
  'presets.styleCrtLabel': 'CRT',
  'presets.styleNvgTitle': 'Simule des jumelles de vision nocturne avec intensification verte et vignettage de tube.',
  'presets.styleNvgLabel': 'NVG',
  'presets.styleFlirTitle': 'Simule un contraste thermique façon FLIR. Augmentez Ironbow pour la couleur.',
  'presets.styleFlirLabel': 'FLIR',
  'presets.styleAnimeTitle': 'Applique des couleurs vives en cel-shading et des contours illustrés.',
  'presets.styleAnimeLabel': 'Anime',
  'presets.styleNoirTitle': 'Applique un étalonnage monochrome à haut contraste façon film noir.',
  'presets.styleNoirLabel': 'Noir',
  'presets.styleSnowTitle': 'Ajoute à la scène un traitement froid de blancheur aveuglante.',
  'presets.styleSnowLabel': 'Neige',
  // Key-only: the static span text is pinned verbatim by mapStackChips.test.mjs
  // (id="map-source-label">MAP SOURCE<), so no attribute can be added without
  // touching that test; phase 3 owns the swap.
  'presets.mapSourceLabel': 'SOURCE DE LA CARTE',
  // Key-only: the chip-row tag is pinned literally by mapStackChips.test.mjs.
  'presets.mapSourceChipsAriaLabel': 'Source de la carte',
  'presets.miniStyleLabel': 'Style',

  // index.html #pp-toggles DISPLAY rail
  // Key-only: .pp-header-label text is pinned verbatim by panelStackLayout.test.mjs.
  'display.title': 'AFFICHAGE',
  'display.collapseTitle': 'Réduire le panneau',
  'display.hudToggleTitle': 'HUD de renseignement (H)',
  'display.hudLayoutLabel': 'Disposition',
  'display.hudLayoutAriaLabel': 'Disposition du HUD',
  'display.hudLayoutTactical': 'Tactique',
  'display.hudLayoutOperator': 'Opérateur',
  'display.hudLayoutMinimal': 'Minimal',
  'display.detectionToggleTitle': 'Superposition de détection (D)',
  'display.detectionAriaLabel': 'Superposition de détection',
  'display.detectionLabel': 'DÉTECTER',
  'display.densityLabel': 'Densité',
  'display.densityAriaLabel': 'Densité des étiquettes de détection',
  'display.allocationLabel': 'Affectation',
  'display.allocationAriaLabel': 'Affectation des étiquettes de détection',
  'display.allocationElastic': 'Élastique',
  'display.allocationWeighted': 'Pondérée',
  'display.fadeLabel': 'Fondu',
  'display.fadeAriaLabel': 'Distance de fondu de la détection',
  'display.fadeTitle': 'Distance de fondu de la superposition du monde hors du hublot, en pourcentage de son rayon',
  'display.outsideLabel': 'Extérieur',
  'display.outsideAriaLabel': 'Opacité de la détection hors du hublot',
  'display.outsideTitle': 'Opacité des étiquettes et cartes de la superposition du monde au-delà de la distance de fondu',
  'display.parametersTitle': 'PARAMÈTRES',
  'display.parametersCollapseTitle': 'Réduire le panneau',
  'display.modelsToggleTitle': 'Aéronefs 3D — icônes plates de loin, modèles 3D de près',
  'display.modelsLabel': 'Modèles',
  'display.modelsCoverageAriaLabel': 'Couverture des modèles 3D',
  'display.modelsModeProximity': 'Proximité',
  'display.modelsModeAll': 'Tous',
  'display.scopeToggleTitle': 'Viseur — le masque circulaire du champ de vision',
  'display.scopeLabel': 'Viseur',
  'display.featherLabel': 'Adoucissement',
  'display.featherTitle': 'Adoucissement du bord du viseur, en pourcentage du rayon du hublot',
  'display.celestialToggleTitle': 'Anneau céleste — révèle le globe complet',
  'display.celestialLabel': 'Céleste',
  'display.cleanViewToggleTitle': 'Masquer l’habillage de l’interface',
  'display.cleanViewLabel': 'Interface épurée',
  'display.bloomToggleTitle': 'Bloom / Éclat',
  'display.bloomLabel': 'Bloom',
  'display.sharpenToggleTitle': 'Netteté',
  'display.sharpenLabel': 'Netteté',

  // index.html location bar (dock locations tray; ui.js owns the runtime half)
  // Key-only: .location-toolbar-label shares its element with dock-label-icon.
  'location.toolbarLabel': 'POSITION',
  'location.collapseTitle': 'Réduire le panneau',
  'location.pinAriaLabel': 'Épingler le volet Position',
  'location.pinTitle': 'Garder le volet Position ouvert',
  // Initial mini-status values; ui.js rewrites both once a place resolves.
  'location.miniCityInitial': '📍 Position : --',
  'location.miniPoiInitial': 'Point d’intérêt : --',
  'location.searchToggleTitle': 'Rechercher une position',
  'location.searchPlaceholder': 'Rechercher une position...',

  // index.html cockpit HUD statics
  'hud.level': 'NIVEAU',
  'hud.routeDirectionAriaLabel': 'Direction estimée de la destination',
  // Initial idle readout; ui.js rewrites it with a live bearing.
  'hud.routeDirectionIdle': 'DEST ---°',
  'hud.visorPlane': 'PLAN OPTIQUE · 01',
  'hud.visorLock': 'VERROUILLAGE DE VISIÈRE · ACTIF',
  'hud.firstPerson': 'PREMIÈRE PERSONNE',
  // Initial meta line; ui.js rewrites it from live track state.
  'hud.aircraftMetaInitial': 'SUIVI EN DIRECT · CAP ALIGNÉ',
  'hud.visionGroupAriaLabel': 'Style de vision du cockpit',
  'hud.compassAriaLabel': 'Cap actuel de l’aéronef',
  'readout.rimGroundSpeed': 'VITESSE SOL · KTS',
  'readout.rimAltitude': 'ALTITUDE · FT',

  // index.html cockpit vision controls
  'vision.previousLabel': 'PRÉC',
  'vision.previousAriaLabel': 'Style de vision précédent du cockpit',
  'vision.previousTitle': 'Style de vision précédent',
  // The NORMAL token inside these two is the style name; phase 3 splits the
  // dynamic token out when the runtime half is extracted.
  'vision.currentAriaLabel': 'Style de vision du cockpit actuel : NORMAL. Activez pour passer au style suivant.',
  'vision.currentTitle': 'Style actuel : NORMAL — cliquez pour le suivant',
  'vision.nextLabel': 'SUIV',
  'vision.nextAriaLabel': 'Style de vision suivant du cockpit',
  'vision.nextTitle': 'Style de vision suivant',

  // index.html view switcher
  'exit.navAriaLabel': 'Sélecteur de vues',
  'exit.resetAriaLabel': 'Réinitialiser le cockpit sur la vue complète du globe',
  'exit.resetTitle': 'Quitter le cockpit et revenir à la vue complète du globe',
  'exit.resetLabel': 'RÉINITIALISER',
  'exit.ariaLabel': 'Quitter la vue cockpit',
  'exit.title': 'Quitter la vue cockpit',

  // index.html cockpit route card
  'route.cardAriaLabel': 'Plan de vol estimé',
  'route.kicker': 'PLAN DE VOL ESTIMÉ',
  'route.statusUnavailable': 'DONNÉES DE ROUTE INDISPONIBLES',
  'route.fromLabel': 'DE',
  'route.toLabel': 'VERS',
  'route.unknownEndpoint': 'INCONNU',

  // index.html cockpit briefing carousel
  // (brief.kicker 'LIVE SIGNALS' is seeded above but is KEY-ONLY: #cockpit-brief-kicker
  // shares its element with the live-dot <i>, so no data-i18n attribute can target it.)
  'brief.carouselAriaLabel': 'Carrousel de briefing du cockpit',
  'brief.actionsAriaLabel': 'Commandes de briefing du cockpit',
  'brief.previousAriaLabel': 'Page de briefing précédente',
  'brief.previousTitle': 'Page de briefing précédente',
  'brief.nextAriaLabel': 'Page de briefing suivante',
  'brief.nextTitle': 'Page de briefing suivante',
  // Title is static prose; the visible label + aria-label are CYCLE ON/OFF
  // states that belong to the phase-3 runtime extraction.
  'brief.autoTitle': 'Fait défiler automatiquement les pages de briefing toutes les 9 secondes (Signaux → Actualités → Local). Se met en pause pendant le survol ou le focus du panneau. Les données de signaux en direct s’actualisent en continu dans tous les cas.',
  'brief.collapseAriaLabel': 'Réduire le panneau de briefing du cockpit',
  'brief.collapseTitle': 'Réduire le panneau de briefing',
  'brief.signalsAriaLabel': 'Signaux en direct',
  'brief.newsAriaLabel': 'Dernières actualités régionales',
  'brief.localAriaLabel': 'Informations liées à la position',
  'brief.newsAcquiring': 'RÉCUPÉRATION DES ACTUALITÉS RÉGIONALES',
  'brief.localResolving': 'DÉTERMINATION DE LA RÉGION',
  'brief.labelTemp': 'TEMP',
  'brief.labelWind': 'VENT',
  'brief.labelSky': 'CIEL',
  'brief.labelPrecip': 'PRÉCIP',
  'brief.sourceNote': 'ÉVÉNEMENTS SOURCÉS · AUCUNE ACTUALITÉ SYNTHÉTIQUE',
  'brief.tabSignalsAriaLabel': 'Afficher les signaux en direct',
  'brief.tabNewsAriaLabel': 'Afficher les actualités régionales',
  'brief.tabLocalAriaLabel': 'Afficher les infos locales',

  // index.html cockpit context panel (right-rail Global Context included)
  'context.panelAriaLabel': 'Résumé du contact dans le cockpit',
  'context.navAriaLabel': 'Navigation parmi les contacts',
  'context.previousAriaLabel': 'Précédent — contact déjà visité dans la fenêtre de 250 km',
  'context.previousTitle': 'Précédent — contact déjà visité dans la fenêtre de 250 km',
  'context.nextAriaLabel': 'Suivant — contact non visité le plus proche dans la fenêtre de 250 km',
  'context.nextTitle': 'Suivant — contact non visité le plus proche dans la fenêtre de 250 km',
  'context.toggleAriaLabel': 'Réduire le panneau Contact',
  'context.toggleTitle': 'Réduire le panneau Contact',
  'context.qualifier': 'CONTEXTE UNIQUEMENT',
  'context.cohortsAriaLabel': 'Effectifs des groupes à proximité',
  'context.nearestLabel': 'PLUS PROCHE OBSERVÉ / CARTOGRAPHIÉ',
  'context.nearestEmpty': 'AUCUN EXEMPLE DISPONIBLE',
  'context.uncertaintyNote': 'DONNÉES DISPONIBLES UNIQUEMENT · NE SIGNIFIE PAS TOUT DÉGAGÉ',
  'context.weatherEnableAriaLabel': 'Activer les effets météo du cockpit',
  'context.weatherEnableTitle': 'Activer les effets météo du cockpit',
  'context.panelTitle': 'CONTEXTE',
  'context.collapseTitle': 'Développer le panneau',
  'context.modesAriaLabel': 'Mode de contexte',
  'context.contactsTabAriaLabel': 'CONTACTS',
  'context.contactsTabTitle': 'Fait défiler les contacts les plus proches du type choisi — avions, navires, installations. Le suivi des satellites est indépendant.',
  'context.contactsTabLabel': 'CONTACTS',
  'context.missionsTabLabel': 'MISSIONS SPATIALES',
  'context.standbyTitle': 'SÉLECTIONNER LE CONTEXTE',
  'context.actionsAriaLabel': 'Actions de contexte du contact',
  'context.cockpitEntryLabel': 'COCKPIT',
  'context.searchNearbyLabel': 'RECHERCHER LES SITES PROCHES',
  'context.tr3bAriaLabel': 'Reclasser le contact suivi en TR-3B',
  'context.tr3bTitle': 'Reclasser en TR-3B',
  'context.awarenessOffTitle': 'CONTEXTE DES CONTACTS DÉSACTIVÉ',
  'context.awarenessOffHint': 'SÉLECTIONNEZ DES CONTACTS POUR CHARGER LA PROXIMITÉ OBSERVÉE / CARTOGRAPHIÉE',
  'context.rosterAriaLabel': 'Missions spatiales disponibles',
  'context.rosterTitle': 'MISSIONS DISPONIBLES',
  'context.rosterHint': 'SÉLECTIONNEZ UNE MISSION POUR L’INSPECTER',
  'context.rosterLoading': 'CHARGEMENT DE L’INDEX DES MISSIONS SUR 30 JOURS',
  'context.radioToggleAriaLabel': 'Ouvrir les commandes Radio compactes',
  'context.radioToggleTitle': 'Ouvrir les commandes Radio compactes',
  'context.radioMiniGroupAriaLabel': 'Commandes Radio compactes',
  'context.radioMiniTitle': 'RADIO',
  'context.radioMiniReady': 'RADIO PRÊTE',
  'context.radioDetailsAriaLabel': 'Ouvrir les commandes Radio détaillées',
  'context.radioDetailsTitle': 'Ouvrir les commandes Radio détaillées',
  'context.radioCloseAriaLabel': 'Fermer les commandes Radio compactes',
  'context.radioCloseTitle': 'Fermer les commandes Radio compactes',
  'context.radioMiniEnable': 'ACTIVER',
  'context.radioMiniPrevAriaLabel': 'Station de radio filtrée précédente',
  'context.radioMiniPrevTitle': 'Station précédente',
  'context.radioMiniPlayAriaLabel': 'Lire la station de radio sélectionnée',
  'context.radioMiniPlayTitle': 'Lire',
  'context.radioMiniNextAriaLabel': 'Station de radio filtrée suivante',
  'context.radioMiniNextTitle': 'Station suivante',
  'context.radioMiniVolumeLabel': 'VOLUME',
  'context.radioMiniVolumeAriaLabel': 'Volume de la Radio compacte',

  // index.html cockpit utility controls + compact radio popover
  'utility.controlsAriaLabel': 'Commandes d’affichage et de Radio du cockpit',
  'utility.displayLabel': 'AFFICHAGE',
  'utility.radioLabel': 'RADIO',
  'utility.displayToggleAriaLabel': 'Développer les options d’affichage du cockpit',
  'utility.displayToggleTitle': 'Développer les options d’affichage du cockpit',
  'utility.displayPanelAriaLabel': 'Options d’affichage du cockpit',
  'utility.radioToggleAriaLabel': 'Développer les commandes Radio du cockpit',
  'utility.radioToggleTitle': 'Développer les commandes Radio du cockpit',
  'utility.radioPanelAriaLabel': 'Commandes Radio compactes du cockpit',
  'radio.enable': 'ACTIVER',
  'radio.prevAriaLabel': 'Station de radio filtrée précédente',
  'radio.playAriaLabel': 'Lire la station de radio sélectionnée',
  'radio.nextAriaLabel': 'Station de radio filtrée suivante',
  'radio.volumeLabel': 'VOLUME',
  'radio.volumeAriaLabel': 'Volume de la Radio du cockpit',

  // ── Phase-3 runtime extraction (src/ui.js), appended ─────────────────────
  // Values stay byte-identical to the previous English literals; existing
  // tests pin many of them under the default locale.

  // _syncPanelCollapseButton(): composed panel collapse titles. {name} is the
  // panel's own (already localized) .panel-title text.
  'panel.expandTitle': 'Développer {name}',
  'panel.collapseTitle': 'Réduire {name}',
  // Fallback when a panel ships no .panel-title/.pp-header-label node.
  'panel.fallbackName': 'panneau',
  // Radio panel collapse state; the expand state reuses the layers.radio.*
  // keys seeded on the static button in phase 2.
  'panel.radioCollapseTitle': 'Réduire Radio',
  'panel.radioCollapseAria': 'Réduire la section Radio',
  // _updateLocationMiniStatus(): runtime rewrite of the collapsed LOCATION
  // readout's single-segment search fallback (initial-state keys
  // location.miniCityInitial/miniPoiInitial were seeded in phase 2).
  'location.miniSearchedPlaceholder': 'Position recherchée',

  // ── Phase-3 runtime extraction batch 2: cockpit + Context renderers ───────

  // syncWeatherToggle(): state-sibling keys for the runtime ON/OFF rewrite
  // (context.weatherEnableAriaLabel was seeded on the static button).
  'context.weatherDisableAriaLabel': 'Désactiver les effets météo du cockpit',
  'context.weatherStateOn': 'ACTIVÉ',
  'context.weatherStateOff': 'DÉSACTIVÉ',
  // syncTr3bToggle(): converted-state title sibling of context.tr3bTitle.
  'context.tr3bRestoreTitle': 'Restaurer l’aéronef réel',
  // setVisionMode(): the style token is dynamic, so the sentence is split out
  // of the seeded vision.currentAriaLabel/currentTitle (whose values pin the
  // NORMAL default) into {style} templates.
  'vision.styleNameNightVision': 'Vision nocturne',
  'vision.styleNameThermal': 'Thermique',
  'vision.styleNameNoir': 'Noir',
  'vision.currentAriaTemplate': 'Style de vision du cockpit actuel : {style}. Activez pour passer au style suivant.',
  'vision.currentTitleTemplate': 'Style actuel : {style} — cliquez pour le suivant',

  // Cockpit signal stream (pushCockpitSignal / renderCockpitSignals).
  'signal.trackAcquired': 'SUIVI ACQUIS',
  'signal.trackDetail': '{label} · CAP {heading}°',
  'signal.selectFlightAria': 'Sélectionner le vol {title}',
  'signal.contextStandby': 'CONTEXTE EN VEILLE',
  'signal.contextStandbyHint': 'ACTIVEZ LE CONTEXTE GLOBAL POUR LES PINGS DE PROXIMITÉ',
  'signal.contactLostTitle': 'CONTACT PERDU · {subject}',
  'signal.contactLostDetail': 'LE SUJET A QUITTÉ SON FLUX · L’AFFICHAGE CONSERVE LE DERNIER ÉTAT CONNU',
  'signal.classMilitary': 'VOL MILITAIRE',
  'signal.classCommercial': 'VOL COMMERCIAL',
  'signal.contactCurrent': '{aircraftClass} · ACTUEL',
  'signal.contactRange': '{aircraftClass} · {distance}',
  'signal.distanceUnknown': 'DISTANCE INCONNUE',
  'signal.inputsUnknown': {
    one: '{count} DONNÉE INCONNUE',
    other: '{count} DONNÉES INCONNUES',
  },
  'signal.sourceStatusUnavailable': 'ÉTAT DE LA SOURCE INDISPONIBLE',

  // updateHud(): callsign fallback + the composed aircraft meta line (each
  // feed state is its own key so no state can leak English later).
  'hud.fallbackCallsign': 'AÉRONEF',
  'hud.metaClassMilitary': 'MILITAIRE',
  'hud.metaClassCommercial': 'COMMERCIAL',
  'hud.metaFeedAcquiringSurface': 'ACQUISITION DE LA SURFACE',
  'hud.metaFeedSurfaceFallback': 'SURFACE DE REPLI',
  'hud.metaFeedStale': 'FLUX PÉRIMÉ',
  'hud.metaFeedLive': 'SUIVI EN DIRECT',
  'hud.aircraftMetaTemplate': '{aircraftClass} · {feedState} · CAP ALIGNÉ',

  // updateRoute(): runtime state siblings of the seeded route keys.
  'route.statusArrowEstimated': 'FLÈCHE · DIRECTION ESTIMÉE',
  'route.directionLabel': 'DEST {bearing}',

  // updateContext(): uncertainty/nearest/bearing readout states.
  'context.uncertaintyContactLost': 'CONTACT PERDU · DERNIER AFFICHAGE CONNU · NE SIGNIFIE PAS TOUT DÉGAGÉ',
  'context.uncertaintyInputsUnknown': {
    one: '{count} DONNÉE INCONNUE · NE SIGNIFIE PAS TOUT DÉGAGÉ',
    other: '{count} DONNÉES INCONNUES · NE SIGNIFIE PAS TOUT DÉGAGÉ',
  },
  'context.uncertaintyInputsCurrent': 'DONNÉES DISPONIBLES À JOUR · NE SIGNIFIE PAS TOUT DÉGAGÉ',
  'context.nearestTemplate': '{cohort} · {contact}',
  'context.nearestUnavailableAria': '{cohort}, indisponible',
  'context.bearingNone': 'BRG —',
  'context.bearingAhead': 'DEVANT',
  'context.bearingSide': '{side} {angle}',
  'context.sideLeft': 'G',
  'context.sideRight': 'D',

  // setContextCollapsed()/setSignalCollapsed(): expand-state siblings.
  'context.toggleExpandAriaLabel': 'Développer le panneau Contact',
  'context.toggleExpandTitle': 'Développer le panneau Contact',
  'brief.expandAriaLabel': 'Développer le panneau de briefing du cockpit',
  'brief.expandTitle': 'Développer le panneau de briefing',

  // setBriefAutoRotate(): cycle toggle states + the ON-state help text (the
  // OFF-state help is the seeded brief.autoTitle).
  'brief.autoOn': 'CYCLE ACTIVÉ',
  'brief.autoOff': 'CYCLE DÉSACTIVÉ',
  'brief.autoTitleOn': 'Arrêtez le défilement automatique des pages. Précédent, Suivant et les onglets SIG/NEWS/LOCAL restent disponibles.',

  // Briefing carousel pages (kicker/subtitle/source per page; the news/local
  // source lines are provider attribution and stay English).
  'brief.kickerNews': 'ACTUALITÉS RÉGIONALES',
  'brief.kickerLocal': 'INFOS LOCALES',
  'brief.subtitleNews': 'DERNIERS REPORTAGES CORRESPONDANT À LA POSITION',
  'brief.subtitleLocal': 'LIEU / CONDITIONS / POSITION',

  // Local position + regional brief status states.
  'brief.positionUnavailable': 'POSITION INDISPONIBLE',
  'brief.newsUnavailable': 'ACTUALITÉS RÉGIONALES INDISPONIBLES',
  'brief.regionUnavailable': 'RÉGION INDISPONIBLE',
  'brief.newsEmpty': 'AUCUNE CORRESPONDANCE RÉCENTE POUR LA POSITION',

  // renderRegionalBrief(): article metadata, cloud readout, and age chips.
  'brief.metadataSourceFallback': 'SOURCE',
  'brief.articleMetaTemplate': '{domain} · {age}',
  'brief.newsSourceLine': '{source} · RECHERCHE PAR POSITION',
  'brief.age.timeUnknown': 'HEURE INCONNUE',
  'brief.age.minutes': 'IL Y A {count} M',
  'brief.age.hours': 'IL Y A {count} H',
  'brief.age.days': 'IL Y A {count} J',
  'brief.wind.dirUnknown': 'DIR INCONNUE',
  'brief.cloudTemplate': 'NUAGES {pct}%',
  'brief.cloudUnknown': 'NUAGES INCONNUS',

  // ── Phase-3 runtime extraction batch 3: toasts, loading helpers, map tray ─

  // Panel-chrome + share/location toasts.
  'panel.layoutResetToast': 'Disposition des panneaux mise à jour — positions réinitialisées aux nouvelles valeurs par défaut',
  'share.toastCopied': 'Lien copié !',
  'share.toastCopyFailed': 'Échec de la copie',
  'location.toastNotFound': 'Position introuvable',
  'location.toastSearchFailed': 'Échec de la recherche',
  'location.toastFlyToPoiFirst': 'Survolez d’abord un point d’intérêt',
  'actions.clearLayersBusyAria': 'Effacement des couches de données sélectionnées',
  'actions.clearLayersFailedToast': 'Impossible d’effacer les couches de données sélectionnées',

  // Global status chip notices (_handleShareTrackingRestoreStatus).
  'status.acquiring': 'ACQUISITION',
  'status.subjectFallback': 'sujet',
  'status.sharedSubjectDetail': '{subject} PARTAGÉ',
  'status.sharedFollowExpired': 'Le suivi partagé de {subject} a expiré',
  'status.sharedRestoreFailed': 'Impossible de restaurer {subject} partagé — flux indisponible',
  'status.sharedUnavailable': '{subject} partagé est indisponible',

  // Context mode user-facing action failures.
  'context.modeContext': 'Contexte',
  'context.modeSpaceMissions': 'Missions spatiales',
  'context.toastStartBlocked': '{mode} n’a pas pu démarrer car une autre couche ne s’est pas arrêtée proprement',
  'context.toastTransitionFailedContacts': 'Contacts n’a pas pu effectuer la transition demandée ; réessayez',
  'context.toastTransitionFailedMissions': 'Missions spatiales n’a pas pu effectuer la transition demandée ; réessayez',
  'context.toastInstallationsRefreshFailed': 'Impossible d’actualiser les installations à proximité ; réessayez',
  'context.toastRestoreFailed': 'Contexte n’a pas pu restaurer toutes les couches ; réessayez',
  'context.toastZoomToSearch': 'Zoomez pour rechercher les installations cartographiées',
  'context.toastInstallationsRefreshed': 'Installations à proximité actualisées',
  'context.toastLayerUnavailable': 'Cette couche est indisponible dans le mode Contexte actuel',
  'context.actionStart': 'démarrer',
  'context.actionStop': 'arrêter',
  'context.toastLayerLifecycleFailed': '{layerId} n’a pas pu {action} proprement',
  'radio.toastLifecycleFailed': 'Radio n’a pas pu {action} proprement',

  // CCTV sync chip captions + calibration/availability toasts.
  'cctv.syncLoadingFrames': 'chargement des images',
  'cctv.syncGridReady': 'grille de caméras prête',
  'cctv.toastCalibrationSaved': 'Calibration CCTV enregistrée',
  'cctv.toastCalibrationReset': 'Calibration CCTV réinitialisée',
  'cctv.toastLayerUnavailable': 'Couche CCTV indisponible',

  // _renderMapStackState(): status chip fallback when no stack label resolves
  // (stack names themselves are keep-English provider/stack ids).
  'presets.mapStackFallback': 'CARTE',

  // ── Phase-3 runtime extraction batch 4: awareness / CCTV / Radio panels ───
  // (radio.* and cctv.* state values that layers.js already seeds are reused
  // cross-namespace; these are the runtime-only siblings and compositions.)

  // _applyRuntimeStaticHeaderText(): the key-only standby description span
  // (both mode descriptions in one span split by a literal <br> in phase 2).
  'context.standbyContactsDesc': 'CONTACTS — avions · navires · sites les plus proches',
  'context.standbyMissionsDesc': 'MISSIONS SPATIALES — lancements et actifs orbitaux',
  // _syncContextRadioLauncherState(): close-state sibling of the seeded
  // context.radioToggleAriaLabel ('Open compact Radio controls').
  'context.radioToggleCloseAriaLabel': 'Fermer les commandes Radio compactes',
  'context.toastMissionsCancelRestoreFailed': 'L’annulation des Missions spatiales n’a pas pu restaurer l’état précédent des couches',
  // Cockpit utility disclosures: collapse-state siblings of the seeded
  // utility.*ToggleAriaLabel expand keys.
  'utility.displayToggleCollapseAriaLabel': 'Réduire les options d’affichage du cockpit',
  'utility.radioToggleCollapseAriaLabel': 'Réduire les commandes Radio du cockpit',

  // Radio panel runtime states (state-sibling keys so no state can leak
  // English later; lifecycle enum labels reuse layers.status.*).
  'radio.stateSync': 'SYNCHRO',
  'radio.tunerCategoryBand': 'BANDE {category}',
  'radio.tunerNoStations': 'AUCUNE STATION',
  'radio.tunerStationAria': '{name}, station {index} sur {total}',
  'radio.tunerNoStationAria': 'Aucune station disponible',
  'radio.tunerOffAir': 'HORS ANTENNE',
  'radio.tunerStationUnavailable': 'STATION INDISPONIBLE',
  'radio.actionPlay': 'Lire',
  'radio.actionPause': 'Mettre en pause',
  'radio.actionResume': 'Reprendre',
  'radio.targetSelected': 'sélectionnée',
  'radio.targetNearest': 'la plus proche',
  'radio.playStateAria': '{action} la station de radio {target}',
  'radio.miniStateUncertain': 'ÉTAT RADIO INCERTAIN',
  'radio.miniSyncingDirectory': 'SYNCHRONISATION DU RÉPERTOIRE',
  'radio.stationSyncing': 'SYNCHRONISATION',
  'radio.stationFallback': 'station',
  'radio.playbackReadyFallback': 'Prête',

  // CCTV panel runtime states (layers.cctv.* seeded keys reused where they
  // match; these are the runtime-only compositions and flipped states).
  'cctv.coverageViewshedOn': 'ZONE DE VISIBILITÉ ACTIVÉE',
  'cctv.frameLoading': 'IMAGE · CHARGEMENT',
  'cctv.frameUnavailable': 'IMAGE · INDISPONIBLE',
  'cctv.calChipEdited': 'CAL · MODIFIÉE (NON ENREGISTRÉE)',
  'cctv.calChipTemplate': 'CAL · {badge}',
  'cctv.calBadgeCalibrated': 'CALIBRÉE',
  'cctv.calBadgeCurated': 'SÉLECTIONNÉE',
  'cctv.calBadgeRawPrior': 'A PRIORI BRUT',
  'cctv.metaProjectionMonitor': 'MONITOR',
  'cctv.metaProjectionOff': 'DÉSACTIVÉ',
  'cctv.metaTemplate': '{city} · HDG {heading} · FOV {fov} · PORTÉE {range}m · {projection}{calBadge} · {provider}{status}',
  'cctv.metaCamerasClick': {
    one: '{count} caméra chargée · cliquez sur une caméra pour l’activer',
    other: '{count} caméras chargées · cliquez sur une caméra pour l’activer',
  },
  'cctv.metaCamerasEnable': {
    one: '{count} caméra chargée · activez CCTV pour l’activer',
    other: '{count} caméras chargées · activez CCTV pour l’activer',
  },
  'cctv.summaryNoneAvailable': 'Aucun résumé disponible.',

  // ── Phase-3 runtime extraction batch 5: remainder + hud.js ────────────────

  // _setCelestialRingEnabled(): unsupported-style title sibling of the seeded
  // display.celestialToggleTitle.
  'display.celestialUnavailableTitle': 'Anneau céleste — disponible dans le style Normal',
  // _updateDetectionButton(): density-profile labels (display.detectionLabel
  // 'DETECT' was seeded on the static button) + composed aria.
  'display.detectionAriaTemplate': 'Superposition de détection : {mode}',
  'display.detectionAriaOff': 'Superposition de détection : désactivée',
  'display.detectionLabelSparse': 'DISPERSÉE',
  'display.detectionLabelBalanced': 'ÉQUILIBRÉE',
  'display.detectionLabelDense': 'DENSE',
  // Globe-reset buttons: idle/working aria states (cockpit variant sibling).
  'hud.resetGlobeAria': 'Réinitialiser sur la vue complète du globe',
  'hud.resetGlobeCockpitAria': 'Réinitialiser le cockpit sur la vue complète du globe',
  'hud.resettingGlobeAria': 'Réinitialisation sur la vue complète du globe',
  'hud.resettingGlobeCockpitAria': 'Réinitialisation du cockpit sur la vue complète du globe',
  // _initOrbit(): indicator caption after the orbit glyph.
  'location.orbitLabel': 'ORBITE',
  // Intel HUD (src/hud.js): summary caption, idle placeholder, REC indicator.
  // Classification banners, terse instrument readout codes (MGRS/GSD/NIIRS/
  // ALT/COLL/ONA/BAND/BITS/LVL), and the AI summary line stay keep-English.
  'hud.summaryLabel': 'SYNTHÈSE',
  'hud.summaryAwaiting': 'En attente de télémétrie...',
  'hud.recLabel': 'REC',
};
