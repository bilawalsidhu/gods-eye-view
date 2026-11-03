# Проверка отделения слоёв от планеты

Рабочая ветка `codex/navara`. База плана `deb85ed5`. В таблице «удерживается» означает, что между сценами сохраняется экземпляр модели и его данные. Восстановление слоя из ссылки при создании нового экземпляра этой проверке не соответствует.

| Слой | Что проверено |
| --- | --- |
| Live Flights | Воспроизведён исходный сбой на рейсе `71be26`. После исправления `qa-layer-handoff.mjs` проходит Navara → Cesium → Navara. Один документ, менеджер, слой и таймер. Кабина открыта, сохраняются выбранный самолёт и режим обзора, камера на высоте самолёта. За обе смены не было дополнительных запросов к источнику. При отсутствии сцены продолжают работать обновление, поиск и аналитические запросы. |
| Military Flights | Военная классификация и наблюдения сохраняются, в том числе при ответе источника между сценами. В headless-тесте выбран борт `aaa052`. После отказа запуска Cesium и на обоих успешных переключениях сохранились кабина, модель, таймер и кнопка слоя. |
| Live AIS Vessels | Реальный клик выбирает судно 123456789. На переходе Navara → Cesium → Navara сохраняются экземпляр слоя, выбранное судно, шеврон, карточка и единственный запрос истории. Модульная проверка принимает обновление и добавляет точку следа между сценами. |
| Global Context и Mapped Installations | Проверен переход Navara → Cesium → Navara в активном Contacts. Выбрали первое судно и перешли ко второму через NEXT. Сохранились оба ID истории, текущая цель и пять включённых слоёв. На Navara после возврата создан один круг радиуса 250 км. После выхода из Contacts вернулся набор слоёв, включённых пользователем до входа. |
| S2 GhostMaps | Одна подписка на каталог и одно чтение тестового KMZ за Navara → Cesium → Navara. Реальный клик находит упакованный значок, линию и полигон. Отверстие полигона не выбирается, карточка зоны переживает переключение. Проверено также завершение распаковки между сценами. |
| Радар, спутниковая облачность и плотность молний | Общие манифесты, порядок наложения и исторический кадр проверены на Navara → Cesium → Navara. Все три слоя остались на одном времени без повторного запроса манифеста. Проверка сравнивает пиксели поверхности, включая молнии над радаром. |
| Циклоны | Реальный клик в конус выбирает шторм на обеих планетах, клик вне геометрии снимает выбор. Переход между движками не перезагружает бюллетень. При замене бюллетеня исчезают устаревшие трек, конус и прогнозные точки, а карточка остаётся на том же шторме. |
| Дата-центры и дамбы | Полные файлы загружены по одному разу. После раскрытия составных геометрий получились 4 362 и 716 объектов. Обе планеты применяют исходные бюджеты детализации. Выбор дата-центра Geneseo Communications Inc реальным кликом сохранился при переходе в Cesium и обратно. |
| Earthquakes | Сцены отображают одни наблюдения USGS. Модульный тест доставляет обновление между сценами и проверяет карточку аналитика, геометрию и подпись при новом подключении. Штатный сценарий переключения также проверяет историю браузера и возврат к прогретому движку. |
| GNSS Integrity | История и сроки действия ячеек принадлежат источнику. В headless-проверке Navara → Cesium → Navara одинаковы регион выборки и число ячеек высокого уровня. Проверен пиксель внутри ячейки. На Navara ячейки FIRMS и GNSS используют один проход без захвата кликов. |
| Fire Perimeters | Реальный клик под включённым GNSS открывает карточку инцидента. Клик снаружи очищает выбор, клик в отверстии полигона его не выбирает. При переходе Navara → Cesium → Navara карточка остаётся на прежнем инциденте. |
| Air quality | В обеих сценах проверена фикстура станции в Торонто с AQHI 9. Совпадают ID, координаты, значение и карточка. При дневном Sentinel-2 на Navara виден диск в 6 км вокруг станции. Переключение в Cesium и обратно сохраняет модель. |

## Повторение

При искусственном отказе создания WebGL-контекста Cesium восстанавливаются Navara, тот же рейс и кабина. Следующая попытка проходит успешно.

Сборка и preview с пустыми `GOOGLE_MAPS_API_KEY` и `CESIUM_ION_TOKEN`. На отдельном разрешённом порту выполнить `node scripts/qa-layer-handoff.mjs http://127.0.0.1:4208/` и `node scripts/qa-engine-switch.mjs http://127.0.0.1:4208/`. Для проверки военного рейса передать `--military` в `qa-layer-handoff.mjs`. Проверка качества воздуха, GNSS и пожарных периметров — `node scripts/qa-ground-layer-switch.mjs http://127.0.0.1:4208/`. Скрипты используют headless Chrome и блокируют платные тайлы до перехода на страницу. Если эталонные данные меняются, повторить сначала сценарий без пользовательских ключей.

Для проверки Contacts выполнить `node scripts/qa-contact-switch.mjs http://127.0.0.1:4208/`.

Для проверки S2 выполнить `node scripts/qa-ghostmaps-switch.mjs http://127.0.0.1:4208/`.

Для проверки погодных наблюдений и смены бюллетеня циклонов выполнить `node scripts/qa-weather-engine-switch.mjs http://127.0.0.1:4208/`.

Для проверки полных инфраструктурных наборов выполнить `node scripts/qa-infrastructure-engine-switch.mjs http://127.0.0.1:4208/`.

## Открытые пункты

Из 33 слоёв каталога исходно в Navara зарегистрировано 15. С добавлением Air quality, GNSS Integrity и Fire Perimeters зарегистрировано 18. С Global Context зарегистрировано 19, с S2 GhostMaps — 20, с тремя погодными продуктами — 23, с циклонами — 24, с дамбами и дата-центрами — 26. У остальных исходных адаптеров ещё нужно отделить данные от сцены и пройти проверки по `layers.md`. Семь слоёв ожидают переноса графики. Строка выбранного рейса в панели Vue сохраняет идентичность при успешном переключении и отказе запуска кандидата. Остальные контроллеры интерфейса и инструменты ещё создаются заново. Нужны отдельные проверки фонового/быстрого переключения и потери активного графического контекста. Полный паритет не достигнут.


### Local ADS-B receiver handoff

The tuner, decoder poller, ICAO motion history and selected flight belong to the layer session. Only model banks, trail draws and input handlers change on switch. The receiver fixture advanced while detached. Headless release round trip kept one feed start, zero stops and zero device closes, with the selected aircraft restored on both globes. No physical USB device was opened.

### Wind on both globes

The forecast model owns GFS/IFS acquisition, scalar overlay, pause, units and sampled position. Navara draws a single instanced flow mesh and composes the color field below observed weather. The keyless release round trip rendered 7,200 paths per engine, sampled 10 m/s from SW and 40 °C from the same grid, and proved the temperature color in the actual viewport. The animated phase advanced after resume and froze on pause. Package boundaries and the full unit suite passed.

### Submarine cables on both globes

The geographic source survives an in-flight scene change. Navara shares one route vector layer across 534 source colors, batches stems and marker tips, applies the common label ranking and flies to a clicked landing point. A keyless release round trip loaded all 712 cables and 1,917 landings, read each asset once, respected the 160-label ceiling and verified the landing flight. The full suite and package boundary checks passed.

### Directions and an active route flight

One layer retains A/B, a pending route, maneuver selection and the flight trajectory. Both cameras apply the same route frames and floor policy. The release test placed A and B with real Navara clicks, received the previously pending route in Cesium, restored the selected step, then switched twice during FLY. The same motion ID advanced on each globe (about 60 metres in each timed sample). CLEAR released it. The route was requested once. Full tests, boundaries, release build and keyless headless round trip passed.

### Nepal locator

The locator owns its Nepal boundary, presentation clock and source graphics, and switches only their scene attachment. Navara draws map-colored clamped geometry and pulse markers. The release test compared the same viewport with the river visible and hidden: 374 additional cyan pixels on Navara, 413 on Cesium, and 353 after returning to Navara. Also corrected engine-specific color evaluation for TeleGeography and dynamic credit ownership per display. The cable round trip passed again.

### Bhote Koshi reconstruction

The event pack, historical image pair, paused/playing timeline, player host and divider persist. Navara applies the geographic rasters to terrain depth and samples the same authored flood geometry. The release round trip proved different real before/after image pixels, one read of each event/image asset, identical 52 percent paused progress and continued playback on the next engine. Scene Director is now installed on Navara and its voice scene list works. Continuity of the Director’s own multi-shot queue and third-party scene data packs is separate from the event timeline round trip.

### Traffic

The city road source, flow requests, vehicle identities and simulation phase survive a switch. The incoming scene waits for the restored camera before querying its viewport or refreshing local surface heights. A release round trip in Austin retained 1,093 moving vehicles and 35 congestion corridors with fixture-backed live flow. The independent simulation case retained 620 vehicles. Both captures compared visible traffic against disabled traffic over the same streets.

### Street Level

Coverage, sequence, attribution, photo hosts and filters now share the same owner. The release checks used physical Navara line clicks on fixture-backed KartaView and Panoramax coverage. The same mounted photo and all 36 KartaView or 73 Panoramax sequence images survived Navara → Cesium → Navara. Google Street View still requires an eligible Google map and a configured key; these tests used neither.

### Radio and Recent Imagery

Radio kept one playing audio element, the selected broadcaster, volume and the original 750-station directory through Navara → Cesium → Navara. The fixture observed one play and one directory fetch. Recent Imagery retained both pinned dates and the original STAC search. Release screenshots sampled the expected red and green rasters on opposite sides on each engine. Box selection, divider dragging, a failed image replacement and cleanup also passed.

### FIRMS and ALPR camera reports

A pointer-selected FIRMS detection from a 371-fire snapshot and a pointer-selected camera in a 325-camera query stayed selected after both switches. Both layers reused the original records and acquisition timestamps and retained the application context selection. ALPR defers its viewport query until the new camera is in place; FIRMS recreates its horizon-culling and sprite-order bindings without reloading the feed.

### Bikeshare and Transit

The Boston GBFS test retained its selected dock, availability and 200 stations with one station-information request. Transit previously skipped proximity checks on a scene without a Cesium viewer. Its viewport now uses the active renderer. The MBTA fixture activated from the map, kept its 12 vehicles, selected bus and single trail-history request through both handoffs. The selection was made with a physical map click in both tests.

### CCTV projection and video

Camera records, calibration and the active decoder stay in the session. The renderer owns monitor planes, textures, markers, geometry and picking. The release check decoded a local 320 × 180 MP4, kept the same playing HTMLVideoElement through both switches, observed advancing decoded frames on each scene, retained the viewshed mode and created a native plane each time without another catalog request. The still-image scheduler and map-click regression tests also passed.
