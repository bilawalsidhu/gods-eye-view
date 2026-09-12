// Français international neutre (fr). Glossaire : docs/TRANSLATORS.md.
//
// This file mirrors locales/en/shell.js key-for-key; values are neutral
// international French. Do NOT rename, reorder, add, or drop keys: the
// parity gate enforces exact key/placeholder/plural-shape equality with
// the en catalog. French is registered as a shipped catalog but is only
// offered when the configured locale pair includes it
// (GEV_DEFAULT_LOCALE / GEV_SECONDARY_LOCALE).
export const NAMESPACE = 'shell';

export default {
  // index.html #title-bar .subtitle
  'title.subtitle': 'AUCUN ENDROIT DANS L\'ANGLE MORT',
  // index.html .loader-status (initial paint)
  'loading.initialStatus': 'Initialisation du monde photoréaliste...',
  // src/main.js init() loaderStatus writes
  'loading.status.configuring': 'Configuration du visualiseur...',
  'loading.status.tilesUnavailable': 'Google 3D Tiles indisponible ({detail}). Chargement du globe sans clé...',
  'loading.status.flying': 'Vol vers Austin, TX...',
  'loading.status.restoring': 'Restauration de la vue partagée...',
  // index.html #global-loading-label (initial) and
  // src/loadingFeedback.js presentLoadingFeedback() labels
  'status.loadingLiveData': 'CHARGEMENT DES DONNÉES EN DIRECT',
  'status.loadComplete': 'CHARGEMENT TERMINÉ',
  'status.loadFailed': 'ÉCHEC DU CHARGEMENT',
  'status.loadCancelled': 'CHARGEMENT ANNULÉ',
  // index.html #traffic-sync-label (initial) and
  // src/loadingFeedback.js reduceTrafficSyncFeedback() neutral fallback
  'status.trafficSyncing': 'synchronisation du réseau routier',
  // index.html #top-center-actions buttons
  'actions.clearLayers.ariaLabel': 'Effacer les couches de données sélectionnées',
  'actions.clearLayers.title': 'Désactiver toutes les couches de données sélectionnées',
  'actions.share.ariaLabel': 'Copier le lien de partage',
  'actions.resetView.ariaLabel': 'Réinitialiser la vue complète du globe',
  // index.html #data-toggles panel header
  'panels.dataLayers': 'COUCHES DE DONNÉES',
  // index.html .panel-collapse-btn on #data-panel
  'panels.collapseTitle': 'Réduire le panneau',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // index.html #command-dock nav region
  'dock.ariaLabel': 'Commandes de navigation, de voix et de préréglages visuels',
  // index.html #top-center-actions nav
  'actions.navAriaLabel': 'Actions du globe',
  'actions.share.title': 'Copier le lien de partage',
  'actions.resetView.title': 'Réinitialiser la caméra et revenir à la vue complète du globe',
  // index.html #cctv-sync-label (initial); src/ui.js setSplitFlapText() fallback
  'status.framesLoading': 'chargement des images',

  // Locale selector (index.html #control-panel tray): the group container is
  // static; its buttons are runtime-rendered by ui.js _initLocaleSelector()
  // from the configured locale pair (keys at the end of this file).
  'locale.groupAriaLabel': 'Langue',

  // ── Phase-3 runtime extraction (support worker), appended ─────────────────
  // src/main.js init() loaderStatus write sites without a phase-1/2 key.
  'loading.status.tilesGoogle': 'Chargement de Google 3D Tiles...',
  'loading.status.tilesKeyless': 'Chargement du globe sans clé...',
  'loading.status.systems': 'Initialisation des systèmes...',
  // src/loadingFeedback.js presentLoadingFeedback() labels beyond the phase-1
  // seeds. 'OpenStreetMap · Overpass' detail strings are provider names and
  // stay verbatim at the call site.
  'status.liveDataOff': 'DONNÉES EN DIRECT DÉSACTIVÉES',
  'status.mappedSitesLoaded': 'SITES CARTOGRAPHIÉS CHARGÉS',
  'status.retryingMappedSites': 'RÉESSAI DES SITES CARTOGRAPHIÉS',
  'status.fetchingMappedSites': 'RÉCUPÉRATION DES SITES CARTOGRAPHIÉS',
  'status.turningOffLiveData': 'DÉSACTIVATION DES DONNÉES EN DIRECT',
  'status.refreshingLiveData': 'ACTUALISATION DES DONNÉES EN DIRECT',

  // ── Configurable locale pair (GEV_DEFAULT_LOCALE / GEV_SECONDARY_LOCALE,
  // vite.config.js client defines), appended ────────────────────────────
  // ui.js _initLocaleSelector() renders one runtime button per offered
  // locale and reads shell.locale.<code>.ariaLabel for its aria-label.
  'locale.en.ariaLabel': 'Passer à l\'anglais',
  'locale.es.ariaLabel': 'Passer à l\'espagnol',
  'locale.fr.ariaLabel': 'Passer au français',

  'credits.closeAria': 'Fermer les crédits de données',
};
