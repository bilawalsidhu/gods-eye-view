// Русский (ru). Глоссарий: docs/TRANSLATORS.md.
export const NAMESPACE = 'cockpit';

export default {
  // index.html #cockpit-hud section aria-label
  'hud.sectionLabel': 'Вид кабины самолёта',
  // index.html #map-view-switch button label
  'exit.label': 'ВЫЙТИ ИЗ КАБИНЫ',
  // index.html .cockpit-readout-label
  'readout.groundSpeed': 'СКОРОСТЬ',
  'readout.altitude': 'ВЫСОТА',
  // index.html .cockpit-context-kicker / #cockpit-context-subject (initial)
  'context.kicker': 'КОНТАКТ',
  'context.subjectWindow': 'КОНТАКТЫ · 250 KM',
  // index.html #cockpit-brief-kicker / #cockpit-brief-subtitle (initial)
  'brief.kicker': 'СИГНАЛЫ В РЕАЛЬНОМ ВРЕМЕНИ',
  'brief.subtitle': 'НАБЛЮДАЕМЫЕ / КАРТОГРАФИРОВАННЫЕ ПИНГИ',
  // index.html #cockpit-vision-current small label
  'vision.current': 'ТЕКУЩИЙ',
  // index.html #cockpit-radio-station (initial)
  'radio.station.ready': 'ГОТОВА',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (docs/TRANSLATORS.md cross-surface rule); these keys land here because
  // src/ui.js and src/hud.js own the surfaces' runtime half in phase 3.

  // index.html #style-indicator / #clean-view-exit (visual-style chrome)
  'presets.activeStyleLabel': 'АКТИВНЫЙ СТИЛЬ',
  'display.cleanViewExitTitle': 'Вернуть управление интерфейсом',
  'display.cleanViewExitLabel': 'ВЫЙТИ ИЗ ЧИСТОГО ВИДА',

  // index.html control panel — Visual Presets dock tray
  'presets.toggleAriaLabel': 'Развернуть визуальные пресеты',
  // Key-only: the .panel-title node shares its element with the dock-label-icon
  // span, so a data-i18n write would wipe the icon; phase 3 wires this via t().
  'presets.title': 'ВИЗУАЛЬНЫЕ ПРЕСЕТЫ',
  'presets.pinAriaLabel': 'Закрепить визуальные пресеты',
  'presets.pinTitle': 'Держать визуальные пресеты открытыми',
  'presets.styleNormalTitle': 'Показывает глобус без визуального фильтра.',
  'presets.styleNormalLabel': 'Обычный',
  'presets.styleCrtTitle': 'Имитирует CRT-экран с зелёным люминофором, строками развёртки и кривизной экрана.',
  'presets.styleCrtLabel': 'CRT',
  'presets.styleNvgTitle': 'Имитирует приборы ночного видения с зелёным усилением изображения и виньеткой трубки.',
  'presets.styleNvgLabel': 'NVG',
  'presets.styleFlirTitle': 'Имитирует тепловой контраст в стиле FLIR. Поднимите Ironbow для цвета.',
  'presets.styleFlirLabel': 'FLIR',
  'presets.styleAnimeTitle': 'Применяет яркие cel-shading-цвета и рисованные контуры.',
  'presets.styleAnimeLabel': 'Аниме',
  'presets.styleNoirTitle': 'Применяет высококонтрастную монохромную цветокоррекцию в стиле нуар.',
  'presets.styleNoirLabel': 'Нуар',
  'presets.styleSnowTitle': 'Добавляет в сцену холодный снежный эффект «белой мглы».',
  'presets.styleSnowLabel': 'Снег',
  // Key-only: the static span text is pinned verbatim by mapStackChips.test.mjs
  // (id="map-source-label">MAP SOURCE<), so no attribute can be added without
  // touching that test; phase 3 owns the swap.
  'presets.mapSourceLabel': 'ИСТОЧНИК КАРТЫ',
  // Key-only: the chip-row tag is pinned literally by mapStackChips.test.mjs.
  'presets.mapSourceChipsAriaLabel': 'Источник карты',
  'presets.miniStyleLabel': 'Стиль',

  // index.html #pp-toggles DISPLAY rail
  // Key-only: .pp-header-label text is pinned verbatim by panelStackLayout.test.mjs.
  'display.title': 'ЭКРАН',
  'display.collapseTitle': 'Свернуть панель',
  'display.hudToggleTitle': 'HUD разведки (H)',
  'display.hudLayoutLabel': 'Макет',
  'display.hudLayoutAriaLabel': 'Макет HUD',
  'display.hudLayoutTactical': 'Тактический',
  'display.hudLayoutOperator': 'Операторский',
  'display.hudLayoutMinimal': 'Минимальный',
  'display.detectionToggleTitle': 'Слой детекции (D)',
  'display.detectionAriaLabel': 'Слой детекции',
  'display.detectionLabel': 'ДЕТЕКЦИЯ',
  'display.densityLabel': 'Плотность',
  'display.densityAriaLabel': 'Плотность меток детекции',
  'display.allocationLabel': 'Размещение',
  'display.allocationAriaLabel': 'Размещение меток детекции',
  'display.allocationElastic': 'Гибкое',
  'display.allocationWeighted': 'Взвешенное',
  'display.fadeLabel': 'Затухание',
  'display.fadeAriaLabel': 'Дистанция затухания детекции',
  'display.fadeTitle': 'Дистанция затухания мирового слоя за пределами маски в процентах от её радиуса',
  'display.outsideLabel': 'Снаружи',
  'display.outsideAriaLabel': 'Непрозрачность детекции за пределами маски',
  'display.outsideTitle': 'Непрозрачность меток и карточек мирового слоя за пределами дистанции затухания',
  'display.parametersTitle': 'ПАРАМЕТРЫ',
  'display.parametersCollapseTitle': 'Свернуть панель',
  'display.modelsToggleTitle': '3D-самолёты — издалека плоские иконки, вблизи 3D-модели',
  'display.modelsLabel': 'Модели',
  'display.modelsCoverageAriaLabel': 'Зона обзора 3D-моделей',
  'display.modelsModeProximity': 'Вблизи',
  'display.modelsModeAll': 'Все',
  'display.scopeToggleTitle': 'Обзор — круглая маска области просмотра',
  'display.scopeLabel': 'Обзор',
  'display.featherLabel': 'Растушёвка',
  'display.featherTitle': 'Растушёвка края обзора в процентах от радиуса маски',
  'display.celestialToggleTitle': 'Небесное кольцо — показать весь глобус',
  'display.celestialLabel': 'Небесное',
  'display.cleanViewToggleTitle': 'Скрыть элементы интерфейса',
  'display.cleanViewLabel': 'Чистый интерфейс',
  'display.bloomToggleTitle': 'Bloom / свечение',
  'display.bloomLabel': 'Bloom',
  'display.sharpenToggleTitle': 'Повышение резкости',
  'display.sharpenLabel': 'Резкость',

  // index.html location bar (dock locations tray; ui.js owns the runtime half)
  // Key-only: .location-toolbar-label shares its element with dock-label-icon.
  'location.toolbarLabel': 'МЕСТО',
  'location.collapseTitle': 'Свернуть панель',
  'location.pinAriaLabel': 'Закрепить панель места',
  'location.pinTitle': 'Держать панель места открытой',
  // Initial mini-status values; ui.js rewrites both once a place resolves.
  'location.miniCityInitial': '📍 Место: --',
  'location.miniPoiInitial': 'Ориентир: --',
  'location.searchToggleTitle': 'Поиск любого места',
  'location.searchPlaceholder': 'Поиск любого места...',

  // index.html cockpit HUD statics
  'hud.level': 'УРОВЕНЬ',
  'hud.routeDirectionAriaLabel': 'Расчётное направление на пункт назначения',
  // Initial idle readout; ui.js rewrites it with a live bearing.
  'hud.routeDirectionIdle': 'DEST ---°',
  'hud.visorPlane': 'ОПТИЧЕСКАЯ ПЛОСКОСТЬ · 01',
  'hud.visorLock': 'БЛОКИРОВКА ВИЗОРА · АКТИВНА',
  'hud.firstPerson': 'ОТ ПЕРВОГО ЛИЦА',
  // Initial meta line; ui.js rewrites it from live track state.
  'hud.aircraftMetaInitial': 'ТРЕК В РЕАЛЬНОМ ВРЕМЕНИ · КУРС СОВМЕЩЁН',
  'hud.visionGroupAriaLabel': 'Стиль обзора кабины',
  'hud.compassAriaLabel': 'Текущий курс самолёта',
  'readout.rimGroundSpeed': 'СКОРОСТЬ · KTS',
  'readout.rimAltitude': 'ВЫСОТА · FT',

  // index.html cockpit vision controls
  'vision.previousLabel': 'ПРЕД',
  'vision.previousAriaLabel': 'Предыдущий стиль обзора кабины',
  'vision.previousTitle': 'Предыдущий стиль обзора',
  // The NORMAL token inside these two is the style name; phase 3 splits the
  // dynamic token out when the runtime half is extracted.
  'vision.currentAriaLabel': 'Текущий стиль обзора кабины: NORMAL. Активируйте для следующего стиля.',
  'vision.currentTitle': 'Текущий стиль: NORMAL — нажмите для следующего',
  'vision.nextLabel': 'СЛЕД',
  'vision.nextAriaLabel': 'Следующий стиль обзора кабины',
  'vision.nextTitle': 'Следующий стиль обзора',

  // index.html view switcher
  'exit.navAriaLabel': 'Переключатель вида',
  'exit.resetAriaLabel': 'Сбросить кабину к виду всего глобуса',
  'exit.resetTitle': 'Выйти из кабины и вернуться к виду всего глобуса',
  'exit.resetLabel': 'СБРОС',
  'exit.ariaLabel': 'Выйти из вида кабины',
  'exit.title': 'Выйти из вида кабины',

  // index.html cockpit route card
  'route.cardAriaLabel': 'Расчётный план полёта',
  'route.kicker': 'РАСЧЁТНЫЙ ПЛАН ПОЛЁТА',
  'route.statusUnavailable': 'ДАННЫЕ МАРШРУТА НЕДОСТУПНЫ',
  'route.fromLabel': 'ИЗ',
  'route.toLabel': 'В',
  'route.unknownEndpoint': 'НЕИЗВЕСТНО',

  // index.html cockpit briefing carousel
  // (brief.kicker 'LIVE SIGNALS' is seeded above but is KEY-ONLY: #cockpit-brief-kicker
  // shares its element with the live-dot <i>, so no data-i18n attribute can target it.)
  'brief.carouselAriaLabel': 'Карусель брифингов кабины',
  'brief.actionsAriaLabel': 'Управление брифингом кабины',
  'brief.previousAriaLabel': 'Предыдущая страница брифинга',
  'brief.previousTitle': 'Предыдущая страница брифинга',
  'brief.nextAriaLabel': 'Следующая страница брифинга',
  'brief.nextTitle': 'Следующая страница брифинга',
  // Title is static prose; the visible label + aria-label are CYCLE ON/OFF
  // states that belong to the phase-3 runtime extraction.
  'brief.autoTitle': 'Автоматически перелистывает страницы брифинга каждые 9 секунд (Сигналы → Новости → Место). Пауза при наведении на панель или фокусе на ней. Данные сигналов в реальном времени в любом случае обновляются непрерывно.',
  'brief.collapseAriaLabel': 'Свернуть панель брифинга кабины',
  'brief.collapseTitle': 'Свернуть панель брифинга',
  'brief.signalsAriaLabel': 'Сигналы в реальном времени',
  'brief.newsAriaLabel': 'Последние региональные новости',
  'brief.localAriaLabel': 'Информация по текущему месту',
  'brief.newsAcquiring': 'ЗАГРУЗКА РЕГИОНАЛЬНЫХ НОВОСТЕЙ',
  'brief.localResolving': 'ОПРЕДЕЛЕНИЕ РЕГИОНА',
  'brief.labelTemp': 'ТЕМП',
  'brief.labelWind': 'ВЕТЕР',
  'brief.labelSky': 'НЕБО',
  'brief.labelPrecip': 'ОСАДКИ',
  'brief.sourceNote': 'СОБЫТИЯ С ИСТОЧНИКАМИ · БЕЗ СИНТЕТИЧЕСКИХ НОВОСТЕЙ',
  'brief.tabSignalsAriaLabel': 'Показать сигналы в реальном времени',
  'brief.tabNewsAriaLabel': 'Показать региональные новости',
  'brief.tabLocalAriaLabel': 'Показать местную информацию',

  // index.html cockpit context panel (right-rail Global Context included)
  'context.panelAriaLabel': 'Сводка по контакту в кабине',
  'context.navAriaLabel': 'Навигация по контактам',
  'context.previousAriaLabel': 'Назад — предыдущий посещённый контакт в радиусе 250 KM',
  'context.previousTitle': 'Назад — предыдущий посещённый контакт в радиусе 250 KM',
  'context.nextAriaLabel': 'Вперёд — ближайший непосещённый контакт в радиусе 250 KM',
  'context.nextTitle': 'Вперёд — ближайший непосещённый контакт в радиусе 250 KM',
  'context.toggleAriaLabel': 'Свернуть панель контактов',
  'context.toggleTitle': 'Свернуть панель контактов',
  'context.qualifier': 'ТОЛЬКО КОНТЕКСТ',
  'context.cohortsAriaLabel': 'Счётчики близлежащих групп',
  'context.nearestLabel': 'БЛИЖАЙШИЕ НАБЛЮДАЕМЫЕ / КАРТОГРАФИРОВАННЫЕ',
  'context.nearestEmpty': 'НЕТ ДОСТУПНОГО ПРИМЕРА',
  'context.uncertaintyNote': 'ТОЛЬКО ДОСТУПНЫЕ ДАННЫЕ · БЕЗОПАСНОСТЬ НЕ ПОДТВЕРЖДЕНА',
  'context.weatherEnableAriaLabel': 'Включить погодные эффекты кабины',
  'context.weatherEnableTitle': 'Включить погодные эффекты кабины',
  'context.panelTitle': 'КОНТЕКСТ',
  'context.collapseTitle': 'Развернуть панель',
  'context.modesAriaLabel': 'Режим контекста',
  'context.contactsTabAriaLabel': 'КОНТАКТЫ',
  'context.contactsTabTitle': 'Перебирает ближайшие контакты выбранного типа — самолёты, суда, объекты. Спутники отслеживаются отдельно.',
  'context.contactsTabLabel': 'КОНТАКТЫ',
  'context.missionsTabLabel': 'КОСМИЧЕСКИЕ МИССИИ',
  'context.standbyTitle': 'ВЫБЕРИТЕ КОНТЕКСТ',
  'context.actionsAriaLabel': 'Действия контекста контакта',
  'context.cockpitEntryLabel': 'КАБИНА',
  'context.searchNearbyLabel': 'ПОИСК БЛИЖАЙШИХ ОБЪЕКТОВ',
  'context.tr3bAriaLabel': 'Переклассифицировать отслеживаемый контакт как TR-3B',
  'context.tr3bTitle': 'Переклассифицировать как TR-3B',
  'context.awarenessOffTitle': 'КОНТЕКСТ КОНТАКТОВ ВЫКЛЮЧЕН',
  'context.awarenessOffHint': 'ВЫБЕРИТЕ КОНТАКТЫ ДЛЯ ЗАГРУЗКИ НАБЛЮДАЕМЫХ / КАРТОГРАФИРОВАННЫХ ПИНГОВ',
  'context.rosterAriaLabel': 'Доступные космические миссии',
  'context.rosterTitle': 'ДОСТУПНЫЕ МИССИИ',
  'context.rosterHint': 'ВЫБЕРИТЕ МИССИЮ ДЛЯ ПРОСМОТРА',
  'context.rosterLoading': 'ЗАГРУЗКА ИНДЕКСА МИССИЙ ЗА 30 ДНЕЙ',
  'context.radioToggleAriaLabel': 'Открыть компактное управление радио',
  'context.radioToggleTitle': 'Открыть компактное управление радио',
  'context.radioMiniGroupAriaLabel': 'Компактное управление радио',
  'context.radioMiniTitle': 'РАДИО',
  'context.radioMiniReady': 'РАДИО ГОТОВО',
  'context.radioDetailsAriaLabel': 'Открыть подробное управление радио',
  'context.radioDetailsTitle': 'Открыть подробное управление радио',
  'context.radioCloseAriaLabel': 'Закрыть компактное управление радио',
  'context.radioCloseTitle': 'Закрыть компактное управление радио',
  'context.radioMiniEnable': 'ВКЛЮЧИТЬ',
  'context.radioMiniPrevAriaLabel': 'Предыдущая отфильтрованная радиостанция',
  'context.radioMiniPrevTitle': 'Предыдущая станция',
  'context.radioMiniPlayAriaLabel': 'Воспроизвести выбранную радиостанцию',
  'context.radioMiniPlayTitle': 'Воспроизвести',
  'context.radioMiniNextAriaLabel': 'Следующая отфильтрованная радиостанция',
  'context.radioMiniNextTitle': 'Следующая станция',
  'context.radioMiniVolumeLabel': 'ГРОМКОСТЬ',
  'context.radioMiniVolumeAriaLabel': 'Громкость компактного радио',

  // index.html cockpit utility controls + compact radio popover
  'utility.controlsAriaLabel': 'Управление экраном и радио кабины',
  'utility.displayLabel': 'ЭКРАН',
  'utility.radioLabel': 'РАДИО',
  'utility.displayToggleAriaLabel': 'Развернуть параметры экрана кабины',
  'utility.displayToggleTitle': 'Развернуть параметры экрана кабины',
  'utility.displayPanelAriaLabel': 'Параметры экрана кабины',
  'utility.radioToggleAriaLabel': 'Развернуть управление радио кабины',
  'utility.radioToggleTitle': 'Развернуть управление радио кабины',
  'utility.radioPanelAriaLabel': 'Компактное управление радио кабины',
  'radio.enable': 'ВКЛЮЧИТЬ',
  'radio.prevAriaLabel': 'Предыдущая отфильтрованная радиостанция',
  'radio.playAriaLabel': 'Воспроизвести выбранную радиостанцию',
  'radio.nextAriaLabel': 'Следующая отфильтрованная радиостанция',
  'radio.volumeLabel': 'ГРОМКОСТЬ',
  'radio.volumeAriaLabel': 'Громкость радио кабины',

  // ── Phase-3 runtime extraction (src/ui.js), appended ─────────────────────
  // Values stay byte-identical to the previous English literals; existing
  // tests pin many of them under the default locale.

  // _syncPanelCollapseButton(): composed panel collapse titles. {name} is the
  // panel's own (already localized) .panel-title text.
  'panel.expandTitle': 'Развернуть {name}',
  'panel.collapseTitle': 'Свернуть {name}',
  // Fallback when a panel ships no .panel-title/.pp-header-label node.
  'panel.fallbackName': 'панель',
  // Radio panel collapse state; the expand state reuses the layers.radio.*
  // keys seeded on the static button in phase 2.
  'panel.radioCollapseTitle': 'Свернуть радио',
  'panel.radioCollapseAria': 'Свернуть раздел радио',
  // _updateLocationMiniStatus(): runtime rewrite of the collapsed LOCATION
  // readout's single-segment search fallback (initial-state keys
  // location.miniCityInitial/miniPoiInitial were seeded in phase 2).
  'location.miniSearchedPlaceholder': 'Найденное место',

  // ── Phase-3 runtime extraction batch 2: cockpit + Context renderers ───────

  // syncWeatherToggle(): state-sibling keys for the runtime ON/OFF rewrite
  // (context.weatherEnableAriaLabel was seeded on the static button).
  'context.weatherDisableAriaLabel': 'Выключить погодные эффекты кабины',
  'context.weatherStateOn': 'ВКЛ',
  'context.weatherStateOff': 'ВЫКЛ',
  // syncTr3bToggle(): converted-state title sibling of context.tr3bTitle.
  'context.tr3bRestoreTitle': 'Вернуть реальный самолёт',
  // setVisionMode(): the style token is dynamic, so the sentence is split out
  // of the seeded vision.currentAriaLabel/currentTitle (whose values pin the
  // NORMAL default) into {style} templates.
  'vision.styleNameNightVision': 'Ночное видение',
  'vision.styleNameThermal': 'Тепловизор',
  'vision.styleNameNoir': 'Нуар',
  'vision.currentAriaTemplate': 'Текущий стиль обзора кабины: {style}. Активируйте для следующего стиля.',
  'vision.currentTitleTemplate': 'Текущий стиль: {style} — нажмите для следующего',

  // Cockpit signal stream (pushCockpitSignal / renderCockpitSignals).
  'signal.trackAcquired': 'ЦЕЛЬ ЗАХВАЧЕНА',
  'signal.trackDetail': '{label} · КУРС {heading}°',
  'signal.selectFlightAria': 'Выбрать рейс {title}',
  'signal.contextStandby': 'КОНТЕКСТ В ОЖИДАНИИ',
  'signal.contextStandbyHint': 'ВКЛЮЧИТЕ ГЛОБАЛЬНЫЙ КОНТЕКСТ ДЛЯ ПИНГОВ ОКРЕСТНОСТИ',
  'signal.contactLostTitle': 'КОНТАКТ ПОТЕРЯН · {subject}',
  'signal.contactLostDetail': 'ОБЪЕКТ ПОКИНУЛ КАНАЛ ДАННЫХ · ИНДИКАТОР ДЕРЖИТ ПОСЛЕДНИЕ ИЗВЕСТНЫЕ ДАННЫЕ',
  'signal.classMilitary': 'ВОЕННЫЙ РЕЙС',
  'signal.classCommercial': 'ГРАЖДАНСКИЙ РЕЙС',
  'signal.contactCurrent': '{aircraftClass} · ТЕКУЩИЙ',
  'signal.contactRange': '{aircraftClass} · {distance}',
  'signal.distanceUnknown': 'ДИСТАНЦИЯ НЕИЗВЕСТНА',
  'signal.inputsUnknown': {
    one: '{count} ВХОДНОЙ ПАРАМЕТР НЕИЗВЕСТЕН',
    few: '{count} ВХОДНЫХ ПАРАМЕТРА НЕИЗВЕСТНЫ',
    many: '{count} ВХОДНЫХ ПАРАМЕТРОВ НЕИЗВЕСТНО',
    other: '{count} ВХОДНОГО ПАРАМЕТРА НЕИЗВЕСТНО',
  },
  'signal.sourceStatusUnavailable': 'СТАТУС ИСТОЧНИКА НЕДОСТУПЕН',

  // updateHud(): callsign fallback + the composed aircraft meta line (each
  // feed state is its own key so no state can leak English later).
  'hud.fallbackCallsign': 'САМОЛЁТ',
  'hud.metaClassMilitary': 'ВОЕННЫЙ',
  'hud.metaClassCommercial': 'ГРАЖДАНСКИЙ',
  'hud.metaFeedAcquiringSurface': 'ЗАГРУЗКА ПОВЕРХНОСТИ',
  'hud.metaFeedSurfaceFallback': 'РЕЗЕРВНАЯ ПОВЕРХНОСТЬ',
  'hud.metaFeedStale': 'УСТАРЕВШИЙ КАНАЛ ДАННЫХ',
  'hud.metaFeedLive': 'ТРЕК В РЕАЛЬНОМ ВРЕМЕНИ',
  'hud.aircraftMetaTemplate': '{aircraftClass} · {feedState} · КУРС СОВМЕЩЁН',

  // updateRoute(): runtime state siblings of the seeded route keys.
  'route.statusArrowEstimated': 'СТРЕЛКА · РАСЧЁТНОЕ НАПРАВЛЕНИЕ',
  'route.directionLabel': 'DEST {bearing}',

  // updateContext(): uncertainty/nearest/bearing readout states.
  'context.uncertaintyContactLost': 'КОНТАКТ ПОТЕРЯН · ПОСЛЕДНИЕ ИЗВЕСТНЫЕ ДАННЫЕ · БЕЗОПАСНОСТЬ НЕ ПОДТВЕРЖДЕНА',
  'context.uncertaintyInputsUnknown': {
    one: '{count} ВХОДНОЙ ПАРАМЕТР НЕИЗВЕСТЕН · БЕЗОПАСНОСТЬ НЕ ПОДТВЕРЖДЕНА',
    few: '{count} ВХОДНЫХ ПАРАМЕТРА НЕИЗВЕСТНЫ · БЕЗОПАСНОСТЬ НЕ ПОДТВЕРЖДЕНА',
    many: '{count} ВХОДНЫХ ПАРАМЕТРОВ НЕИЗВЕСТНО · БЕЗОПАСНОСТЬ НЕ ПОДТВЕРЖДЕНА',
    other: '{count} ВХОДНОГО ПАРАМЕТРА НЕИЗВЕСТНО · БЕЗОПАСНОСТЬ НЕ ПОДТВЕРЖДЕНА',
  },
  'context.uncertaintyInputsCurrent': 'ДОСТУПНЫЕ ДАННЫЕ АКТУАЛЬНЫ · БЕЗОПАСНОСТЬ НЕ ПОДТВЕРЖДЕНА',
  'context.nearestTemplate': '{cohort} · {contact}',
  'context.nearestUnavailableAria': '{cohort}, недоступно',
  'context.bearingNone': 'BRG —',
  'context.bearingAhead': 'ПО КУРСУ',
  'context.bearingSide': '{side} {angle}',
  'context.sideLeft': 'L',
  'context.sideRight': 'R',

  // setContextCollapsed()/setSignalCollapsed(): expand-state siblings.
  'context.toggleExpandAriaLabel': 'Развернуть панель контактов',
  'context.toggleExpandTitle': 'Развернуть панель контактов',
  'brief.expandAriaLabel': 'Развернуть панель брифинга кабины',
  'brief.expandTitle': 'Развернуть панель брифинга',

  // setBriefAutoRotate(): cycle toggle states + the ON-state help text (the
  // OFF-state help is the seeded brief.autoTitle).
  'brief.autoOn': 'АВТОПРОКРУТКА ВКЛ',
  'brief.autoOff': 'АВТОПРОКРУТКА ВЫКЛ',
  'brief.autoTitleOn': 'Остановить автоматическую прокрутку страниц. Кнопки «ПРЕД», «СЛЕД» и вкладки SIG/NEWS/LOCAL остаются доступными.',

  // Briefing carousel pages (kicker/subtitle/source per page; the news/local
  // source lines are provider attribution and stay English).
  'brief.kickerNews': 'РЕГИОНАЛЬНЫЕ НОВОСТИ',
  'brief.kickerLocal': 'МЕСТНАЯ ИНФОРМАЦИЯ',
  'brief.subtitleNews': 'ПОСЛЕДНИЕ РЕПОРТАЖИ ПО МЕСТУ',
  'brief.subtitleLocal': 'МЕСТО / УСЛОВИЯ / ПОЗИЦИЯ',

  // Local position + regional brief status states.
  'brief.positionUnavailable': 'ПОЗИЦИЯ НЕДОСТУПНА',
  'brief.newsUnavailable': 'РЕГИОНАЛЬНЫЕ НОВОСТИ НЕДОСТУПНЫ',
  'brief.regionUnavailable': 'РЕГИОН НЕДОСТУПЕН',
  'brief.newsEmpty': 'НЕТ СВЕЖИХ СОВПАДЕНИЙ ПО МЕСТУ',

  // renderRegionalBrief(): article metadata, cloud readout, and age chips.
  'brief.metadataSourceFallback': 'ИСТОЧНИК',
  'brief.articleMetaTemplate': '{domain} · {age}',
  'brief.newsSourceLine': '{source} · ЗАПРОС ПО МЕСТУ',
  'brief.age.timeUnknown': 'ВРЕМЯ НЕИЗВЕСТНО',
  'brief.age.minutes': '{count}М НАЗАД',
  'brief.age.hours': '{count}Ч НАЗАД',
  'brief.age.days': '{count}Д НАЗАД',
  'brief.wind.dirUnknown': 'НАПР. НЕИЗВЕСТНО',
  'brief.cloudTemplate': 'ОБЛАЧНОСТЬ {pct}%',
  'brief.cloudUnknown': 'ОБЛАЧНОСТЬ НЕИЗВЕСТНА',

  // ── Phase-3 runtime extraction batch 3: toasts, loading helpers, map tray ─

  // Panel-chrome + share/location toasts.
  'panel.layoutResetToast': 'Макет панелей обновлён — позиции сброшены к новым значениям по умолчанию',
  'share.toastCopied': 'Ссылка скопирована!',
  'share.toastCopyFailed': 'Не удалось скопировать',
  'location.toastNotFound': 'Место не найдено',
  'location.toastSearchFailed': 'Не удалось выполнить поиск',
  'location.toastFlyToPoiFirst': 'Сначала перелетите к ориентиру',
  'actions.clearLayersBusyAria': 'Очистка выбранных слоёв данных',
  'actions.clearLayersFailedToast': 'Не удалось очистить выбранные слои данных',

  // Global status chip notices (_handleShareTrackingRestoreStatus).
  'status.acquiring': 'ЗАГРУЗКА',
  'status.subjectFallback': 'объект',
  'status.sharedSubjectDetail': 'ОБЩИЙ {subject}',
  'status.sharedFollowExpired': 'Срок отслеживания общего {subject} истёк',
  'status.sharedRestoreFailed': 'Не удалось восстановить общий {subject} — канал данных недоступен',
  'status.sharedUnavailable': 'Общий {subject} недоступен',

  // Context mode user-facing action failures.
  'context.modeContext': 'Контекст',
  'context.modeSpaceMissions': 'Космические миссии',
  'context.toastStartBlocked': 'Не удалось запустить {mode}: другой слой не остановился корректно',
  'context.toastTransitionFailedContacts': 'Контакты не смогли выполнить переключение; попробуйте снова',
  'context.toastTransitionFailedMissions': 'Космические миссии не смогли выполнить переключение; попробуйте снова',
  'context.toastInstallationsRefreshFailed': 'Не удалось обновить ближайшие объекты; попробуйте снова',
  'context.toastRestoreFailed': 'Контексту не удалось восстановить все слои; попробуйте снова',
  'context.toastZoomToSearch': 'Приблизьте, чтобы искать картографированные объекты',
  'context.toastInstallationsRefreshed': 'Ближайшие объекты обновлены',
  'context.toastLayerUnavailable': 'Этот слой недоступен в текущем режиме контекста',
  'context.actionStart': 'запустить',
  'context.actionStop': 'остановить',
  'context.toastLayerLifecycleFailed': 'Не удалось корректно {action} слой {layerId}',
  'radio.toastLifecycleFailed': 'Не удалось корректно {action} радио',

  // CCTV sync chip captions + calibration/availability toasts.
  'cctv.syncLoadingFrames': 'загрузка кадров',
  'cctv.syncGridReady': 'сетка камер готова',
  'cctv.toastCalibrationSaved': 'Калибровка CCTV сохранена',
  'cctv.toastCalibrationReset': 'Калибровка CCTV сброшена',
  'cctv.toastLayerUnavailable': 'Слой CCTV недоступен',

  // _renderMapStackState(): status chip fallback when no stack label resolves
  // (stack names themselves are keep-English provider/stack ids).
  'presets.mapStackFallback': 'КАРТА',

  // ── Phase-3 runtime extraction batch 4: awareness / CCTV / Radio panels ───
  // (radio.* and cctv.* state values that layers.js already seeds are reused
  // cross-namespace; these are the runtime-only siblings and compositions.)

  // _applyRuntimeStaticHeaderText(): the key-only standby description span
  // (both mode descriptions in one span split by a literal <br> in phase 2).
  'context.standbyContactsDesc': 'КОНТАКТЫ — ближайшие самолёты · суда · объекты',
  'context.standbyMissionsDesc': 'КОСМИЧЕСКИЕ МИССИИ — запуски и орбитальные аппараты',
  // _syncContextRadioLauncherState(): close-state sibling of the seeded
  // context.radioToggleAriaLabel ('Open compact Radio controls').
  'context.radioToggleCloseAriaLabel': 'Закрыть компактное управление радио',
  'context.toastMissionsCancelRestoreFailed': 'Не удалось восстановить прежнее состояние слоёв после отмены космических миссий',
  // Cockpit utility disclosures: collapse-state siblings of the seeded
  // utility.*ToggleAriaLabel expand keys.
  'utility.displayToggleCollapseAriaLabel': 'Свернуть параметры экрана кабины',
  'utility.radioToggleCollapseAriaLabel': 'Свернуть управление радио кабины',

  // Radio panel runtime states (state-sibling keys so no state can leak
  // English later; lifecycle enum labels reuse layers.status.*).
  'radio.stateSync': 'СИНХР.',
  'radio.tunerCategoryBand': 'ДИАПАЗОН {category}',
  'radio.tunerNoStations': 'НЕТ СТАНЦИЙ',
  'radio.tunerStationAria': '{name}, станция {index} из {total}',
  'radio.tunerNoStationAria': 'Нет доступной станции',
  'radio.tunerOffAir': 'НЕ В ЭФИРЕ',
  'radio.tunerStationUnavailable': 'СТАНЦИЯ НЕДОСТУПНА',
  'radio.actionPlay': 'Воспроизвести',
  'radio.actionPause': 'Приостановить',
  'radio.actionResume': 'Продолжить',
  'radio.targetSelected': 'выбранную',
  'radio.targetNearest': 'ближайшую',
  'radio.playStateAria': '{action} {target} радиостанцию',
  'radio.miniStateUncertain': 'СОСТОЯНИЕ РАДИО НЕОПРЕДЕЛЁННО',
  'radio.miniSyncingDirectory': 'СИНХРОНИЗАЦИЯ КАТАЛОГА',
  'radio.stationSyncing': 'СИНХРОНИЗАЦИЯ',
  'radio.stationFallback': 'станция',
  'radio.playbackReadyFallback': 'Готова',

  // CCTV panel runtime states (layers.cctv.* seeded keys reused where they
  // match; these are the runtime-only compositions and flipped states).
  'cctv.coverageViewshedOn': 'ЗОНА ОБЗОРА ВКЛ',
  'cctv.frameLoading': 'КАДР · ЗАГРУЗКА',
  'cctv.frameUnavailable': 'КАДР · НЕДОСТУПЕН',
  'cctv.calChipEdited': 'CAL · ИЗМЕНЕНО (НЕ СОХРАНЕНО)',
  'cctv.calChipTemplate': 'CAL · {badge}',
  'cctv.calBadgeCalibrated': 'ОТКАЛИБРОВАНО',
  'cctv.calBadgeCurated': 'ВЫВЕРЕНО',
  'cctv.calBadgeRawPrior': 'ИСХОДНАЯ ОЦЕНКА',
  'cctv.metaProjectionMonitor': 'МОНИТОР',
  'cctv.metaProjectionOff': 'ВЫКЛ',
  'cctv.metaTemplate': '{city} · HDG {heading} · FOV {fov} · RANGE {range}m · {projection}{calBadge} · {provider}{status}',
  'cctv.metaCamerasClick': {
    one: 'Загружена {count} камера · нажмите камеру для активации',
    few: 'Загружено {count} камеры · нажмите камеру для активации',
    many: 'Загружено {count} камер · нажмите камеру для активации',
    other: 'Загружено {count} камеры · нажмите камеру для активации',
  },
  'cctv.metaCamerasEnable': {
    one: 'Загружена {count} камера · включите CCTV для активации',
    few: 'Загружено {count} камеры · включите CCTV для активации',
    many: 'Загружено {count} камер · включите CCTV для активации',
    other: 'Загружено {count} камеры · включите CCTV для активации',
  },
  'cctv.summaryNoneAvailable': 'Сводка недоступна.',

  // ── Phase-3 runtime extraction batch 5: remainder + hud.js ────────────────

  // _setCelestialRingEnabled(): unsupported-style title sibling of the seeded
  // display.celestialToggleTitle.
  'display.celestialUnavailableTitle': 'Небесное кольцо — доступно в стиле «Обычный»',
  // _updateDetectionButton(): density-profile labels (display.detectionLabel
  // 'DETECT' was seeded on the static button) + composed aria.
  'display.detectionAriaTemplate': 'Слой детекции: {mode}',
  'display.detectionAriaOff': 'Слой детекции: выкл',
  'display.detectionLabelSparse': 'РЕДКО',
  'display.detectionLabelBalanced': 'УМЕРЕННО',
  'display.detectionLabelDense': 'ПЛОТНО',
  // Globe-reset buttons: idle/working aria states (cockpit variant sibling).
  'hud.resetGlobeAria': 'Сбросить к виду всего глобуса',
  'hud.resetGlobeCockpitAria': 'Сбросить кабину к виду всего глобуса',
  'hud.resettingGlobeAria': 'Сброс к виду всего глобуса',
  'hud.resettingGlobeCockpitAria': 'Сброс кабины к виду всего глобуса',
  // _initOrbit(): indicator caption after the orbit glyph.
  'location.orbitLabel': 'ОРБИТА',
  // Intel HUD (src/hud.js): summary caption, idle placeholder, REC indicator.
  // Classification banners, terse instrument readout codes (MGRS/GSD/NIIRS/
  // ALT/COLL/ONA/BAND/BITS/LVL), and the AI summary line stay keep-English.
  'hud.summaryLabel': 'СВОДКА',
  'hud.summaryAwaiting': 'Ожидание телеметрии...',
  'hud.recLabel': 'REC',

  // Upstream a11y additions (post-merge follow-up): slider/toggle accessible names.
  'display.featherAria': 'Растушёвка края обзора',
  'display.bloomAria': 'Интенсивность bloom',
  'display.sharpenAria': 'Интенсивность резкости',
  'location.searchAria': 'Поиск места по названию или координатам',
  'location.toggleAria': 'Развернуть панель места',
};
