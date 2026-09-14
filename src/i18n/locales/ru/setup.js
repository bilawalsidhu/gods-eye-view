// Русский каталог (ru). Глоссарий: docs/TRANSLATORS.md.
export const NAMESPACE = 'setup';

export default {
  // index.html #first-run-launcher header/title/choices
  'firstRun.kicker': 'ЦЕНТР УПРАВЛЕНИЯ · ПЕРВЫЙ ЗАПУСК',
  'firstRun.title': 'Выберите первый вид',
  'firstRun.choice.contacts': 'КОНТАКТЫ В РЕАЛЬНОМ ВРЕМЕНИ',
  'firstRun.suppress': 'Больше не показывать',
  // index.html #key-setup-chip / #key-setup dialog
  'keySetup.chip': 'ЗАПУСК',
  'keySetup.kicker': 'НАЗЕМНАЯ СТАНЦИЯ · НАСТРОЙКИ ПРОВАЙДЕРОВ',
  'keySetup.title': 'Запустите глобус',
  'keySetup.apply': 'СОХРАНИТЬ КЛЮЧИ',
  // src/keySetup.js submitUpdates() status announcement
  'keySetup.status.saving': 'Сохранение…',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (docs/TRANSLATORS.md cross-surface rule); these keys cover the
  // support-worker surfaces (first-run, key setup, scene director) whose
  // runtime paths land here in phase 3.

  // index.html #first-run-launcher
  // Owner-authored persuasive line, pinned verbatim by firstRunExperience.test.mjs
  // (unspaced em dash included) — keep the exact string when translating.
  'firstRun.description': 'Ощущение, будто вы в запретной кабине—а потом вы понимаете: источники общедоступны, и данные настоящие.',
  'firstRun.choice.contactsSub': 'Самолёты, суда и разведка поблизости',
  'firstRun.choice.spaceMissions': 'КОСМИЧЕСКИЕ МИССИИ',
  'firstRun.choice.spaceMissionsSub': 'Запуски, аппараты и орбитальный контекст',
  'firstRun.choice.explore': 'ИЗУЧИТЬ ВРУЧНУЮ',
  'firstRun.choice.exploreSub': 'Начните с чистого глобуса',
  'firstRun.dismissHint': 'ESC — скрыть',
  // Initial status tip; firstRunExperience.js swaps it for progress/errors.
  'firstRun.note': 'Совет: кнопка MIC GEV в доке позволяет говорить с картой.',
  // NOT seeded: the environmental tile's <strong>/<small> are pinned verbatim
  // by firstRunExperience.test.mjs (and the title is painted from
  // ENVIRONMENTAL_LABEL_CHOICE at init) — the support worker wires them in
  // phase 3 together with the test update.

  // index.html #key-setup
  'keySetup.closeAriaLabel': 'Закрыть настройку ключей',
  'keySetup.description': 'Глобус уже летает без ключей. Каждый ключ ниже включает ещё один реальный канал данных — вставьте ключ, он сохранится в локальную конфигурацию приложения, и сервер перезапустится сам. Серверные ключи остаются на этой машине; Google Maps и Cesium ion работают в браузере, и их ключи должны быть ограничены на стороне провайдера. Настроенные вами в другом месте ключи отображаются, но не изменяются.',
  'keySetup.hint': 'ESC — закрыть',
  'keySetup.note': 'Ключ Google Maps открывает фотореалистичную планету — всё остальное надстраивается поверх неё.',

  // index.html scene director panel chrome (src/scenes/director.js surface)
  'scenes.panelTitle': 'СЦЕНЫ',
  'scenes.collapseTitle': 'Свернуть панель',
  'scenes.recipeAriaLabel': 'Рецепт сцены',
  'scenes.new': 'НОВАЯ',
  'scenes.delete': 'УДАЛ.',
  'scenes.capture': 'СДЕЛАТЬ КАДР',
  'scenes.updateShot': 'ОБНОВИТЬ КАДР',
  'scenes.start': 'СТАРТ',
  'scenes.stop': 'СТОП',
  'scenes.next': 'ДАЛЕЕ',
  'scenes.exportPresets': 'ЭКСПОРТ ПРЕСЕТОВ',
  'scenes.import': 'ИМПОРТ',
  'scenes.runLog': 'ЖУРНАЛ ЗАПУСКОВ',
  'scenes.statusReady': 'Готово',

  // ── Phase-3 runtime extraction (support surfaces), appended ───────────────

  // src/firstRunExperience.js — mission busy lines and status/error copy.
  // {detail} is the failed layer-id list (machine values, kept raw).
  'firstRun.busy.contacts': 'Запуск контактов в реальном времени…',
  'firstRun.busy.spaceMissions': 'Открытие космических миссий…',
  'firstRun.busy.environmental': 'Сканирование активных событий…',
  'firstRun.busy.working': 'Работаем…',
  'firstRun.status.failed': 'Не удалось открыть миссию{detail}. Повторите или изучите вручную.',
  'firstRun.status.storageBlocked': 'Браузер блокирует хранилище, поэтому сохранить не удалось.',
  // The environmental tile is painted at init from ENVIRONMENTAL_LABEL_CHOICE;
  // the subcopy names BOTH feeds (pinned verbatim by firstRunExperience.test.mjs).
  'firstRun.choice.environmentalSub': 'Землетрясения в реальном времени и активные пожары, от USGS и NASA',
  'firstRun.environmentalTitle.environmental': 'ЭКОЛОГИЯ',
  'firstRun.environmentalTitle.earthWatch': 'ДОЗОР ЗЕМЛИ',
  'firstRun.environmentalTitle.activeEvents': 'АКТИВНЫЕ СОБЫТИЯ',

  // src/keySetup.js — chip counter, status line, and remove confirm.
  'keySetup.chipWaiting': { one: 'ЗАПУСК · {count} КЛЮЧ В ОЖИДАНИИ', few: 'ЗАПУСК · {count} КЛЮЧА В ОЖИДАНИИ', many: 'ЗАПУСК · {count} КЛЮЧЕЙ В ОЖИДАНИИ', other: 'ЗАПУСК · {count} КЛЮЧА В ОЖИДАНИИ' },
  'keySetup.chipReady': 'ЗАПУЩЕНО',
  'keySetup.status.saveFailed': 'Не удалось сохранить ({status}).',
  'keySetup.status.saveFailedDetail': 'Не удалось сохранить: {detail}',
  'keySetup.status.pasteFirst': 'Сначала вставьте хотя бы один ключ.',
  'keySetup.status.saved': 'Сохранено: {store}. Перезапуск — страница перезагрузится сама.',
  'keySetup.status.removed': 'Удалено: {store}. Перезапуск — страница перезагрузится сама.',
  'keySetup.store.pinokio': 'ваша конфигурация приложения',
  'keySetup.store.env': 'ваш локальный .env',
  'keySetup.confirm.remove': 'Удалить этот ключ из сохранённой конфигурации?',

  // src/mapStackChips.js — unavailable-chip tooltip and aria templates.
  'mapStack.fallbackName': 'Этот набор карт',
  'mapStack.unavailableReason': '{label} недоступен',
  'mapStack.unavailableAriaLabel': '{label} недоступен: {hint}',

  // src/scenes/director.js — built-in recipe DISPLAY names only. Recipe ids
  // and the URL 'scene' param stay English; stored/renamed project titles are
  // user data and render verbatim.
  'scenes.recipe.flightsRadar': 'Глобальный радар рейсов',
  'scenes.recipe.orbitalWatch': 'Орбитальный дозор',
  'scenes.recipe.thermalThreats': 'Панель тепловых угроз',
  'scenes.recipe.cityOverload': 'Перегрузка города',
  'scenes.recipe.omnisciencePullback': 'Отъезд к всевидению',

  // src/voice/gevRealtime.js — mic chrome and connection/execution STATUS
  // text. Status enum keys (idle/connecting/…) are machine values; tool
  // names/schemas and model-facing results stay English (keep-English
  // boundary). Tier badges STD/MINI and the MIC/ON-OFF mic label stay machine
  // identifiers this phase.
  'voice.status.idle': 'ВЫКЛ',
  'voice.status.connecting': 'ПОДКЛЮЧЕНИЕ',
  'voice.status.listening': 'СЛУШАЮ',
  'voice.status.executing': 'ВЫПОЛНЕНИЕ',
  'voice.status.error': 'ОШИБКА',
  'voice.status.sessionCostCap': 'Сессия завершена — лимит стоимости {cost}',
  'voice.detail.standby': 'ГОЛОС В ОЖИДАНИИ',
  'voice.detail.active': 'ГОЛОС АКТИВЕН',
  'voice.detail.unavailable': 'ГОЛОС НЕДОСТУПЕН',
  'voice.detail.microphoneUnavailable': 'Поддержка микрофона WebRTC недоступна',
  'voice.detail.requestingMicrophone': 'Запрос доступа к микрофону',
  'voice.detail.holdSpaceTalk': 'Удерживайте Space, чтобы говорить',
  'voice.detail.releaseSpaceSend': 'Отпустите Space, чтобы отправить',
  'voice.detail.askOrCommand': 'Спросите или скомандуйте',
  'voice.detail.voiceOff': 'Голос выключен',
  'voice.detail.runningCommand': 'Выполнение команды',
  'voice.detail.radioDidNotStart': 'Радио не запустилось',
  'voice.hint.default': 'Удерживайте Space, чтобы говорить · нажатие Space активирует элемент в фокусе',
  'voice.error.sessionStart': 'Не удалось запустить голосовую сессию.',
  'voice.error.trayTitle': 'ОШИБКА ГОЛОСОВОЙ СИСТЕМЫ',
  'voice.error.dismiss': 'СКРЫТЬ',
  'voice.error.hint': 'Проверьте разрешение для микрофона и доступ к сети, затем повторите.',
  'voice.kicker.agent': 'ИИ-АГЕНТ',
  'voice.kicker.control': 'ГОЛОСОВОЕ УПРАВЛЕНИЕ',
  'voice.tier.appliesNextSession': '{tier} вступит в силу со следующей сессии',
  'voice.tier.buttonTitle': 'Уровень голосовой модели — вступит в силу со следующей сессии',
  'voice.cost.buttonTitle': 'Оценочная стоимость сессии',
  'voice.button.ariaLabel': 'Голосовое управление — активируйте, чтобы включить или выключить голос; удерживайте Space, чтобы говорить',

  // ── Stage-4 repair pass: src/scenes/director.js status corpus, appended ───
  // Status/confirm lines and the default shot title. {scene}/{shot} carry
  // stored project titles (user data, rendered verbatim); {mode} is the raw
  // context-mode identifier (machine value, keep-English boundary).
  'scenes.status.captureCameraNotReady': 'Не удалось сделать кадр: камера не готова',
  'scenes.status.shotTitleDefault': 'Кадр {n}',
  'scenes.status.captured': 'Кадр снят: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'Сначала выберите кадр',
  'scenes.status.updated': 'Обновлено: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'Удалить кадр «{shot}»?',
  'scenes.status.loaded': 'Загружено: {scene} / {shot}',
  'scenes.status.cameraUnavailable': 'Камера недоступна — сначала выйдите из кабины',
  'scenes.status.noShotsToRun': 'Нет кадров для запуска',
  'scenes.status.runningShot': 'Воспроизведение {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'Воспроизведение сцены завершено',
  'scenes.status.runError': 'Ошибка: {message}',
  'scenes.status.contextExitFailed': 'Не удалось выйти из {mode} — слои сцены могут быть отклонены',

  // ── Stage-4 repair pass: keySetup dev-surface copy, appended ──────────────
  // src/keySetup.js buildRow() remove chrome (dev-server-only surface).
  'keySetup.row.remove': 'УДАЛИТЬ',
  'keySetup.row.removeTitle': 'Удалить {title} из сохранённых ключей этого приложения',
  // src/keySetupCore.mjs keySetupRequirement(): availability sentence naming
  // the registry env vars (machine values stay raw).
  'keySetup.requirement': 'Требуется {envVars} — добавьте в настройках провайдеров',
  // src/keySetupCore.mjs KEY_SETUP_KEYS `unlocks` copy, keyed by registry id;
  // en values must stay byte-identical to the registry strings.
  'keySetup.unlocks.google-maps': 'Фотореалистичная 3D-планета + поиск мест',
  'keySetup.unlocks.google-maps-server': 'Контекст Places + резервный Street View; отдельный ключ по желанию',
  'keySetup.unlocks.openai': 'Голосовое управление — говорите с планетой',
  'keySetup.unlocks.aisstream': 'Суда в реальном времени, по всему миру',
  'keySetup.unlocks.firms': 'Обнаружение активных пожаров в реальном времени',
  'keySetup.unlocks.tomtom': 'Реальный трафик в реальном времени (без ключа — симуляция)',
  'keySetup.unlocks.cesium-ion': 'Наборы карт Bing imagery + мировой рельеф',
  'keySetup.unlocks.opensky': 'Больше лимитов опроса рейсов (анонимный доступ работает без ключа)',
  'keySetup.unlocks.launch-library': 'Повышенный лимит запросов для космических миссий',

  'scenes.status.actionFailed': 'Сбой действия со сценой',

  'scenes.status.projectExported': 'Проект экспортирован',

  'voice.tierNextSession': 'Следующая сессия: {pendingId} — текущая остаётся на {modelId}',
  'voice.tierSwitchHint': 'Голосовая модель: {pendingId} — нажмите, чтобы переключиться на {target}; вступит в силу со следующей сессии',
  'voice.costTooltip': 'Оценочная стоимость сессии на {modelId} — {responses} ответ(ов). Предупреждает при {warn}, завершает сессию при {cap}.',
};
