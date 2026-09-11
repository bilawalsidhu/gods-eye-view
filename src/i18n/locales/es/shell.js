// Neutral international Spanish (es). See ai_docs/i18n-ownership.md glossary.
export const NAMESPACE = 'shell';

export default {
  'title.subtitle': 'NINGÚN RINCÓN SIN VIGILAR',
  'loading.initialStatus': 'Inicializando el mundo fotorrealista...',
  'loading.status.configuring': 'Configurando el visor...',
  'loading.status.tilesUnavailable': 'Google 3D Tiles no disponibles ({detail}). Cargando el globo sin clave...',
  'loading.status.flying': 'Volando a Austin, TX...',
  'loading.status.restoring': 'Restaurando la vista compartida...',
  'status.loadingLiveData': 'CARGANDO DATOS EN VIVO',
  'status.loadComplete': 'CARGA COMPLETA',
  'status.loadFailed': 'CARGA FALLIDA',
  'status.loadCancelled': 'CARGA CANCELADA',
  'status.trafficSyncing': 'sincronizando la red vial',
  'actions.clearLayers.ariaLabel': 'Limpiar las capas de datos seleccionadas',
  'actions.clearLayers.title': 'Desactivar todas las capas de datos seleccionadas',
  'actions.share.ariaLabel': 'Copiar enlace para compartir',
  'actions.resetView.ariaLabel': 'Restablecer la vista del globo completo',
  'panels.dataLayers': 'CAPAS DE DATOS',
  'panels.collapseTitle': 'Contraer panel',

  // Phase-2 static markup extraction (mirrors locales/en/shell.js appendix).
  'dock.ariaLabel': 'Controles de navegación, voz y preajustes visuales',
  'actions.navAriaLabel': 'Acciones del globo',
  'actions.share.title': 'Copiar enlace para compartir',
  'actions.resetView.title': 'Restablecer la cámara y volver a la vista del globo completo',
  'status.framesLoading': 'cargando fotogramas',

  'locale.groupAriaLabel': 'Idioma',

  // Phase-3 runtime extraction (mirrors locales/en/shell.js appendix).
  'loading.status.tilesGoogle': 'Cargando Google 3D Tiles...',
  'loading.status.tilesKeyless': 'Cargando el globo sin clave...',
  'loading.status.systems': 'Inicializando sistemas...',
  'status.liveDataOff': 'DATOS EN VIVO DESACTIVADOS',
  'status.mappedSitesLoaded': 'SITIOS MAPEADOS CARGADOS',
  'status.retryingMappedSites': 'REINTENTANDO SITIOS MAPEADOS',
  'status.fetchingMappedSites': 'OBTENIENDO SITIOS MAPEADOS',
  'status.turningOffLiveData': 'DESACTIVANDO DATOS EN VIVO',
  'status.refreshingLiveData': 'ACTUALIZANDO DATOS EN VIVO',

  // Par de idiomas configurable (espejo del apéndice de locales/en/shell.js).
  'locale.en.ariaLabel': 'Cambiar a inglés',
  'locale.es.ariaLabel': 'Cambiar a español',
  'locale.fr.ariaLabel': 'Cambiar a francés',
};
