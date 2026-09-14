// Українська (uk). Глосарій: docs/TRANSLATORS.md.
export const NAMESPACE = 'cockpit';

export default {
  // index.html #cockpit-hud section aria-label
  'hud.sectionLabel': 'Вигляд кабіни повітряного судна',
  // index.html #map-view-switch button label
  'exit.label': 'ВИЙТИ З КАБІНИ',
  // index.html .cockpit-readout-label
  'readout.groundSpeed': 'ШВИДКІСТЬ',
  'readout.altitude': 'ВИСОТА',
  // index.html .cockpit-context-kicker / #cockpit-context-subject (initial)
  'context.kicker': 'КОНТАКТ',
  'context.subjectWindow': 'КОНТАКТИ · 250 KM',
  // index.html #cockpit-brief-kicker / #cockpit-brief-subtitle (initial)
  'brief.kicker': 'СИГНАЛИ У РЕАЛЬНОМУ ЧАСІ',
  'brief.subtitle': 'СПОСТЕРЕЖЕНІ / КАРТОГРАФОВАНІ ПІНГИ',
  // index.html #cockpit-vision-current small label
  'vision.current': 'ПОТОЧНИЙ',
  // index.html #cockpit-radio-station (initial)
  'radio.station.ready': 'ГОТОВА',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (docs/TRANSLATORS.md cross-surface rule); these keys land here because
  // src/ui.js and src/hud.js own the surfaces' runtime half in phase 3.

  // index.html #style-indicator / #clean-view-exit (visual-style chrome)
  'presets.activeStyleLabel': 'АКТИВНИЙ СТИЛЬ',
  'display.cleanViewExitTitle': 'Повернути елементи керування',
  'display.cleanViewExitLabel': 'ВИЙТИ З ЧИСТОГО ВИГЛЯДУ',

  // index.html control panel — Visual Presets dock tray
  'presets.toggleAriaLabel': 'Розгорнути візуальні пресети',
  // Key-only: the .panel-title node shares its element with the dock-label-icon
  // span, so a data-i18n write would wipe the icon; phase 3 wires this via t().
  'presets.title': 'ВІЗУАЛЬНІ ПРЕСЕТИ',
  'presets.pinAriaLabel': 'Закріпити візуальні пресети',
  'presets.pinTitle': 'Тримати візуальні пресети відкритими',
  'presets.styleNormalTitle': 'Показує глобус без візуального фільтра.',
  'presets.styleNormalLabel': 'Звичайний',
  'presets.styleCrtTitle': 'Імітує CRT-монітор із зеленим фосфором, рядками розгортки та вигнутим екраном.',
  'presets.styleCrtLabel': 'CRT',
  'presets.styleNvgTitle': 'Імітує прилад нічного бачення з зеленим підсиленням та віньєткою туби.',
  'presets.styleNvgLabel': 'NVG',
  'presets.styleFlirTitle': 'Імітує термальний контраст у стилі FLIR. Для кольору збільште Ironbow.',
  'presets.styleFlirLabel': 'FLIR',
  'presets.styleAnimeTitle': 'Застосовує яскраву мультяшну заливку та ілюстровані контури.',
  'presets.styleAnimeLabel': 'Аніме',
  'presets.styleNoirTitle': 'Застосовує висококонтрастну чорно-білу обробку в стилі нуар.',
  'presets.styleNoirLabel': 'Нуар',
  'presets.styleSnowTitle': 'Додає до сцени холодний засніжений білий ефект.',
  'presets.styleSnowLabel': 'Сніг',
  // Key-only: the static span text is pinned verbatim by mapStackChips.test.mjs
  // (id="map-source-label">MAP SOURCE<), so no attribute can be added without
  // touching that test; phase 3 owns the swap.
  'presets.mapSourceLabel': 'ДЖЕРЕЛО КАРТИ',
  // Key-only: the chip-row tag is pinned literally by mapStackChips.test.mjs.
  'presets.mapSourceChipsAriaLabel': 'Джерело карти',
  'presets.miniStyleLabel': 'Стиль',

  // index.html #pp-toggles DISPLAY rail
  // Key-only: .pp-header-label text is pinned verbatim by panelStackLayout.test.mjs.
  'display.title': 'ДИСПЛЕЙ',
  'display.collapseTitle': 'Згорнути панель',
  'display.hudToggleTitle': 'Розвідувальний HUD (H)',
  'display.hudLayoutLabel': 'Компонування',
  'display.hudLayoutAriaLabel': 'Компонування HUD',
  'display.hudLayoutTactical': 'Тактичне',
  'display.hudLayoutOperator': 'Операторське',
  'display.hudLayoutMinimal': 'Мінімальне',
  'display.detectionToggleTitle': 'Накладка виявлення (D)',
  'display.detectionAriaLabel': 'Накладка виявлення',
  'display.detectionLabel': 'ВИЯВЛЕННЯ',
  'display.densityLabel': 'Щільність',
  'display.densityAriaLabel': 'Щільність підписів виявлення',
  'display.allocationLabel': 'Розподіл',
  'display.allocationAriaLabel': 'Розподіл підписів виявлення',
  'display.allocationElastic': 'Пружний',
  'display.allocationWeighted': 'Зважений',
  'display.fadeLabel': 'Згасання',
  'display.fadeAriaLabel': 'Відстань згасання виявлення',
  'display.fadeTitle': 'Відстань згасання накладки світу за межами ілюмінатора у відсотках його радіуса',
  'display.outsideLabel': 'Ззовні',
  'display.outsideAriaLabel': 'Непрозорість виявлення за межами ілюмінатора',
  'display.outsideTitle': 'Непрозорість підписів і карток накладки світу за межею згасання',
  'display.parametersTitle': 'ПАРАМЕТРИ',
  'display.parametersCollapseTitle': 'Згорнути панель',
  'display.modelsToggleTitle': '3D літаки — плоскі іконки здалеку, 3D-моделі зблизька',
  'display.modelsLabel': 'Моделі',
  'display.modelsCoverageAriaLabel': 'Зона огляду 3D-моделей',
  'display.modelsModeProximity': 'Поблизу',
  'display.modelsModeAll': 'Усі',
  'display.scopeToggleTitle': 'Приціл — кругла маска вікна перегляду',
  'display.scopeLabel': 'Приціл',
  'display.featherLabel': 'Розмиття',
  'display.featherTitle': 'Розмиття краю приціла у відсотках радіуса ілюмінатора',
  'display.celestialToggleTitle': 'Небесне кільце — показати весь глобус',
  'display.celestialLabel': 'Небесне',
  'display.cleanViewToggleTitle': 'Сховати оформлення інтерфейсу',
  'display.cleanViewLabel': 'Чистий інтерфейс',
  'display.bloomToggleTitle': 'Світіння / Ореол',
  'display.bloomLabel': 'Світіння',
  'display.sharpenToggleTitle': 'Підвищення різкості',
  'display.sharpenLabel': 'Різкість',

  // index.html location bar (dock locations tray; ui.js owns the runtime half)
  // Key-only: .location-toolbar-label shares its element with dock-label-icon.
  'location.toolbarLabel': 'РОЗТАШУВАННЯ',
  'location.collapseTitle': 'Згорнути панель',
  'location.pinAriaLabel': 'Закріпити панель розташування',
  'location.pinTitle': 'Тримати панель розташування відкритою',
  // Initial mini-status values; ui.js rewrites both once a place resolves.
  'location.miniCityInitial': '📍 Розташування: --',
  'location.miniPoiInitial': 'Орієнтир: --',
  'location.searchToggleTitle': 'Шукати будь-яке розташування',
  'location.searchPlaceholder': 'Шукати будь-яке розташування...',

  // index.html cockpit HUD statics
  'hud.level': 'РІВЕНЬ',
  'hud.routeDirectionAriaLabel': 'Орієнтовний напрямок до пункту призначення',
  // Initial idle readout; ui.js rewrites it with a live bearing.
  'hud.routeDirectionIdle': 'DEST ---°',
  'hud.visorPlane': 'ОПТИЧНА ПЛОЩИНА · 01',
  'hud.visorLock': 'ФІКСАЦІЯ ВІЗОРА · АКТИВНА',
  'hud.firstPerson': 'ВІД ПЕРШОЇ ОСОБИ',
  // Initial meta line; ui.js rewrites it from live track state.
  'hud.aircraftMetaInitial': 'ТРЕК У РЕАЛЬНОМУ ЧАСІ · КУРС ВИРІВНЯНО',
  'hud.visionGroupAriaLabel': 'Стиль бачення кабіни',
  'hud.compassAriaLabel': 'Поточний курс повітряного судна',
  'readout.rimGroundSpeed': 'ШВИДКІСТЬ · KTS',
  'readout.rimAltitude': 'ВИСОТА · FT',

  // index.html cockpit vision controls
  'vision.previousLabel': 'ПОПЕР.',
  'vision.previousAriaLabel': 'Попередній стиль бачення кабіни',
  'vision.previousTitle': 'Попередній стиль бачення',
  // The NORMAL token inside these two is the style name; phase 3 splits the
  // dynamic token out when the runtime half is extracted.
  'vision.currentAriaLabel': 'Поточний стиль бачення кабіни: NORMAL. Активуйте для наступного стилю.',
  'vision.currentTitle': 'Поточний стиль: NORMAL — клацніть для наступного',
  'vision.nextLabel': 'НАСТУП.',
  'vision.nextAriaLabel': 'Наступний стиль бачення кабіни',
  'vision.nextTitle': 'Наступний стиль бачення',

  // index.html view switcher
  'exit.navAriaLabel': 'Перемикач вигляду',
  'exit.resetAriaLabel': 'Скинути кабіну до вигляду всього глобуса',
  'exit.resetTitle': 'Вийти з кабіни та повернутися до вигляду всього глобуса',
  'exit.resetLabel': 'СКИНУТИ',
  'exit.ariaLabel': 'Вийти з вигляду кабіни',
  'exit.title': 'Вийти з вигляду кабіни',

  // index.html cockpit route card
  'route.cardAriaLabel': 'Орієнтовний план польоту',
  'route.kicker': 'ОРІЄНТОВНИЙ ПЛАН ПОЛЬОТУ',
  'route.statusUnavailable': 'ДАНІ МАРШРУТУ НЕДОСТУПНІ',
  'route.fromLabel': 'ВІД',
  'route.toLabel': 'ДО',
  'route.unknownEndpoint': 'НЕВІДОМО',

  // index.html cockpit briefing carousel
  // (brief.kicker 'LIVE SIGNALS' is seeded above but is KEY-ONLY: #cockpit-brief-kicker
  // shares its element with the live-dot <i>, so no data-i18n attribute can target it.)
  'brief.carouselAriaLabel': 'Карусель брифінгу кабіни',
  'brief.actionsAriaLabel': 'Керування брифінгом кабіни',
  'brief.previousAriaLabel': 'Попередня сторінка брифінгу',
  'brief.previousTitle': 'Попередня сторінка брифінгу',
  'brief.nextAriaLabel': 'Наступна сторінка брифінгу',
  'brief.nextTitle': 'Наступна сторінка брифінгу',
  // Title is static prose; the visible label + aria-label are CYCLE ON/OFF
  // states that belong to the phase-3 runtime extraction.
  'brief.autoTitle': 'Гортає сторінки брифінгу автоматично кожні 9 секунд (Сигнали → Новини → Локально). Пауза, доки ви наводите вказівник або фокусуєте панель. Дані сигналів у реальному часі оновлюються безперервно незалежно від цього.',
  'brief.collapseAriaLabel': 'Згорнути панель брифінгу кабіни',
  'brief.collapseTitle': 'Згорнути панель брифінгу',
  'brief.signalsAriaLabel': 'Сигнали в реальному часі',
  'brief.newsAriaLabel': 'Останні регіональні новини',
  'brief.localAriaLabel': 'Інформація за розташуванням',
  'brief.newsAcquiring': 'ОТРИМАННЯ РЕГІОНАЛЬНИХ НОВИН',
  'brief.localResolving': 'ВИЗНАЧЕННЯ РЕГІОНУ',
  'brief.labelTemp': 'ТЕМП',
  'brief.labelWind': 'ВІТЕР',
  'brief.labelSky': 'НЕБО',
  'brief.labelPrecip': 'ОПАДИ',
  'brief.sourceNote': 'ПОДІЇ ПІДТВЕРДЖЕНІ ДЖЕРЕЛАМИ · БЕЗ ШТУЧНИХ НОВИН',
  'brief.tabSignalsAriaLabel': 'Показати сигнали в реальному часі',
  'brief.tabNewsAriaLabel': 'Показати регіональні новини',
  'brief.tabLocalAriaLabel': 'Показати локальну інформацію',

  // index.html cockpit context panel (right-rail Global Context included)
  'context.panelAriaLabel': 'Зведення контакта в кабіні',
  'context.navAriaLabel': 'Навігація контактами',
  'context.previousAriaLabel': 'Назад — попередній відвіданий контакт у вікні 250 км',
  'context.previousTitle': 'Назад — попередній відвіданий контакт у вікні 250 км',
  'context.nextAriaLabel': 'Далі — найближчий невідвіданий контакт у вікні 250 км',
  'context.nextTitle': 'Далі — найближчий невідвіданий контакт у вікні 250 км',
  'context.toggleAriaLabel': 'Згорнути панель контактів',
  'context.toggleTitle': 'Згорнути панель контактів',
  'context.qualifier': 'ЛИШЕ КОНТЕКСТ',
  'context.cohortsAriaLabel': 'Кількість найближчих груп',
  'context.nearestLabel': 'НАЙБЛИЖЧІ СПОСТЕРЕЖЕНІ / КАРТОГРАФОВАНІ',
  'context.nearestEmpty': 'НЕМАЄ ДОСТУПНОГО ПРИКЛАДУ',
  'context.uncertaintyNote': 'ЛИШЕ ДОСТУПНІ ВХІДНІ ДАНІ · НЕ ОЗНАЧАЄ «УСЕ ЧИСТО»',
  'context.weatherEnableAriaLabel': 'Увімкнути погодні ефекти кабіни',
  'context.weatherEnableTitle': 'Увімкнути погодні ефекти кабіни',
  'context.panelTitle': 'КОНТЕКСТ',
  'context.collapseTitle': 'Розгорнути панель',
  'context.modesAriaLabel': 'Режим контексту',
  'context.contactsTabAriaLabel': 'КОНТАКТИ',
  'context.contactsTabTitle': 'Гортає найближчі контакти обраного вами типу — літаки, судна, об’єкти. Супутники відстежуються окремо.',
  'context.contactsTabLabel': 'КОНТАКТИ',
  'context.missionsTabLabel': 'КОСМІЧНІ МІСІЇ',
  'context.standbyTitle': 'ОБЕРІТЬ КОНТЕКСТ',
  'context.actionsAriaLabel': 'Дії контексту контактів',
  'context.cockpitEntryLabel': 'КАБІНА',
  'context.searchNearbyLabel': 'ПОШУК НАЙБЛИЖЧИХ ОБ’ЄКТІВ',
  'context.tr3bAriaLabel': 'Перекласифікувати відстежуваний контакт як TR-3B',
  'context.tr3bTitle': 'Перекласифікувати як TR-3B',
  'context.awarenessOffTitle': 'КОНТЕКСТ КОНТАКТІВ ВИМКНЕНО',
  'context.awarenessOffHint': 'ОБЕРІТЬ КОНТАКТИ, ЩОБ ЗАВАНТАЖИТИ СПОСТЕРЕЖЕНУ / КАРТОГРАФОВАНУ БЛИЗЬКІСТЬ',
  'context.rosterAriaLabel': 'Доступні космічні місії',
  'context.rosterTitle': 'ДОСТУПНІ МІСІЇ',
  'context.rosterHint': 'ОБЕРІТЬ МІСІЮ ДЛЯ ПЕРЕГЛЯДУ',
  'context.rosterLoading': 'ЗАВАНТАЖЕННЯ ІНДЕКСУ МІСІЙ ЗА 30 ДНІВ',
  'context.radioToggleAriaLabel': 'Відкрити компактне керування радіо',
  'context.radioToggleTitle': 'Відкрити компактне керування радіо',
  'context.radioMiniGroupAriaLabel': 'Компактне керування радіо',
  'context.radioMiniTitle': 'РАДІО',
  'context.radioMiniReady': 'РАДІО ГОТОВЕ',
  'context.radioDetailsAriaLabel': 'Відкрити докладне керування радіо',
  'context.radioDetailsTitle': 'Відкрити докладне керування радіо',
  'context.radioCloseAriaLabel': 'Закрити компактне керування радіо',
  'context.radioCloseTitle': 'Закрити компактне керування радіо',
  'context.radioMiniEnable': 'УВІМКНУТИ',
  'context.radioMiniPrevAriaLabel': 'Попередня відфільтрована радіостанція',
  'context.radioMiniPrevTitle': 'Попередня станція',
  'context.radioMiniPlayAriaLabel': 'Відтворити обрану радіостанцію',
  'context.radioMiniPlayTitle': 'Відтворити',
  'context.radioMiniNextAriaLabel': 'Наступна відфільтрована радіостанція',
  'context.radioMiniNextTitle': 'Наступна станція',
  'context.radioMiniVolumeLabel': 'ГУЧНІСТЬ',
  'context.radioMiniVolumeAriaLabel': 'Гучність компактного радіо',

  // index.html cockpit utility controls + compact radio popover
  'utility.controlsAriaLabel': 'Керування дисплеєм і радіо кабіни',
  'utility.displayLabel': 'ДИСПЛЕЙ',
  'utility.radioLabel': 'РАДІО',
  'utility.displayToggleAriaLabel': 'Розгорнути параметри дисплея кабіни',
  'utility.displayToggleTitle': 'Розгорнути параметри дисплея кабіни',
  'utility.displayPanelAriaLabel': 'Параметри дисплея кабіни',
  'utility.radioToggleAriaLabel': 'Розгорнути керування радіо кабіни',
  'utility.radioToggleTitle': 'Розгорнути керування радіо кабіни',
  'utility.radioPanelAriaLabel': 'Компактне керування радіо кабіни',
  'radio.enable': 'УВІМКНУТИ',
  'radio.prevAriaLabel': 'Попередня відфільтрована радіостанція',
  'radio.playAriaLabel': 'Відтворити обрану радіостанцію',
  'radio.nextAriaLabel': 'Наступна відфільтрована радіостанція',
  'radio.volumeLabel': 'ГУЧНІСТЬ',
  'radio.volumeAriaLabel': 'Гучність радіо кабіни',

  // ── Phase-3 runtime extraction (src/ui.js), appended ─────────────────────
  // Values stay byte-identical to the previous English literals; existing
  // tests pin many of them under the default locale.

  // _syncPanelCollapseButton(): composed panel collapse titles. {name} is the
  // panel's own (already localized) .panel-title text.
  'panel.expandTitle': 'Розгорнути {name}',
  'panel.collapseTitle': 'Згорнути {name}',
  // Fallback when a panel ships no .panel-title/.pp-header-label node.
  'panel.fallbackName': 'панель',
  // Radio panel collapse state; the expand state reuses the layers.radio.*
  // keys seeded on the static button in phase 2.
  'panel.radioCollapseTitle': 'Згорнути радіо',
  'panel.radioCollapseAria': 'Згорнути розділ радіо',
  // _updateLocationMiniStatus(): runtime rewrite of the collapsed LOCATION
  // readout's single-segment search fallback (initial-state keys
  // location.miniCityInitial/miniPoiInitial were seeded in phase 2).
  'location.miniSearchedPlaceholder': 'Знайдене розташування',

  // ── Phase-3 runtime extraction batch 2: cockpit + Context renderers ───────

  // syncWeatherToggle(): state-sibling keys for the runtime ON/OFF rewrite
  // (context.weatherEnableAriaLabel was seeded on the static button).
  'context.weatherDisableAriaLabel': 'Вимкнути погодні ефекти кабіни',
  'context.weatherStateOn': 'УВІМК',
  'context.weatherStateOff': 'ВИМК',
  // syncTr3bToggle(): converted-state title sibling of context.tr3bTitle.
  'context.tr3bRestoreTitle': 'Повернути справжній літак',
  // setVisionMode(): the style token is dynamic, so the sentence is split out
  // of the seeded vision.currentAriaLabel/currentTitle (whose values pin the
  // NORMAL default) into {style} templates.
  'vision.styleNameNightVision': 'Нічне бачення',
  'vision.styleNameThermal': 'Тепловізор',
  'vision.styleNameNoir': 'Нуар',
  'vision.currentAriaTemplate': 'Поточний стиль бачення кабіни: {style}. Активуйте для наступного стилю.',
  'vision.currentTitleTemplate': 'Поточний стиль: {style} — клацніть для наступного',

  // Cockpit signal stream (pushCockpitSignal / renderCockpitSignals).
  'signal.trackAcquired': 'ТРЕК ЗАХОПЛЕНО',
  'signal.trackDetail': '{label} · КУРС {heading}°',
  'signal.selectFlightAria': 'Обрати рейс {title}',
  'signal.contextStandby': 'КОНТЕКСТ: ОЧІКУВАННЯ',
  'signal.contextStandbyHint': 'УВІМКНІТЬ ГЛОБАЛЬНИЙ КОНТЕКСТ ДЛЯ ПІНГІВ БЛИЗЬКОСТІ',
  'signal.contactLostTitle': 'КОНТАКТ ВТРАЧЕНО · {subject}',
  'signal.contactLostDetail': 'ОБ’ЄКТ ПОКИНУВ КАНАЛ ДАНИХ · ІНДИКАТОРИ ТРИМАЮТЬ ОСТАННЄ ВІДОМЕ',
  'signal.classMilitary': 'ВІЙСЬКОВИЙ РЕЙС',
  'signal.classCommercial': 'КОМЕРЦІЙНИЙ РЕЙС',
  'signal.contactCurrent': '{aircraftClass} · ПОТОЧНИЙ',
  'signal.contactRange': '{aircraftClass} · {distance}',
  'signal.distanceUnknown': 'ВІДСТАНЬ НЕВІДОМА',
  'signal.inputsUnknown': {
    one: '{count} НЕВІДОМИЙ ПАРАМЕТР',
    few: '{count} НЕВІДОМІ ПАРАМЕТРИ',
    many: '{count} НЕВІДОМИХ ПАРАМЕТРІВ',
    other: '{count} НЕВІДОМОГО ПАРАМЕТРА',
  },
  'signal.sourceStatusUnavailable': 'СТАТУС ДЖЕРЕЛА НЕДОСТУПНИЙ',

  // updateHud(): callsign fallback + the composed aircraft meta line (each
  // feed state is its own key so no state can leak English later).
  'hud.fallbackCallsign': 'БОРТ',
  'hud.metaClassMilitary': 'ВІЙСЬКОВИЙ',
  'hud.metaClassCommercial': 'КОМЕРЦІЙНИЙ',
  'hud.metaFeedAcquiringSurface': 'ОТРИМАННЯ НАЗЕМНИХ ДАНИХ',
  'hud.metaFeedSurfaceFallback': 'РЕЗЕРВ НАЗЕМНИХ ДАНИХ',
  'hud.metaFeedStale': 'ЗАСТАРІЛИЙ КАНАЛ ДАНИХ',
  'hud.metaFeedLive': 'ТРЕК У РЕАЛЬНОМУ ЧАСІ',
  'hud.aircraftMetaTemplate': '{aircraftClass} · {feedState} · КУРС ВИРІВНЯНО',

  // updateRoute(): runtime state siblings of the seeded route keys.
  'route.statusArrowEstimated': 'СТРІЛКА · ОРІЄНТОВНИЙ НАПРЯМОК',
  'route.directionLabel': 'DEST {bearing}',

  // updateContext(): uncertainty/nearest/bearing readout states.
  'context.uncertaintyContactLost': 'КОНТАКТ ВТРАЧЕНО · ОСТАННІ ВІДОМІ ПОКАЗНИКИ · НЕ ОЗНАЧАЄ «УСЕ ЧИСТО»',
  'context.uncertaintyInputsUnknown': {
    one: '{count} НЕВІДОМИЙ ПАРАМЕТР · НЕ ОЗНАЧАЄ «УСЕ ЧИСТО»',
    few: '{count} НЕВІДОМІ ПАРАМЕТРИ · НЕ ОЗНАЧАЄ «УСЕ ЧИСТО»',
    many: '{count} НЕВІДОМИХ ПАРАМЕТРІВ · НЕ ОЗНАЧАЄ «УСЕ ЧИСТО»',
    other: '{count} НЕВІДОМОГО ПАРАМЕТРА · НЕ ОЗНАЧАЄ «УСЕ ЧИСТО»',
  },
  'context.uncertaintyInputsCurrent': 'ДОСТУПНІ ВХІДНІ ДАНІ АКТУАЛЬНІ · НЕ ОЗНАЧАЄ «УСЕ ЧИСТО»',
  'context.nearestTemplate': '{cohort} · {contact}',
  'context.nearestUnavailableAria': '{cohort}, недоступно',
  'context.bearingNone': 'BRG —',
  'context.bearingAhead': 'ПОПЕРЕДУ',
  'context.bearingSide': '{side} {angle}',
  'context.sideLeft': 'L',
  'context.sideRight': 'R',

  // setContextCollapsed()/setSignalCollapsed(): expand-state siblings.
  'context.toggleExpandAriaLabel': 'Розгорнути панель контактів',
  'context.toggleExpandTitle': 'Розгорнути панель контактів',
  'brief.expandAriaLabel': 'Розгорнути панель брифінгу кабіни',
  'brief.expandTitle': 'Розгорнути панель брифінгу',

  // setBriefAutoRotate(): cycle toggle states + the ON-state help text (the
  // OFF-state help is the seeded brief.autoTitle).
  'brief.autoOn': 'ЦИКЛ УВІМКНЕНО',
  'brief.autoOff': 'ЦИКЛ ВИМКНЕНО',
  'brief.autoTitleOn': 'Зупинити автоматичне гортання сторінок. Попередня, Наступна та вкладки СИГ/НОВ/ЛОК залишаються доступними.',

  // Briefing carousel pages (kicker/subtitle/source per page; the news/local
  // source lines are provider attribution and stay English).
  'brief.kickerNews': 'РЕГІОНАЛЬНІ НОВИНИ',
  'brief.kickerLocal': 'ЛОКАЛЬНА ІНФОРМАЦІЯ',
  'brief.subtitleNews': 'ОСТАННІ ПУБЛІКАЦІЇ ЗА РОЗТАШУВАННЯМ',
  'brief.subtitleLocal': 'МІСЦЕ / УМОВИ / ПОЗИЦІЯ',

  // Local position + regional brief status states.
  'brief.positionUnavailable': 'ПОЗИЦІЯ НЕДОСТУПНА',
  'brief.newsUnavailable': 'РЕГІОНАЛЬНІ НОВИНИ НЕДОСТУПНІ',
  'brief.regionUnavailable': 'РЕГІОН НЕДОСТУПНИЙ',
  'brief.newsEmpty': 'НЕМАЄ СВІЖИХ ЗБІГІВ ЗА РОЗТАШУВАННЯМ',

  // renderRegionalBrief(): article metadata, cloud readout, and age chips.
  'brief.metadataSourceFallback': 'ДЖЕРЕЛО',
  'brief.articleMetaTemplate': '{domain} · {age}',
  'brief.newsSourceLine': '{source} · ЗАПИТ ЗА РОЗТАШУВАННЯМ',
  'brief.age.timeUnknown': 'ЧАС НЕВІДОМИЙ',
  'brief.age.minutes': '{count} ХВ ТОМУ',
  'brief.age.hours': '{count} ГОД ТОМУ',
  'brief.age.days': '{count} ДН ТОМУ',
  'brief.wind.dirUnknown': 'НАПР. НЕВІДОМИЙ',
  'brief.cloudTemplate': 'ХМАРНІСТЬ {pct}%',
  'brief.cloudUnknown': 'ХМАРНІСТЬ НЕВІДОМА',

  // ── Phase-3 runtime extraction batch 3: toasts, loading helpers, map tray ─

  // Panel-chrome + share/location toasts.
  'panel.layoutResetToast': 'Компонування панелей оновлено — позиції скинуто до нових типових',
  'share.toastCopied': 'Посилання скопійовано!',
  'share.toastCopyFailed': 'Не вдалося скопіювати',
  'location.toastNotFound': 'Розташування не знайдено',
  'location.toastSearchFailed': 'Пошук не вдався',
  'location.toastFlyToPoiFirst': 'Спершу полетіть до орієнтира',
  'actions.clearLayersBusyAria': 'Очищення обраних шарів даних',
  'actions.clearLayersFailedToast': 'Не вдалося очистити обрані шари даних',

  // Global status chip notices (_handleShareTrackingRestoreStatus).
  'status.acquiring': 'ОТРИМАННЯ',
  'status.subjectFallback': 'об’єкт',
  'status.sharedSubjectDetail': 'ПОДІЛЕНО: {subject}',
  'status.sharedFollowExpired': '{subject}: ТЕРМІН СТЕЖЕННЯ МИНУВ',
  'status.sharedRestoreFailed': '{subject} НЕ ВДАЛОСЯ ВІДНОВИТИ — КАНАЛ ДАНИХ НЕДОСТУПНИЙ',
  'status.sharedUnavailable': '{subject}: НЕМАЄ ДОСТУПУ',

  // Context mode user-facing action failures.
  'context.modeContext': 'Контекст',
  'context.modeSpaceMissions': 'Космічні місії',
  'context.toastStartBlocked': '{mode} не вдалося запустити, бо інший шар не зупинився коректно',
  'context.toastTransitionFailedContacts': 'Контакти не змогли завершити запитаний перехід; спробуйте ще раз',
  'context.toastTransitionFailedMissions': 'Космічні місії не змогли завершити запитаний перехід; спробуйте ще раз',
  'context.toastInstallationsRefreshFailed': 'Не вдалося оновити найближчі об’єкти; спробуйте ще раз',
  'context.toastRestoreFailed': 'Не вдалося відновити всі шари контексту; спробуйте ще раз',
  'context.toastZoomToSearch': 'Наблизьте масштаб, щоб шукати картографовані об’єкти',
  'context.toastInstallationsRefreshed': 'Найближчі об’єкти оновлено',
  'context.toastLayerUnavailable': 'Цей шар недоступний у поточному режимі контексту',
  'context.actionStart': 'запустити',
  'context.actionStop': 'зупинити',
  'context.toastLayerLifecycleFailed': '{layerId}: не вдалося коректно {action}',
  'radio.toastLifecycleFailed': 'Радіо: не вдалося коректно {action}',

  // CCTV sync chip captions + calibration/availability toasts.
  'cctv.syncLoadingFrames': 'завантаження кадрів',
  'cctv.syncGridReady': 'сітка камер готова',
  'cctv.toastCalibrationSaved': 'Калібрування CCTV збережено',
  'cctv.toastCalibrationReset': 'Калібрування CCTV скинуто',
  'cctv.toastLayerUnavailable': 'Шар CCTV недоступний',

  // _renderMapStackState(): status chip fallback when no stack label resolves
  // (stack names themselves are keep-English provider/stack ids).
  'presets.mapStackFallback': 'КАРТА',

  // ── Phase-3 runtime extraction batch 4: awareness / CCTV / Radio panels ───
  // (radio.* and cctv.* state values that layers.js already seeds are reused
  // cross-namespace; these are the runtime-only siblings and compositions.)

  // _applyRuntimeStaticHeaderText(): the key-only standby description span
  // (both mode descriptions in one span split by a literal <br> in phase 2).
  'context.standbyContactsDesc': 'КОНТАКТИ — найближчі літаки · судна · об’єкти',
  'context.standbyMissionsDesc': 'КОСМІЧНІ МІСІЇ — запуски та орбітальні апарати',
  // _syncContextRadioLauncherState(): close-state sibling of the seeded
  // context.radioToggleAriaLabel ('Open compact Radio controls').
  'context.radioToggleCloseAriaLabel': 'Закрити компактне керування радіо',
  'context.toastMissionsCancelRestoreFailed': 'Скасування Космічних місій не змогло відновити попередній стан шарів',
  // Cockpit utility disclosures: collapse-state siblings of the seeded
  // utility.*ToggleAriaLabel expand keys.
  'utility.displayToggleCollapseAriaLabel': 'Згорнути параметри дисплея кабіни',
  'utility.radioToggleCollapseAriaLabel': 'Згорнути керування радіо кабіни',

  // Radio panel runtime states (state-sibling keys so no state can leak
  // English later; lifecycle enum labels reuse layers.status.*).
  'radio.stateSync': 'СИНХР.',
  'radio.tunerCategoryBand': '{category} ДІАПАЗОН',
  'radio.tunerNoStations': 'НЕМАЄ СТАНЦІЙ',
  'radio.tunerStationAria': '{name}, станція {index} з {total}',
  'radio.tunerNoStationAria': 'Немає доступної станції',
  'radio.tunerOffAir': 'НЕ В ЕФІРІ',
  'radio.tunerStationUnavailable': 'СТАНЦІЯ НЕДОСТУПНА',
  'radio.actionPlay': 'Відтворити',
  'radio.actionPause': 'Пауза',
  'radio.actionResume': 'Продовжити',
  'radio.targetSelected': 'обрану',
  'radio.targetNearest': 'найближчу',
  'radio.playStateAria': '{action} {target} радіостанцію',
  'radio.miniStateUncertain': 'СТАН РАДІО НЕВИЗНАЧЕНИЙ',
  'radio.miniSyncingDirectory': 'СИНХРОНІЗАЦІЯ КАТАЛОГУ',
  'radio.stationSyncing': 'СИНХРОНІЗАЦІЯ',
  'radio.stationFallback': 'станція',
  'radio.playbackReadyFallback': 'Готово',

  // CCTV panel runtime states (layers.cctv.* seeded keys reused where they
  // match; these are the runtime-only compositions and flipped states).
  'cctv.coverageViewshedOn': 'ЗОНА ВИДИМОСТІ УВІМКНЕНА',
  'cctv.frameLoading': 'КАДР · ЗАВАНТАЖЕННЯ',
  'cctv.frameUnavailable': 'КАДР · НЕДОСТУПНИЙ',
  'cctv.calChipEdited': 'CAL · ЗМІНЕНО (НЕ ЗБЕРЕЖЕНО)',
  'cctv.calChipTemplate': 'CAL · {badge}',
  'cctv.calBadgeCalibrated': 'КАЛІБРОВАНО',
  'cctv.calBadgeCurated': 'ПІДІБРАНО',
  'cctv.calBadgeRawPrior': 'СИРЕ АПРІОРНЕ',
  'cctv.metaProjectionMonitor': 'МОНІТОР',
  'cctv.metaProjectionOff': 'ВИМК.',
  'cctv.metaTemplate': '{city} · HDG {heading} · FOV {fov} · RANGE {range}m · {projection}{calBadge} · {provider}{status}',
  'cctv.metaCamerasClick': {
    one: '{count} камеру завантажено · клацніть камеру, щоб активувати',
    few: '{count} камери завантажено · клацніть камеру, щоб активувати',
    many: '{count} камер завантажено · клацніть камеру, щоб активувати',
    other: '{count} камери завантажено · клацніть камеру, щоб активувати',
  },
  'cctv.metaCamerasEnable': {
    one: '{count} камеру завантажено · увімкніть CCTV, щоб активувати',
    few: '{count} камери завантажено · увімкніть CCTV, щоб активувати',
    many: '{count} камер завантажено · увімкніть CCTV, щоб активувати',
    other: '{count} камери завантажено · увімкніть CCTV, щоб активувати',
  },
  'cctv.summaryNoneAvailable': 'Зведення недоступне.',

  // ── Phase-3 runtime extraction batch 5: remainder + hud.js ────────────────

  // _setCelestialRingEnabled(): unsupported-style title sibling of the seeded
  // display.celestialToggleTitle.
  'display.celestialUnavailableTitle': 'Небесне кільце — доступне у стилі «Звичайний»',
  // _updateDetectionButton(): density-profile labels (display.detectionLabel
  // 'DETECT' was seeded on the static button) + composed aria.
  'display.detectionAriaTemplate': 'Накладка виявлення: {mode}',
  'display.detectionAriaOff': 'Накладка виявлення: вимк.',
  'display.detectionLabelSparse': 'РЕДКИЙ',
  'display.detectionLabelBalanced': 'ЗБАЛАНСОВАНИЙ',
  'display.detectionLabelDense': 'ЩІЛЬНИЙ',
  // Globe-reset buttons: idle/working aria states (cockpit variant sibling).
  'hud.resetGlobeAria': 'Скинути до вигляду всього глобуса',
  'hud.resetGlobeCockpitAria': 'Скинути кабіну до вигляду всього глобуса',
  'hud.resettingGlobeAria': 'Скидання до вигляду всього глобуса',
  'hud.resettingGlobeCockpitAria': 'Скидання кабіни до вигляду всього глобуса',
  // _initOrbit(): indicator caption after the orbit glyph.
  'location.orbitLabel': 'ОРБІТА',
  // Intel HUD (src/hud.js): summary caption, idle placeholder, REC indicator.
  // Classification banners, terse instrument readout codes (MGRS/GSD/NIIRS/
  // ALT/COLL/ONA/BAND/BITS/LVL), and the AI summary line stay keep-English.
  'hud.summaryLabel': 'ЗВЕДЕННЯ',
  'hud.summaryAwaiting': 'Очікування телеметрії...',
  'hud.recLabel': 'REC',

  // Upstream a11y additions (post-merge follow-up): slider/toggle accessible names.
  'display.featherAria': 'Розмиття краю приціла',
  'display.bloomAria': 'Інтенсивність світіння',
  'display.sharpenAria': 'Інтенсивність різкості',
  'location.searchAria': 'Шукати розташування за назвою або координатами',
  'location.toggleAria': 'Розгорнути РОЗТАШУВАННЯ',
};
