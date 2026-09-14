// Українська (uk) — нейтральний міжнародний каталог. Глосарій: docs/TRANSLATORS.md.
export const NAMESPACE = 'setup';

export default {
  // index.html #first-run-launcher header/title/choices
  'firstRun.kicker': 'ЦЕНТР КЕРУВАННЯ · ПЕРШИЙ ЗАПУСК',
  'firstRun.title': 'Оберіть свій перший вигляд',
  'firstRun.choice.contacts': 'КОНТАКТИ В РЕАЛЬНОМУ ЧАСІ',
  'firstRun.suppress': 'Більше не показувати',
  // index.html #key-setup-chip / #key-setup dialog
  'keySetup.chip': 'ЗАПУСК',
  'keySetup.kicker': 'НАЗЕМНА СТАНЦІЯ · НАЛАШТУВАННЯ ПОСТАЧАЛЬНИКІВ',
  'keySetup.title': 'Запустіть глобус',
  'keySetup.apply': 'ЗБЕРЕГТИ КЛЮЧІ',
  // src/keySetup.js submitUpdates() status announcement
  'keySetup.status.saving': 'Збереження…',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (docs/TRANSLATORS.md cross-surface rule); these keys cover the
  // support-worker surfaces (first-run, key setup, scene director) whose
  // runtime paths land here in phase 3.

  // index.html #first-run-launcher
  // Owner-authored persuasive line, pinned verbatim by firstRunExperience.test.mjs
  // (unspaced em dash included) — keep the exact string when translating.
  'firstRun.description': 'Немов заборонена кабіна — а потім ви усвідомлюєте: джерела публічні, а дані — справжні.',
  'firstRun.choice.contactsSub': 'Літаки, судна та розвідка поблизу',
  'firstRun.choice.spaceMissions': 'КОСМІЧНІ МІСІЇ',
  'firstRun.choice.spaceMissionsSub': 'Запуски, космічні апарати та орбітальний контекст',
  'firstRun.choice.explore': 'ДОСЛІДИТИ ВРУЧНУ',
  'firstRun.choice.exploreSub': 'Почніть із чистого глобуса',
  'firstRun.dismissHint': 'ESC — приховати',
  // Initial status tip; firstRunExperience.js swaps it for progress/errors.
  'firstRun.note': 'Порада: кнопка GEV MIC у доку дає змогу говорити з картою.',
  // NOT seeded: the environmental tile's <strong>/<small> are pinned verbatim
  // by firstRunExperience.test.mjs (and the title is painted from
  // ENVIRONMENTAL_LABEL_CHOICE at init) — the support worker wires them in
  // phase 3 together with the test update.

  // index.html #key-setup
  'keySetup.closeAriaLabel': 'Закрити налаштування ключів',
  'keySetup.description': 'Глобус уже літає без ключів. Кожен ключ нижче вмикає ще один справжній канал даних — вставте його, і він збережеться в локальну конфігурацію застосунку, після чого сервер перезапуститься самостійно. Серверні ключі залишаються на цій машині; Google Maps і Cesium ion працюють у браузері, тож їхні ключі треба обмежити на боці постачальника. Ключі, налаштовані деінде, показуються, але ніколи не змінюються.',
  'keySetup.hint': 'ESC — закрити',
  'keySetup.note': 'Ключ Google Maps відкриває фотореалістичну планету — усе інше нашаровується зверху.',

  // index.html scene director panel chrome (src/scenes/director.js surface)
  'scenes.panelTitle': 'СЦЕНИ',
  'scenes.collapseTitle': 'Згорнути панель',
  'scenes.recipeAriaLabel': 'Рецепт сцени',
  'scenes.new': 'НОВА',
  'scenes.delete': 'ВИДАЛ.',
  'scenes.capture': 'ЗНЯТИ КАДР',
  'scenes.updateShot': 'ОНОВИТИ КАДР',
  'scenes.start': 'СТАРТ',
  'scenes.stop': 'СТОП',
  'scenes.next': 'ДАЛІ',
  'scenes.exportPresets': 'ЕКСПОРТУВАТИ ПРЕСЕТИ',
  'scenes.import': 'ІМПОРТУВАТИ',
  'scenes.runLog': 'ЖУРНАЛ ЗАПУСКІВ',
  'scenes.statusReady': 'Готово',

  // ── Phase-3 runtime extraction (support surfaces), appended ───────────────

  // src/firstRunExperience.js — mission busy lines and status/error copy.
  // {detail} is the failed layer-id list (machine values, kept raw).
  'firstRun.busy.contacts': 'Запуск контактів у реальному часі…',
  'firstRun.busy.spaceMissions': 'Відкриття космічних місій…',
  'firstRun.busy.environmental': 'Сканування активних подій…',
  'firstRun.busy.working': 'Працюємо…',
  'firstRun.status.failed': 'Не вдалося відкрити цю місію{detail}. Повторіть спробу або дослідіть вручну.',
  'firstRun.status.storageBlocked': 'Цей браузер блокує сховище, тож зберегти не вдалося.',
  // The environmental tile is painted at init from ENVIRONMENTAL_LABEL_CHOICE;
  // the subcopy names BOTH feeds (pinned verbatim by firstRunExperience.test.mjs).
  'firstRun.choice.environmentalSub': 'Землетруси в реальному часі й активні пожежі від USGS та NASA',
  'firstRun.environmentalTitle.environmental': 'ДОВКІЛЛЯ',
  'firstRun.environmentalTitle.earthWatch': 'НАГЛЯД ЗА ЗЕМЛЕЮ',
  'firstRun.environmentalTitle.activeEvents': 'АКТИВНІ ПОДІЇ',

  // src/keySetup.js — chip counter, status line, and remove confirm.
  'keySetup.chipWaiting': { one: 'ЗАПУСК · {count} ключ у черзі', few: 'ЗАПУСК · {count} ключі в черзі', many: 'ЗАПУСК · {count} ключів у черзі', other: 'ЗАПУСК · {count} ключа в черзі' },
  'keySetup.chipReady': 'ЗАПУЩЕНО',
  'keySetup.status.saveFailed': 'Не вдалося зберегти ({status}).',
  'keySetup.status.saveFailedDetail': 'Не вдалося зберегти: {detail}',
  'keySetup.status.pasteFirst': 'Спочатку вставте принаймні один ключ.',
  'keySetup.status.saved': 'Збережено до {store}. Перезапуск — сторінка перезавантажиться сама.',
  'keySetup.status.removed': 'Видалено з {store}. Перезапуск — сторінка перезавантажиться сама.',
  'keySetup.store.pinokio': 'вашої конфігурації застосунку',
  'keySetup.store.env': 'вашого локального .env',
  'keySetup.confirm.remove': 'Видалити цей ключ із вашої збереженої конфігурації?',

  // src/mapStackChips.js — unavailable-chip tooltip and aria templates.
  'mapStack.fallbackName': 'Цей стек карт',
  'mapStack.unavailableReason': '{label} — недоступно',
  'mapStack.unavailableAriaLabel': '{label} — недоступно: {hint}',

  // src/scenes/director.js — built-in recipe DISPLAY names only. Recipe ids
  // and the URL 'scene' param stay English; stored/renamed project titles are
  // user data and render verbatim.
  'scenes.recipe.flightsRadar': 'Глобальний радар польотів',
  'scenes.recipe.orbitalWatch': 'Орбітальний нагляд',
  'scenes.recipe.thermalThreats': 'Панель теплових загроз',
  'scenes.recipe.cityOverload': 'Міське перевантаження',
  'scenes.recipe.omnisciencePullback': 'Всевидячий від\'їзд',

  // src/voice/gevRealtime.js — mic chrome and connection/execution STATUS
  // text. Status enum keys (idle/connecting/…) are machine values; tool
  // names/schemas and model-facing results stay English (keep-English
  // boundary). Tier badges STD/MINI and the MIC/ON-OFF mic label stay machine
  // identifiers this phase.
  'voice.status.idle': 'ВИМКНЕНО',
  'voice.status.connecting': 'З\'ЄДНАННЯ',
  'voice.status.listening': 'СЛУХАЮ',
  'voice.status.executing': 'ВИКОНАННЯ',
  'voice.status.error': 'ПОМИЛКА',
  'voice.status.sessionCostCap': 'Сесію завершено — ліміт витрат {cost}',
  'voice.detail.standby': 'ГОЛОСОВЕ ОЧІКУВАННЯ',
  'voice.detail.active': 'ГОЛОС АКТИВНИЙ',
  'voice.detail.unavailable': 'ГОЛОС НЕДОСТУПНИЙ',
  'voice.detail.microphoneUnavailable': 'Підтримка мікрофона WebRTC недоступна',
  'voice.detail.requestingMicrophone': 'Запит доступу до мікрофона',
  'voice.detail.holdSpaceTalk': 'Утримуйте Space, щоб говорити',
  'voice.detail.releaseSpaceSend': 'Відпустіть Space, щоб надіслати',
  'voice.detail.askOrCommand': 'Питання або команда',
  'voice.detail.voiceOff': 'Голос вимкнено',
  'voice.detail.runningCommand': 'Виконання команди',
  'voice.detail.radioDidNotStart': 'Радіо не запустилося',
  'voice.hint.default': 'Утримуйте Space, щоб говорити · тапніть Space, щоб активувати елемент у фокусі',
  'voice.error.sessionStart': 'Не вдалося запустити голосову сесію.',
  'voice.error.trayTitle': 'ПОМИЛКА ГОЛОСОВОЇ СИСТЕМИ',
  'voice.error.dismiss': 'ЗАКРИТИ',
  'voice.error.hint': 'Перевірте дозвіл на мікрофон і доступ до мережі, потім спробуйте ще раз.',
  'voice.kicker.agent': 'АГЕНТ ШІ',
  'voice.kicker.control': 'ГОЛОСОВЕ КЕРУВАННЯ',
  'voice.tier.appliesNextSession': '{tier} набуде чинності з наступної сесії',
  'voice.tier.buttonTitle': 'Рівень голосової моделі — набуде чинності з наступної сесії',
  'voice.cost.buttonTitle': 'Орієнтовна вартість сесії',
  'voice.button.ariaLabel': 'Голосове керування — активуйте, щоб увімкнути або вимкнути голос; утримуйте Space, щоб говорити',

  // ── Stage-4 repair pass: src/scenes/director.js status corpus, appended ───
  // Status/confirm lines and the default shot title. {scene}/{shot} carry
  // stored project titles (user data, rendered verbatim); {mode} is the raw
  // context-mode identifier (machine value, keep-English boundary).
  'scenes.status.captureCameraNotReady': 'Не вдалося зняти кадр: камера не готова',
  'scenes.status.shotTitleDefault': 'Кадр {n}',
  'scenes.status.captured': 'Знято: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'Спочатку оберіть кадр',
  'scenes.status.updated': 'Оновлено: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'Видалити кадр «{shot}»?',
  'scenes.status.loaded': 'Завантажено: {scene} / {shot}',
  'scenes.status.cameraUnavailable': 'Камера недоступна — спершу вийдіть із кабіни',
  'scenes.status.noShotsToRun': 'Немає кадрів для запуску',
  'scenes.status.runningShot': 'Виконання {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'Запуск сцени завершено',
  'scenes.status.runError': 'Помилка: {message}',
  'scenes.status.contextExitFailed': 'Не вдалося вийти з {mode} — шари сцени може бути відхилено',

  // ── Stage-4 repair pass: keySetup dev-surface copy, appended ──────────────
  // src/keySetup.js buildRow() remove chrome (dev-server-only surface).
  'keySetup.row.remove': 'ВИДАЛИТИ',
  'keySetup.row.removeTitle': 'Видалити {title} із збережених ключів застосунку',
  // src/keySetupCore.mjs keySetupRequirement(): availability sentence naming
  // the registry env vars (machine values stay raw).
  'keySetup.requirement': 'Потрібно {envVars} — додайте у налаштуваннях постачальників',
  // src/keySetupCore.mjs KEY_SETUP_KEYS `unlocks` copy, keyed by registry id;
  // en values must stay byte-identical to the registry strings.
  'keySetup.unlocks.google-maps': 'Фотореалістична 3D-планета + пошук місць',
  'keySetup.unlocks.google-maps-server': 'Контекст Places + резервний Street View; окремий ключ за бажанням',
  'keySetup.unlocks.openai': 'Голосове керування — говоріть із планетою',
  'keySetup.unlocks.aisstream': 'Судна в реальному часі по всьому світу',
  'keySetup.unlocks.firms': 'Виявлення активних пожеж у реальному часі',
  'keySetup.unlocks.tomtom': 'Справжній трафік у реальному часі (без ключа — симуляція)',
  'keySetup.unlocks.cesium-ion': 'Стеки карт Bing imagery + світовий рельєф',
  'keySetup.unlocks.opensky': 'Більше кредитів опитування польотів (працює й анонімно)',
  'keySetup.unlocks.launch-library': 'Більший ліміт запитів для космічних місій',

  'scenes.status.actionFailed': 'Не вдалося виконати дію сцени',

  'scenes.status.projectExported': 'Проєкт експортовано',

  'voice.tierNextSession': 'Наступна сесія: {pendingId} — поточна залишається на {modelId}',
  'voice.tierSwitchHint': 'Голосова модель: {pendingId} — натисніть, щоб перейти на {target}; набуде чинності з наступної сесії',
  'voice.costTooltip': 'Орієнтовна вартість сесії на {modelId} — відповідей: {responses}. Попереджає при {warn}, завершує сесію при {cap}.',
};
