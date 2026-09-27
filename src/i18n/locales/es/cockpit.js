// Neutral international Spanish (es). See docs/TRANSLATORS.md glossary.
export const NAMESPACE = 'cockpit';

export default {
  'hud.sectionLabel': 'Vista de cabina de la aeronave',
  'exit.label': 'SALIR DE CABINA',
  'readout.groundSpeed': 'VEL. SUELO',
  'readout.altitude': 'ALTITUD',
  'context.kicker': 'CONTACTO',
  'context.subjectWindow': 'CONTACTOS · 250 KM',
  'brief.kicker': 'SEÑALES EN VIVO',
  'brief.subtitle': 'PINGS OBSERVADOS / MAPEADOS',
  'vision.current': 'ACTUAL',
  'radio.station.ready': 'LISTA',

  // Phase-2 static markup extraction (mirrors locales/en/cockpit.js appendix).
  'presets.activeStyleLabel': 'ESTILO ACTUAL',
  'display.cleanViewExitTitle': 'Volver a mostrar los controles de la interfaz',
  'display.cleanViewExitLabel': 'SALIR DE VISTA LIMPIA',
  'presets.toggleAriaLabel': 'Expandir Preajustes visuales',
  'presets.title': 'PREAJUSTES VISUALES',
  'presets.pinAriaLabel': 'Fijar Preajustes visuales',
  'presets.pinTitle': 'Mantener abiertos los Preajustes visuales',
  'presets.styleNormalTitle': 'Muestra el globo sin filtro visual.',
  'presets.styleNormalLabel': 'Normal',
  'presets.styleCrtTitle':
    'Emula un CRT de fósforo verde con líneas de barrido y curvatura de pantalla.',
  'presets.styleCrtLabel': 'CRT',
  'presets.styleNvgTitle':
    'Simula unas gafas de visión nocturna con intensificación verde y viñeta de tubo.',
  'presets.styleNvgLabel': 'NVG',
  'presets.styleFlirTitle':
    'Simula un contraste térmico estilo FLIR. Sube Ironbow para tener color.',
  'presets.styleFlirLabel': 'FLIR',
  'presets.styleAnimeTitle':
    'Aplica un color brillante de cel-shading y contornos ilustrados.',
  'presets.styleAnimeLabel': 'Anime',
  'presets.styleNoirTitle':
    'Aplica una gradación monocroma de alto contraste estilo film noir.',
  'presets.styleNoirLabel': 'Noir',
  'presets.styleSnowTitle':
    'Añade a la escena un tratamiento frío de ventisca blanca.',
  'presets.styleSnowLabel': 'Nieve',
  'presets.mapSourceLabel': 'FUENTE DEL MAPA',
  'presets.mapSourceChipsAriaLabel': 'Fuente del mapa',
  'presets.miniStyleLabel': 'Estilo',
  'display.title': 'VISUALIZACIÓN',
  'display.collapseTitle': 'Contraer panel',
  'display.hudToggleTitle': 'HUD de inteligencia (H)',
  'display.hudLayoutLabel': 'Disposición',
  'display.hudLayoutAriaLabel': 'Disposición del HUD',
  'display.hudLayoutTactical': 'Táctica',
  'display.hudLayoutOperator': 'De operador',
  'display.hudLayoutMinimal': 'Mínima',
  'display.detectionToggleTitle': 'Superposición de detección (D)',
  'display.detectionAriaLabel': 'Superposición de detección',
  'display.detectionLabel': 'DETECTAR',
  'display.densityLabel': 'Densidad',
  'display.densityAriaLabel': 'Densidad de etiquetas de detección',
  'display.allocationLabel': 'Asignación',
  'display.allocationAriaLabel': 'Asignación de etiquetas de detección',
  'display.allocationElastic': 'Elástica',
  'display.allocationWeighted': 'Ponderada',
  'display.fadeLabel': 'Desvanecido',
  'display.fadeAriaLabel': 'Distancia de desvanecimiento de detección',
  'display.fadeTitle':
    'Distancia de desvanecimiento de la superposición del mundo fuera del ojo de cerradura, como porcentaje de su radio',
  'display.outsideLabel': 'Exterior',
  'display.outsideAriaLabel':
    'Opacidad de detección fuera del ojo de cerradura',
  'display.outsideTitle':
    'Opacidad de etiquetas y tarjetas de la superposición del mundo más allá de la distancia de desvanecimiento',
  'display.parametersTitle': 'PARÁMETROS',
  'display.parametersCollapseTitle': 'Contraer panel',
  'display.modelsToggleTitle':
    'Aeronaves 3D — iconos planos de lejos, modelos 3D de cerca',
  'display.modelsLabel': 'Modelos',
  'display.modelsCoverageAriaLabel': 'Cobertura de modelos 3D',
  'display.modelsModeProximity': 'Proximidad',
  'display.modelsModeAll': 'Todos',
  'display.scopeToggleTitle': 'Mirilla — la máscara circular del visor',
  'display.scopeLabel': 'Mirilla',
  'display.featherLabel': 'Difuminado',
  'display.featherTitle':
    'Difuminado del borde de la mirilla como porcentaje del radio del ojo de cerradura',
  'display.celestialToggleTitle':
    'Anillo celestial — muestra el globo completo',
  'display.celestialLabel': 'Celeste',
  'display.cleanViewToggleTitle': 'Ocultar los elementos de la interfaz',
  'display.cleanViewLabel': 'Interfaz limpia',
  'display.bloomToggleTitle': 'Bloom / Resplandor',
  'display.bloomLabel': 'Bloom',
  'display.sharpenToggleTitle': 'Nitidez',
  'display.sharpenLabel': 'Nitidez',
  'location.toolbarLabel': 'UBICACIÓN',
  'location.collapseTitle': 'Contraer panel',
  'location.pinAriaLabel': 'Fijar bandeja de ubicación',
  'location.pinTitle': 'Mantener abierta la bandeja de ubicación',
  'location.miniCityInitial': '📍 Ubicación: --',
  'location.miniPoiInitial': 'Punto de interés: --',
  'location.searchToggleTitle': 'Buscar cualquier ubicación',
  'location.searchPlaceholder': 'Buscar cualquier ubicación...',
  'hud.level': 'NIVEL',
  'hud.routeDirectionAriaLabel': 'Dirección estimada del destino',
  'hud.routeDirectionIdle': 'DEST ---°',
  'hud.visorPlane': 'PLANO ÓPTICO · 01',
  'hud.visorLock': 'BLOQUEO DE VISERA · ACTIVO',
  'hud.firstPerson': 'PRIMERA PERSONA',
  'hud.aircraftMetaInitial': 'RASTREO EN VIVO · RUMBO ALINEADO',
  'hud.visionGroupAriaLabel': 'Estilo de visión de la cabina',
  'hud.compassAriaLabel': 'Rumbo actual de la aeronave',
  'readout.rimGroundSpeed': 'VEL. SUELO · KTS',
  'readout.rimAltitude': 'ALTITUD · FT',
  'vision.previousLabel': 'ANT',
  'vision.previousAriaLabel': 'Estilo de visión de cabina anterior',
  'vision.previousTitle': 'Estilo de visión anterior',
  'vision.currentAriaLabel':
    'Estilo de visión de cabina actual: NORMAL. Actívalo para pasar al siguiente estilo.',
  'vision.currentTitle': 'Estilo actual: NORMAL — haz clic para el siguiente',
  'vision.nextLabel': 'SIG',
  'vision.nextAriaLabel': 'Siguiente estilo de visión de cabina',
  'vision.nextTitle': 'Siguiente estilo de visión',
  'exit.navAriaLabel': 'Selector de vistas',
  'exit.resetAriaLabel': 'Restablecer la cabina a la vista de globo completo',
  'exit.resetTitle': 'Salir de la cabina y volver a la vista de globo completo',
  'exit.resetLabel': 'RESTABLECER',
  'exit.ariaLabel': 'Salir de la vista de cabina',
  'exit.title': 'Salir de la vista de cabina',
  'route.cardAriaLabel': 'Plan de vuelo estimado',
  'route.kicker': 'PLAN DE VUELO ESTIMADO',
  'route.statusUnavailable': 'DATOS DE RUTA NO DISPONIBLES',
  'route.fromLabel': 'DESDE',
  'route.toLabel': 'HACIA',
  'route.unknownEndpoint': 'DESCONOCIDO',
  'brief.carouselAriaLabel': 'Carrusel de información de la cabina',
  'brief.actionsAriaLabel': 'Controles de información de la cabina',
  'brief.previousAriaLabel': 'Página de información anterior',
  'brief.previousTitle': 'Página de información anterior',
  'brief.nextAriaLabel': 'Página de información siguiente',
  'brief.nextTitle': 'Página de información siguiente',
  'brief.autoTitle':
    'Cambia las páginas de información automáticamente cada 9 segundos (Señales → Noticias → Local). Se pausa mientras pasas el cursor por el panel o lo enfocas. Los datos de señales en vivo se actualizan continuamente de todos modos.',
  'brief.collapseAriaLabel': 'Contraer el panel de información de la cabina',
  'brief.collapseTitle': 'Contraer el panel de información',
  'brief.signalsAriaLabel': 'Señales en vivo',
  'brief.newsAriaLabel': 'Últimas noticias regionales',
  'brief.localAriaLabel': 'Información basada en la ubicación',
  'brief.newsAcquiring': 'OBTENIENDO NOTICIAS REGIONALES',
  'brief.localResolving': 'DETERMINANDO REGIÓN',
  'brief.labelTemp': 'TEMP',
  'brief.labelWind': 'VIENTO',
  'brief.labelSky': 'CIELO',
  'brief.labelPrecip': 'PRECIP',
  'brief.sourceNote': 'EVENTOS CON FUENTE · SIN NOTICIAS SINTÉTICAS',
  'brief.tabSignalsAriaLabel': 'Mostrar Señales en vivo',
  'brief.tabNewsAriaLabel': 'Mostrar Noticias regionales',
  'brief.tabLocalAriaLabel': 'Mostrar Información local',
  'context.panelAriaLabel': 'Resumen de contacto de la cabina',
  'context.navAriaLabel': 'Navegación de contactos',
  'context.previousAriaLabel':
    'Anterior — contacto ya visitado en la ventana de 250 km',
  'context.previousTitle':
    'Anterior — contacto ya visitado en la ventana de 250 km',
  'context.nextAriaLabel':
    'Siguiente — contacto sin visitar más cercano en la ventana de 250 km',
  'context.nextTitle':
    'Siguiente — contacto sin visitar más cercano en la ventana de 250 km',
  'context.toggleAriaLabel': 'Contraer el panel de contacto',
  'context.toggleTitle': 'Contraer el panel de contacto',
  'context.qualifier': 'SOLO CONTEXTO',
  'context.cohortsAriaLabel': 'Recuento de grupos cercanos',
  'context.nearestLabel': 'MÁS CERCANO OBSERVADO / MAPEADO',
  'context.nearestEmpty': 'SIN EJEMPLO DISPONIBLE',
  'context.uncertaintyNote':
    'SOLO DATOS DISPONIBLES · NO IMPLICA TODO DESPEJADO',
  'context.weatherEnableAriaLabel':
    'Activar los efectos climáticos de la cabina',
  'context.weatherEnableTitle': 'Activar los efectos climáticos de la cabina',
  'context.panelTitle': 'CONTEXTO',
  'context.collapseTitle': 'Expandir panel',
  'context.modesAriaLabel': 'Modo de contexto',
  'context.contactsTabAriaLabel': 'CONTACTOS',
  'context.contactsTabTitle':
    'Ronda por los contactos más cercanos del tipo que elijas — aeronaves, embarcaciones, instalaciones. Los satélites se rastrean por separado.',
  'context.contactsTabLabel': 'CONTACTOS',
  'context.missionsTabLabel': 'MISIONES ESPACIALES',
  'context.standbyTitle': 'SELECCIONAR CONTEXTO',
  'context.actionsAriaLabel': 'Acciones de contexto de contacto',
  'context.cockpitEntryLabel': 'CABINA',
  'context.searchNearbyLabel': 'BUSCAR SITIOS CERCANOS',
  'context.tr3bAriaLabel': 'Reclasificar el contacto rastreado como TR-3B',
  'context.tr3bTitle': 'Reclasificar como TR-3B',
  'context.awarenessOffTitle': 'CONTEXTO DE CONTACTOS DESACTIVADO',
  'context.awarenessOffHint':
    'SELECCIONA CONTACTOS PARA CARGAR LA PROXIMIDAD OBSERVADA / MAPEADA',
  'context.rosterAriaLabel': 'Misiones espaciales disponibles',
  'context.rosterTitle': 'MISIONES DISPONIBLES',
  'context.rosterHint': 'SELECCIONA UNA MISIÓN PARA INSPECCIONAR',
  'context.rosterLoading': 'CARGANDO ÍNDICE DE MISIONES DE 30 DÍAS',
  'context.radioToggleAriaLabel': 'Abrir los controles compactos de Radio',
  'context.radioToggleTitle': 'Abrir los controles compactos de Radio',
  'context.radioMiniGroupAriaLabel': 'Controles compactos de Radio',
  'context.radioMiniTitle': 'RADIO',
  'context.radioMiniReady': 'RADIO LISTA',
  'context.radioDetailsAriaLabel': 'Abrir los controles detallados de Radio',
  'context.radioDetailsTitle': 'Abrir los controles detallados de Radio',
  'context.radioCloseAriaLabel': 'Cerrar los controles compactos de Radio',
  'context.radioCloseTitle': 'Cerrar los controles compactos de Radio',
  'context.radioMiniEnable': 'ACTIVAR',
  'context.radioMiniPrevAriaLabel': 'Emisora de radio filtrada anterior',
  'context.radioMiniPrevTitle': 'Emisora anterior',
  'context.radioMiniPlayAriaLabel':
    'Reproducir la emisora de radio seleccionada',
  'context.radioMiniPlayTitle': 'Reproducir',
  'context.radioMiniNextAriaLabel': 'Siguiente emisora de radio filtrada',
  'context.radioMiniNextTitle': 'Siguiente emisora',
  'context.radioMiniVolumeLabel': 'VOLUMEN',
  'context.radioMiniVolumeAriaLabel': 'Volumen de la Radio compacta',
  'utility.controlsAriaLabel':
    'Controles de visualización y Radio de la cabina',
  'utility.displayLabel': 'VISUALIZACIÓN',
  'utility.radioLabel': 'RADIO',
  'utility.displayToggleAriaLabel':
    'Expandir las opciones de visualización de la cabina',
  'utility.displayToggleTitle':
    'Expandir las opciones de visualización de la cabina',
  'utility.displayPanelAriaLabel': 'Opciones de visualización de la cabina',
  'utility.radioToggleAriaLabel':
    'Expandir los controles de Radio de la cabina',
  'utility.radioToggleTitle': 'Expandir los controles de Radio de la cabina',
  'utility.radioPanelAriaLabel': 'Controles compactos de Radio de la cabina',
  'radio.enable': 'ACTIVAR',
  'radio.prevAriaLabel': 'Emisora de radio filtrada anterior',
  'radio.playAriaLabel': 'Reproducir la emisora de radio seleccionada',
  'radio.nextAriaLabel': 'Siguiente emisora de radio filtrada',
  'radio.volumeLabel': 'VOLUMEN',
  'radio.volumeAriaLabel': 'Volumen de la Radio de la cabina',

  // ── Phase-3 runtime extraction (src/ui.js), appended ─────────────────────
  // Same keys as en/cockpit.js; see that catalog for per-key call sites.

  // _syncPanelCollapseButton(): composed panel collapse titles. {name} is the
  // panel's own (already localized) .panel-title text.
  'panel.expandTitle': 'Expandir {name}',
  'panel.collapseTitle': 'Contraer {name}',
  // Fallback when a panel ships no .panel-title/.pp-header-label node.
  'panel.fallbackName': 'panel',
  // Radio panel collapse state; the expand state reuses the layers.radio.*
  // keys seeded on the static button in phase 2.
  'panel.radioCollapseTitle': 'Contraer Radio',
  'panel.radioCollapseAria': 'Contraer la sección de Radio',
  // _updateLocationMiniStatus(): runtime rewrite of the collapsed LOCATION
  // readout's single-segment search fallback (initial-state keys
  // location.miniCityInitial/miniPoiInitial were seeded in phase 2).
  'location.miniSearchedPlaceholder': 'Ubicación buscada',

  // ── Phase-3 runtime extraction batch 2: cockpit + Context renderers ───────
  // Same keys as en/cockpit.js.

  // syncWeatherToggle(): state-sibling keys for the runtime ON/OFF rewrite
  // (context.weatherEnableAriaLabel was seeded on the static button).
  'context.weatherDisableAriaLabel':
    'Desactivar los efectos climáticos de la cabina',
  'context.weatherStateOn': 'ACTIVADO',
  'context.weatherStateOff': 'DESACTIVADO',
  // syncTr3bToggle(): converted-state title sibling of context.tr3bTitle.
  'context.tr3bRestoreTitle': 'Restaurar la aeronave real',
  // setVisionMode(): the style token is dynamic, so the sentence is split out
  // of the seeded vision.currentAriaLabel/currentTitle (whose values pin the
  // NORMAL default) into {style} templates.
  'vision.styleNameNightVision': 'Visión nocturna',
  'vision.styleNameThermal': 'Térmica',
  'vision.styleNameNoir': 'Noir',
  'vision.currentAriaTemplate':
    'Estilo de visión de cabina actual: {style}. Actívalo para pasar al siguiente estilo.',
  'vision.currentTitleTemplate':
    'Estilo actual: {style} — haz clic para el siguiente',

  // Cockpit signal stream (pushCockpitSignal / renderCockpitSignals).
  'signal.trackAcquired': 'RASTREO ADQUIRIDO',
  'signal.trackDetail': '{label} · RUMBO {heading}°',
  'signal.selectFlightAria': 'Seleccionar el vuelo {title}',
  'signal.contextStandby': 'CONTEXTO EN ESPERA',
  'signal.contextStandbyHint':
    'ACTIVAR CONTEXTO GLOBAL PARA PINGS DE PROXIMIDAD',
  'signal.contactLostTitle': 'CONTACTO PERDIDO · {subject}',
  'signal.contactLostDetail':
    'EL OBJETIVO SALIÓ DE SU FUENTE · LA LECTURA CONSERVA EL ÚLTIMO DATO CONOCIDO',
  'signal.classMilitary': 'VUELO MILITAR',
  'signal.classCommercial': 'VUELO COMERCIAL',
  'signal.contactCurrent': '{aircraftClass} · ACTUAL',
  'signal.contactRange': '{aircraftClass} · {distance}',
  'signal.distanceUnknown': 'DISTANCIA DESCONOCIDA',
  'signal.inputsUnknown': {
    one: '{count} DATO DESCONOCIDO',
    other: '{count} DATOS DESCONOCIDOS',
  },
  'signal.sourceStatusUnavailable': 'ESTADO DE FUENTE NO DISPONIBLE',

  // updateHud(): callsign fallback + the composed aircraft meta line (each
  // feed state is its own key so no state can leak English later).
  'hud.fallbackCallsign': 'AERONAVE',
  'hud.metaClassMilitary': 'MILITAR',
  'hud.metaClassCommercial': 'COMERCIAL',
  'hud.metaFeedAcquiringSurface': 'OBTENIENDO SUPERFICIE',
  'hud.metaFeedSurfaceFallback': 'RESPALDO DE SUPERFICIE',
  'hud.metaFeedStale': 'FUENTE DESACTUALIZADA',
  'hud.metaFeedLive': 'RASTREO EN VIVO',
  'hud.aircraftMetaTemplate': '{aircraftClass} · {feedState} · RUMBO ALINEADO',

  // updateRoute(): runtime state siblings of the seeded route keys.
  'route.statusArrowEstimated': 'FLECHA · DIRECCIÓN ESTIMADA',
  'route.directionLabel': 'DEST {bearing}',

  // updateContext(): uncertainty/nearest/bearing readout states.
  'context.uncertaintyContactLost':
    'CONTACTO PERDIDO · ÚLTIMA LECTURA CONOCIDA · NO IMPLICA TODO DESPEJADO',
  'context.uncertaintyInputsUnknown': {
    one: '{count} DATO DESCONOCIDO · NO IMPLICA TODO DESPEJADO',
    other: '{count} DATOS DESCONOCIDOS · NO IMPLICA TODO DESPEJADO',
  },
  'context.uncertaintyInputsCurrent':
    'DATOS DISPONIBLES ACTUALIZADOS · NO IMPLICA TODO DESPEJADO',
  'context.nearestTemplate': '{cohort} · {contact}',
  'context.nearestUnavailableAria': '{cohort}, no disponible',
  'context.bearingNone': 'BRG —',
  'context.bearingAhead': 'AL FRENTE',
  'context.bearingSide': '{side} {angle}',
  'context.sideLeft': 'I',
  'context.sideRight': 'D',

  // setContextCollapsed()/setSignalCollapsed(): expand-state siblings.
  'context.toggleExpandAriaLabel': 'Expandir el panel de contacto',
  'context.toggleExpandTitle': 'Expandir el panel de contacto',
  'brief.expandAriaLabel': 'Expandir el panel de información de la cabina',
  'brief.expandTitle': 'Expandir el panel de información',

  // setBriefAutoRotate(): cycle toggle states + the ON-state help text (the
  // OFF-state help is the seeded brief.autoTitle).
  'brief.autoOn': 'CICLO ACTIVADO',
  'brief.autoOff': 'CICLO DESACTIVADO',
  'brief.autoTitleOn':
    'Detén el cambio automático de páginas. Anterior, Siguiente y las pestañas SIG/NEWS/LOCAL siguen disponibles.',

  // Briefing carousel pages (kicker/subtitle/source per page; the news/local
  // source lines are provider attribution and stay English).
  'brief.kickerNews': 'NOTICIAS REGIONALES',
  'brief.kickerLocal': 'INFORMACIÓN LOCAL',
  'brief.subtitleNews': 'ÚLTIMOS REPORTES SEGÚN UBICACIÓN',
  'brief.subtitleLocal': 'LUGAR / CONDICIONES / POSICIÓN',

  // Local position + regional brief status states.
  'brief.positionUnavailable': 'POSICIÓN NO DISPONIBLE',
  'brief.newsUnavailable': 'NOTICIAS REGIONALES NO DISPONIBLES',
  'brief.regionUnavailable': 'REGIÓN NO DISPONIBLE',
  'brief.newsEmpty': 'SIN COINCIDENCIAS RECIENTES DE UBICACIÓN',

  // renderRegionalBrief(): article metadata, cloud readout, and age chips.
  'brief.metadataSourceFallback': 'FUENTE',
  'brief.articleMetaTemplate': '{domain} · {age}',
  'brief.newsSourceLine': '{source} · CONSULTA POR UBICACIÓN',
  'brief.age.timeUnknown': 'HORA DESCONOCIDA',
  'brief.age.minutes': 'HACE {count} M',
  'brief.age.hours': 'HACE {count} H',
  'brief.age.days': 'HACE {count} D',
  'brief.wind.dirUnknown': 'DIR DESCONOCIDA',
  'brief.cloudTemplate': 'NUBES {pct}%',
  'brief.cloudUnknown': 'NUBES DESCONOCIDAS',

  // ── Phase-3 runtime extraction batch 3: toasts, loading helpers, map tray ─
  // Same keys as en/cockpit.js.

  // Panel-chrome + share/location toasts.
  'panel.layoutResetToast':
    'Disposición de paneles actualizada — posiciones restablecidas a los nuevos valores predeterminados',
  'share.toastCopied': '¡Enlace copiado!',
  'share.toastCopyFailed': 'No se pudo copiar',
  'location.toastNotFound': 'Ubicación no encontrada',
  'location.toastSearchFailed': 'No se pudo completar la búsqueda',
  'location.toastFlyToPoiFirst': 'Ve primero a un punto de interés',
  'actions.clearLayersBusyAria': 'Limpiando las capas de datos seleccionadas',
  'actions.clearLayersFailedToast':
    'No se pudieron limpiar las capas de datos seleccionadas',

  // Global status chip notices (_handleShareTrackingRestoreStatus).
  'status.acquiring': 'OBTENIENDO',
  'status.subjectFallback': 'entidad',
  'status.sharedSubjectDetail': '{subject} COMPARTIDA',
  'status.sharedFollowExpired':
    'El seguimiento de {subject} compartido ha caducado',
  'status.sharedRestoreFailed':
    'No se pudo restaurar {subject} compartido — fuente no disponible',
  'status.sharedUnavailable': '{subject} compartido no está disponible',

  // Context mode user-facing action failures.
  'context.modeContext': 'Contexto',
  'context.modeSpaceMissions': 'Misiones espaciales',
  'context.toastStartBlocked':
    '{mode} no pudo iniciarse porque otra capa no se detuvo correctamente',
  'context.toastTransitionFailedContacts':
    'Contactos no pudo completar la transición solicitada; inténtalo de nuevo',
  'context.toastTransitionFailedMissions':
    'Misiones espaciales no pudo completar la transición solicitada; inténtalo de nuevo',
  'context.toastInstallationsRefreshFailed':
    'No se pudieron actualizar las instalaciones cercanas; inténtalo de nuevo',
  'context.toastRestoreFailed':
    'Contexto no pudo restaurar todas las capas; inténtalo de nuevo',
  'context.toastZoomToSearch': 'Haz zoom para buscar instalaciones mapeadas',
  'context.toastInstallationsRefreshed': 'Instalaciones cercanas actualizadas',
  'context.toastLayerUnavailable':
    'Esa capa no está disponible en el modo de contexto actual',
  'context.actionStart': 'iniciar',
  'context.actionStop': 'detenerse',
  'context.toastLayerLifecycleFailed':
    '{layerId} no pudo {action} correctamente',
  'radio.toastLifecycleFailed': 'Radio no pudo {action} correctamente',

  // CCTV sync chip captions + calibration/availability toasts.
  'cctv.syncLoadingFrames': 'cargando fotogramas',
  'cctv.syncGridReady': 'cuadrícula de cámaras lista',
  'cctv.toastCalibrationSaved': 'Calibración de CCTV guardada',
  'cctv.toastCalibrationReset': 'Calibración de CCTV restablecida',
  'cctv.toastLayerUnavailable': 'Capa de CCTV no disponible',

  // _renderMapStackState(): status chip fallback when no stack label resolves
  // (stack names themselves are keep-English provider/stack ids).
  'presets.mapStackFallback': 'MAPA',

  // ── Phase-3 runtime extraction batch 4: awareness / CCTV / Radio panels ───
  // (radio.* and cctv.* state values that layers.js already seeds are reused
  // cross-namespace; these are the runtime-only siblings and compositions.)

  // _applyRuntimeStaticHeaderText(): the key-only standby description span
  // (both mode descriptions in one span split by a literal <br> in phase 2).
  'context.standbyContactsDesc':
    'CONTACTOS — aeronaves · embarcaciones · sitios más cercanos',
  'context.standbyMissionsDesc':
    'MISIONES ESPACIALES — lanzamientos y activos orbitales',
  // _syncContextRadioLauncherState(): close-state sibling of the seeded
  // context.radioToggleAriaLabel ('Open compact Radio controls').
  'context.radioToggleCloseAriaLabel':
    'Cerrar los controles compactos de Radio',
  'context.toastMissionsCancelRestoreFailed':
    'La cancelación de Misiones espaciales no pudo restaurar el estado previo de las capas',
  // Cockpit utility disclosures: collapse-state siblings of the seeded
  // utility.*ToggleAriaLabel expand keys.
  'utility.displayToggleCollapseAriaLabel':
    'Contraer las opciones de visualización de la cabina',
  'utility.radioToggleCollapseAriaLabel':
    'Contraer los controles de Radio de la cabina',

  // Radio panel runtime states (state-sibling keys so no state can leak
  // English later; lifecycle enum labels reuse layers.status.*).
  'radio.stateSync': 'SINCR.',
  'radio.tunerCategoryBand': 'BANDA {category}',
  'radio.tunerNoStations': 'SIN EMISORAS',
  'radio.tunerStationAria': '{name}, emisora {index} de {total}',
  'radio.tunerNoStationAria': 'Sin emisoras disponibles',
  'radio.tunerOffAir': 'FUERA DEL AIRE',
  'radio.tunerStationUnavailable': 'EMISORA NO DISPONIBLE',
  'radio.actionPlay': 'Reproducir',
  'radio.actionPause': 'Pausar',
  'radio.actionResume': 'Reanudar',
  'radio.targetSelected': 'seleccionada',
  'radio.targetNearest': 'más cercana',
  'radio.playStateAria': '{action} la emisora de radio {target}',
  'radio.miniStateUncertain': 'ESTADO DE RADIO SIN CONFIRMAR',
  'radio.miniSyncingDirectory': 'SINCRONIZANDO DIRECTORIO',
  'radio.stationSyncing': 'SINCRONIZANDO',
  'radio.stationFallback': 'emisora',
  'radio.playbackReadyFallback': 'Lista',

  // CCTV panel runtime states (layers.cctv.* seeded keys reused where they
  // match; these are the runtime-only compositions and flipped states).
  'cctv.coverageViewshedOn': 'ÁREA VISIBLE ACTIVADA',
  'cctv.frameLoading': 'FOTOGRAMA · CARGANDO',
  'cctv.frameUnavailable': 'FOTOGRAMA · NO DISPONIBLE',
  'cctv.calChipEdited': 'CAL · EDITADA (SIN GUARDAR)',
  'cctv.calChipTemplate': 'CAL · {badge}',
  'cctv.calBadgeCalibrated': 'CALIBRADA',
  'cctv.calBadgeCurated': 'CURADA',
  'cctv.calBadgeRawPrior': 'PREVIA SIN PROCESAR',
  'cctv.metaProjectionMonitor': 'MONITOR',
  'cctv.metaProjectionOff': 'APAGADO',
  'cctv.metaTemplate':
    '{city} · HDG {heading} · FOV {fov} · ALCANCE {range}m · {projection}{calBadge} · {provider}{status}',
  'cctv.metaCamerasClick': {
    one: '{count} cámara cargada · haz clic en una cámara para activarla',
    other: '{count} cámaras cargadas · haz clic en una cámara para activarla',
  },
  'cctv.metaCamerasEnable': {
    one: '{count} cámara cargada · activa CCTV para activarla',
    other: '{count} cámaras cargadas · activa CCTV para activarlas',
  },
  'cctv.summaryNoneAvailable': 'No hay resumen disponible.',

  // ── Phase-3 runtime extraction batch 5: remainder + hud.js ────────────────

  // _setCelestialRingEnabled(): unsupported-style title sibling of the seeded
  // display.celestialToggleTitle.
  'display.celestialUnavailableTitle':
    'Anillo celestial — disponible en el estilo Normal',
  // _updateDetectionButton(): density-profile labels (display.detectionLabel
  // 'DETECT' was seeded on the static button) + composed aria.
  'display.detectionAriaTemplate': 'Superposición de detección: {mode}',
  'display.detectionAriaOff': 'Superposición de detección: desactivada',
  'display.detectionLabelSparse': 'DISPERSA',
  'display.detectionLabelBalanced': 'EQUILIBRADA',
  'display.detectionLabelDense': 'DENSA',
  // Globe-reset buttons: idle/working aria states (cockpit variant sibling).
  'hud.resetGlobeAria': 'Restablecer la vista de globo completo',
  'hud.resetGlobeCockpitAria':
    'Restablecer la cabina a la vista de globo completo',
  'hud.resettingGlobeAria': 'Restableciendo la vista de globo completo',
  'hud.resettingGlobeCockpitAria':
    'Restableciendo la cabina a la vista de globo completo',
  // _initOrbit(): indicator caption after the orbit glyph.
  'location.orbitLabel': 'ÓRBITA',
  // Intel HUD (src/hud.js): summary caption, idle placeholder, REC indicator.
  // Classification banners, terse instrument readout codes (MGRS/GSD/NIIRS/
  // ALT/COLL/ONA/BAND/BITS/LVL), and the AI summary line stay keep-English.
  'hud.summaryLabel': 'RESUMEN',
  'hud.summaryAwaiting': 'Esperando telemetría...',
  'hud.recLabel': 'REC',

  // Adiciones de accesibilidad upstream (seguimiento post-fusión).
  'display.featherAria': 'Suavizado del borde de la mirilla',
  'display.bloomAria': 'Intensidad del bloom',
  'display.sharpenAria': 'Intensidad de la nitidez',
  'location.searchAria': 'Buscar ubicación por nombre o coordenadas',
  'location.toggleAria': 'Expandir UBICACIÓN',
};
