// Neutral international Spanish (es). See docs/TRANSLATORS.md glossary.
export const NAMESPACE = 'setup';

export default {
  'firstRun.kicker': 'CENTRO DE MANDO · PRIMER INICIO',
  'firstRun.title': 'Elige tu primera vista',
  'firstRun.choice.contacts': 'CONTACTOS EN VIVO',
  'firstRun.suppress': 'No volver a mostrar',
  'keySetup.chip': 'ENCENDER',
  'keySetup.kicker': 'ESTACIÓN TERRENA · AJUSTES DE PROVEEDORES',
  'keySetup.title': 'Enciende el globo',
  'keySetup.apply': 'GUARDAR CLAVES',
  'keySetup.status.saving': 'Guardando…',

  // Phase-2 static markup extraction (mirrors locales/en/setup.js appendix).
  'firstRun.description':
    'Parece una cabina prohibida—hasta que descubres que las fuentes son públicas y los datos son reales.',
  'firstRun.choice.contactsSub': 'Aviones, barcos e inteligencia cercana',
  'firstRun.choice.spaceMissions': 'MISIONES ESPACIALES',
  'firstRun.choice.spaceMissionsSub': 'Lanzamientos, naves y contexto orbital',
  'firstRun.choice.explore': 'EXPLORAR MANUALMENTE',
  'firstRun.choice.exploreSub': 'Empieza con un globo limpio',
  'firstRun.dismissHint': 'ESC para cerrar',
  'firstRun.note':
    'Consejo: el botón MIC de GEV en el dock te permite hablar con el mapa.',
  'keySetup.closeAriaLabel': 'Cerrar la configuración de claves',
  'keySetup.description':
    'El globo ya vuela sin claves. Cada clave de abajo activa otra fuente real — pega una y queda guardada en la configuración local de esta app, y luego el servidor se reinicia solo. Las claves del servidor se quedan en esta máquina; Google Maps y Cesium ion funcionan en el navegador y sus claves deben estar restringidas por el proveedor. Las claves que configuraste en otro lugar se muestran, pero nunca se modifican.',
  'keySetup.hint': 'ESC para cerrar',
  'keySetup.note':
    'La clave de Google Maps compra el planeta fotorrealista — todo lo demás se monta encima.',
  'scenes.panelTitle': 'ESCENAS',
  'scenes.collapseTitle': 'Contraer panel',
  'scenes.recipeAriaLabel': 'Receta de escena',
  'scenes.new': 'NUEVA',
  'scenes.delete': 'BORRAR',
  'scenes.capture': 'CAPTURAR PLANO',
  'scenes.updateShot': 'ACTUALIZAR PLANO',
  'scenes.start': 'INICIAR',
  'scenes.stop': 'DETENER',
  'scenes.next': 'SIGUIENTE',
  'scenes.exportPresets': 'EXPORTAR PREAJUSTES',
  'scenes.import': 'IMPORTAR',
  'scenes.runLog': 'REGISTRO DE EJECUCIÓN',
  'scenes.statusReady': 'Listo',

  // Phase-3 runtime extraction (mirrors locales/en/setup.js appendix).
  'firstRun.busy.contacts': 'Iniciando contactos en vivo…',
  'firstRun.busy.spaceMissions': 'Abriendo misiones espaciales…',
  'firstRun.busy.environmental': 'Escaneando eventos activos…',
  'firstRun.busy.working': 'Trabajando…',
  'firstRun.status.failed':
    'No se pudo abrir esa misión{detail}. Reintenta o explora manualmente.',
  'firstRun.status.storageBlocked':
    'Este navegador bloquea el almacenamiento, así que no se pudo guardar.',
  'firstRun.choice.environmentalSub':
    'Terremotos en vivo y fuegos activos, de USGS y NASA',
  'firstRun.environmentalTitle.environmental': 'MEDIO AMBIENTE',
  'firstRun.environmentalTitle.earthWatch': 'VIGILANCIA TERRESTRE',
  'firstRun.environmentalTitle.activeEvents': 'EVENTOS ACTIVOS',
  'keySetup.chipWaiting': {
    one: 'ENCENDER · {count} CLAVE EN ESPERA',
    other: 'ENCENDER · {count} CLAVES EN ESPERA',
  },
  'keySetup.chipReady': 'ENCENDIDO',
  'keySetup.status.saveFailed': 'Error al guardar ({status}).',
  'keySetup.status.saveFailedDetail': 'Error al guardar: {detail}',
  'keySetup.status.pasteFirst': 'Pega al menos una clave primero.',
  'keySetup.status.saved':
    'Guardado en {store}. Reiniciando — esta página se recarga sola.',
  'keySetup.status.removed':
    'Eliminado de {store}. Reiniciando — esta página se recarga sola.',
  'keySetup.store.pinokio': 'tu configuración de la app',
  'keySetup.store.env': 'tu .env local',
  'keySetup.confirm.remove':
    '¿Eliminar esta clave de tu configuración guardada?',
  'mapStack.fallbackName': 'Este conjunto de mapas',
  'mapStack.unavailableReason': '{label} no está disponible',
  'mapStack.unavailableAriaLabel': '{label} no disponible: {hint}',
  'scenes.recipe.flightsRadar': 'Radar global de vuelos',
  'scenes.recipe.orbitalWatch': 'Vigilancia orbital',
  'scenes.recipe.thermalThreats': 'Panel de amenazas térmicas',
  'scenes.recipe.cityOverload': 'Sobrecarga urbana',
  'scenes.recipe.omnisciencePullback': 'Alejamiento omnisciente',
  'voice.status.idle': 'APAGADO',
  'voice.status.connecting': 'CONECTANDO',
  'voice.status.listening': 'ESCUCHANDO',
  'voice.status.executing': 'EJECUTANDO',
  'voice.status.error': 'ERROR',
  'voice.status.sessionCostCap': 'Sesión finalizada — límite de costo {cost}',
  'voice.detail.standby': 'VOZ EN ESPERA',
  'voice.detail.active': 'VOZ ACTIVA',
  'voice.detail.unavailable': 'VOZ NO DISPONIBLE',
  'voice.detail.microphoneUnavailable':
    'Compatibilidad con micrófono WebRTC no disponible',
  'voice.detail.requestingMicrophone': 'Solicitando micrófono',
  'voice.detail.holdSpaceTalk': 'Mantén Espacio para hablar',
  'voice.detail.releaseSpaceSend': 'Suelta la barra espaciadora para enviar',
  'voice.detail.askOrCommand': 'Pregunta o ordena',
  'voice.detail.voiceOff': 'Voz desactivada',
  'voice.detail.runningCommand': 'Ejecutando comando',
  'voice.detail.radioDidNotStart': 'La radio no se inició',
  'voice.hint.default':
    'Mantén presionada la barra espaciadora para hablar · púlsala brevemente para activar los controles enfocados',
  'voice.error.sessionStart': 'No se pudo iniciar la sesión de voz.',
  'voice.error.trayTitle': 'ERROR DEL SISTEMA DE VOZ',
  'voice.error.dismiss': 'CERRAR',
  'voice.error.hint':
    'Revisa el permiso del micrófono y el acceso a la red, y vuelve a intentarlo.',
  'voice.kicker.agent': 'AGENTE DE IA',
  'voice.kicker.control': 'CONTROL DE VOZ',
  'voice.tier.appliesNextSession': '{tier} se aplica en la próxima sesión',
  'voice.tier.buttonTitle':
    'Nivel del modelo de voz — se aplica en la próxima sesión',
  'voice.cost.buttonTitle': 'Costo estimado de la sesión',
  'voice.button.ariaLabel':
    'Control de voz — actívalo para conectar o cortar la voz; mantén presionada la barra espaciadora para hablar',

  // Stage-4 repair pass (mirrors locales/en/setup.js appendix).
  'scenes.status.captureCameraNotReady':
    'No se puede capturar el plano: la cámara no está lista',
  'scenes.status.shotTitleDefault': 'Plano {n}',
  'scenes.status.captured': 'Capturado: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'Selecciona primero un plano',
  'scenes.status.updated': 'Actualizado: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': '¿Eliminar el plano "{shot}"?',
  'scenes.status.loaded': 'Cargado: {scene} / {shot}',
  'scenes.status.cameraUnavailable':
    'Cámara no disponible — sal primero de la cabina',
  'scenes.status.noShotsToRun': 'No hay planos para ejecutar',
  'scenes.status.runningShot': 'Ejecutando {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'Ejecución de escenas completada',
  'scenes.status.runError': 'Error: {message}',
  'scenes.status.contextExitFailed':
    'No se pudo salir de {mode} — las capas de la escena pueden rechazarse',

  // Stage-4 repair pass (mirrors locales/en/setup.js appendix).
  'keySetup.row.remove': 'ELIMINAR',
  'keySetup.row.removeTitle':
    'Elimina {title} de las claves guardadas de esta app',
  'keySetup.requirement':
    'Necesita {envVars} — añádela en Ajustes de proveedores',
  'keySetup.unlocks.google-maps':
    'El planeta 3D fotorrealista + búsqueda de lugares',
  'keySetup.unlocks.google-maps-server':
    'Contexto de Places + respaldo de Street View; clave separada opcional',
  'keySetup.unlocks.openai': 'Control por voz — habla con el planeta',
  'keySetup.unlocks.aisstream': 'Barcos en vivo, en todo el mundo',
  'keySetup.unlocks.firms': 'Detecciones de incendios activos en vivo',
  'keySetup.unlocks.tomtom':
    'Tráfico real en vivo (sin clave usa una simulación)',
  'keySetup.unlocks.cesium-ion':
    'Conjuntos de mapas Bing imagery + terreno mundial',
  'keySetup.unlocks.opensky':
    'Más créditos de consulta de vuelos (sin clave funciona el modo anónimo)',
  'keySetup.unlocks.launch-library':
    'Mayor límite de peticiones para misiones espaciales',

  'scenes.status.actionFailed': 'La acción de escena falló',

  'scenes.status.projectExported': 'Proyecto exportado',

  'voice.tierNextSession':
    'Sesión siguiente: {pendingId} — esta sesión sigue en {modelId}',
  'voice.tierSwitchHint':
    'Modelo de voz: {pendingId} — toca para cambiar a {target}; se aplica en la próxima sesión',
  'voice.costTooltip':
    'Coste de sesión estimado en {modelId} — {responses} respuesta(s). Avisa a {warn} y cierra la sesión a {cap}.',
};
