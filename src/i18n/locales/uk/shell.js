// Українська (uk). Глосарій: docs/TRANSLATORS.md.
//
// This file mirrors locales/en/shell.js key-for-key; values are Ukrainian.
// Do NOT rename, reorder, add, or drop keys: the parity gate enforces exact
// key/placeholder/plural-shape equality with the en catalog. Ukrainian is
// registered as a shipped catalog but is only offered when the configured
// locale pair includes it (GEV_DEFAULT_LOCALE / GEV_SECONDARY_LOCALE).
export const NAMESPACE = 'shell';

export default {
  // index.html #title-bar .subtitle
  'title.subtitle': 'НІКОГО НЕ ЗАЛИШАЄМО ПОЗАДУ',
  // index.html .loader-status (initial paint)
  'loading.initialStatus': 'Ініціалізація фотореалістичного світу...',
  // src/main.js init() loaderStatus writes
  'loading.status.configuring': 'Налаштування переглядача...',
  'loading.status.tilesUnavailable': 'Google 3D Tiles недоступні ({detail}). Завантаження глобуса без ключа...',
  'loading.status.flying': 'Переліт до Austin, TX...',
  'loading.status.restoring': 'Відновлення спільного вигляду...',
  // index.html #global-loading-label (initial) and
  // src/loadingFeedback.js presentLoadingFeedback() labels
  'status.loadingLiveData': 'ЗАВАНТАЖЕННЯ ДАНИХ У РЕАЛЬНОМУ ЧАСІ',
  'status.loadComplete': 'ЗАВАНТАЖЕННЯ ЗАВЕРШЕНО',
  'status.loadFailed': 'ПОМИЛКА ЗАВАНТАЖЕННЯ',
  'status.loadCancelled': 'ЗАВАНТАЖЕННЯ СКАСОВАНО',
  // index.html #traffic-sync-label (initial) and
  // src/loadingFeedback.js reduceTrafficSyncFeedback() neutral fallback
  'status.trafficSyncing': 'синхронізація дорожньої мережі',
  // index.html #top-center-actions buttons
  'actions.clearLayers.ariaLabel': 'Очистити вибрані шари даних',
  'actions.clearLayers.title': 'Вимкнути всі вибрані шари даних',
  'actions.share.ariaLabel': 'Копіювати посилання для поширення',
  'actions.resetView.ariaLabel': 'Скинути до загального вигляду глобуса',
  // index.html #data-toggles panel header
  'panels.dataLayers': 'ШАРИ ДАНИХ',
  // index.html .panel-collapse-btn on #data-panel
  'panels.collapseTitle': 'Згорнути панель',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // index.html #command-dock nav region
  'dock.ariaLabel': 'Керування навігацією, голосом і візуальними пресетами',
  // index.html #top-center-actions nav
  'actions.navAriaLabel': 'Дії з глобусом',
  'actions.share.title': 'Копіювати посилання для поширення',
  'actions.resetView.title': 'Скинути камеру та повернутися до загального вигляду глобуса',
  // index.html #cctv-sync-label (initial); src/ui.js setSplitFlapText() fallback
  'status.framesLoading': 'завантаження кадрів',

  // Locale selector (index.html #control-panel tray): the group container is
  // static; its buttons are runtime-rendered by ui.js _initLocaleSelector()
  // from the configured locale pair (keys at the end of this file).
  'locale.groupAriaLabel': 'Мова',

  // ── Phase-3 runtime extraction (support worker), appended ─────────────────
  // src/main.js init() loaderStatus write sites without a phase-1/2 key.
  'loading.status.tilesGoogle': 'Завантаження Google 3D Tiles...',
  'loading.status.tilesKeyless': 'Завантаження глобуса без ключа...',
  'loading.status.systems': 'Ініціалізація систем...',
  // src/loadingFeedback.js presentLoadingFeedback() labels beyond the phase-1
  // seeds. 'OpenStreetMap · Overpass' detail strings are provider names and
  // stay verbatim at the call site.
  'status.liveDataOff': 'ДАНІ У РЕАЛЬНОМУ ЧАСІ ВИМКНЕНО',
  'status.mappedSitesLoaded': 'МІСЦЯ НА КАРТІ ЗАВАНТАЖЕНО',
  'status.retryingMappedSites': 'ПОВТОРНЕ ЗАВАНТАЖЕННЯ МІСЦЬ НА КАРТІ',
  'status.fetchingMappedSites': 'ЗАВАНТАЖЕННЯ МІСЦЬ НА КАРТІ',
  'status.turningOffLiveData': 'ВИМКНЕННЯ ДАНИХ У РЕАЛЬНОМУ ЧАСІ',
  'status.refreshingLiveData': 'ОНОВЛЕННЯ ДАНИХ У РЕАЛЬНОМУ ЧАСІ',

  // ── Configurable locale pair (GEV_DEFAULT_LOCALE / GEV_SECONDARY_LOCALE,
  // vite.config.js client defines), appended ────────────────────────────
  // ui.js _initLocaleSelector() renders one runtime button per offered
  // locale and reads shell.locale.<code>.ariaLabel for its aria-label.
  'locale.en.ariaLabel': 'Перейти на англійську',
  'locale.es.ariaLabel': 'Перейти на іспанську',
  'locale.fr.ariaLabel': 'Перейти на французьку',
  'locale.ru.ariaLabel': 'Перейти на російську',
  'locale.uk.ariaLabel': 'Перейти на українську',

  'credits.closeAria': 'Закрити відомості про джерела даних',
};
