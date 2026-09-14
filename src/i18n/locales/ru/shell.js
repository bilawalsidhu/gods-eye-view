// Русский (ru). Глоссарий: docs/TRANSLATORS.md.
//
// This file mirrors locales/en/shell.js key-for-key; values are Russian.
// Do NOT rename, reorder, add, or drop keys: the parity gate enforces exact
// key/placeholder equality with the en catalog, and any plural entry must
// carry ru's full Intl.PluralRules set { one, few, many, other } (none of
// the shell keys is a plural). Typography: «ёлочки» for quotes, no space
// before ? ! : ..., em-dash — with spaces. ru is a shipped catalog, offered
// only when the configured locale pair includes it
// (GEV_DEFAULT_LOCALE / GEV_SECONDARY_LOCALE).
export const NAMESPACE = 'shell';

export default {
  // index.html #title-bar .subtitle
  'title.subtitle': 'НИ ОДНА ТОЧКА НЕ ОСТАНЕТСЯ ПОЗАДИ',
  // index.html .loader-status (initial paint)
  'loading.initialStatus': 'Инициализация фотореалистичного мира...',
  // src/main.js init() loaderStatus writes
  'loading.status.configuring': 'Настройка просмотрщика...',
  'loading.status.tilesUnavailable': 'Google 3D Tiles недоступны ({detail}). Загрузка глобуса без ключа...',
  'loading.status.flying': 'Перелёт в Austin, TX...',
  'loading.status.restoring': 'Восстановление общего вида...',
  // index.html #global-loading-label (initial) and
  // src/loadingFeedback.js presentLoadingFeedback() labels
  'status.loadingLiveData': 'ЗАГРУЗКА ДАННЫХ В РЕАЛЬНОМ ВРЕМЕНИ',
  'status.loadComplete': 'ЗАГРУЗКА ЗАВЕРШЕНА',
  'status.loadFailed': 'ОШИБКА ЗАГРУЗКИ',
  'status.loadCancelled': 'ЗАГРУЗКА ОТМЕНЕНА',
  // index.html #traffic-sync-label (initial) and
  // src/loadingFeedback.js reduceTrafficSyncFeedback() neutral fallback
  'status.trafficSyncing': 'синхронизация дорожной сети',
  // index.html #top-center-actions buttons
  'actions.clearLayers.ariaLabel': 'Очистить выбранные слои данных',
  'actions.clearLayers.title': 'Выключить все выбранные слои данных',
  'actions.share.ariaLabel': 'Скопировать ссылку для общего доступа',
  'actions.resetView.ariaLabel': 'Вернуть полный вид глобуса',
  // index.html #data-toggles panel header
  'panels.dataLayers': 'СЛОИ ДАННЫХ',
  // index.html .panel-collapse-btn on #data-panel
  'panels.collapseTitle': 'Свернуть панель',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // index.html #command-dock nav region
  'dock.ariaLabel': 'Управление навигацией, голосом и визуальными пресетами',
  // index.html #top-center-actions nav
  'actions.navAriaLabel': 'Действия с глобусом',
  'actions.share.title': 'Скопировать ссылку для общего доступа',
  'actions.resetView.title': 'Сбросить камеру и вернуть полный вид глобуса',
  // index.html #cctv-sync-label (initial); src/ui.js setSplitFlapText() fallback
  'status.framesLoading': 'загрузка кадров',

  // Locale selector (index.html #control-panel tray): the group container is
  // static; its buttons are runtime-rendered by ui.js _initLocaleSelector()
  // from the configured locale pair (keys at the end of this file).
  'locale.groupAriaLabel': 'Язык',

  // ── Phase-3 runtime extraction (support worker), appended ─────────────────
  // src/main.js init() loaderStatus write sites without a phase-1/2 key.
  'loading.status.tilesGoogle': 'Загрузка Google 3D Tiles...',
  'loading.status.tilesKeyless': 'Загрузка глобуса без ключа...',
  'loading.status.systems': 'Инициализация систем...',
  // src/loadingFeedback.js presentLoadingFeedback() labels beyond the phase-1
  // seeds. 'OpenStreetMap · Overpass' detail strings are provider names and
  // stay verbatim at the call site.
  'status.liveDataOff': 'ДАННЫЕ В РЕАЛЬНОМ ВРЕМЕНИ ВЫКЛЮЧЕНЫ',
  'status.mappedSitesLoaded': 'МЕСТА НА КАРТЕ ЗАГРУЖЕНЫ',
  'status.retryingMappedSites': 'ПОВТОРНАЯ ЗАГРУЗКА МЕСТ НА КАРТЕ',
  'status.fetchingMappedSites': 'ЗАГРУЗКА МЕСТ НА КАРТЕ',
  'status.turningOffLiveData': 'ВЫКЛЮЧЕНИЕ ДАННЫХ В РЕАЛЬНОМ ВРЕМЕНИ',
  'status.refreshingLiveData': 'ОБНОВЛЕНИЕ ДАННЫХ В РЕАЛЬНОМ ВРЕМЕНИ',

  // ── Configurable locale pair (GEV_DEFAULT_LOCALE / GEV_SECONDARY_LOCALE,
  // vite.config.js client defines), appended ────────────────────────────
  // ui.js _initLocaleSelector() renders one runtime button per offered
  // locale and reads shell.locale.<code>.ariaLabel for its aria-label.
  'locale.en.ariaLabel': 'Переключиться на английский',
  'locale.es.ariaLabel': 'Переключиться на испанский',
  'locale.fr.ariaLabel': 'Переключиться на французский',
  'locale.ru.ariaLabel': 'Переключиться на русский',
  'locale.uk.ariaLabel': 'Переключиться на украинский',

  'credits.closeAria': 'Закрыть атрибуцию данных',
};
