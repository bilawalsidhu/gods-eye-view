# Arabic (`ar`)

Catalog: `src/i18n/locales/ar.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation sources: abiyeenzo (#915).

## Style

- Modern Standard Arabic, neutral across regions. Address the user with plain imperatives: «انقر»، «فعّل»، «أعد المحاولة».
- Arabic has no letter case: an UPPERCASE English HUD label becomes the same short Arabic label. Keep labels as short as the English: «مباشر»، «متقادم»، «متوقف».
- Status words in progress use «جارٍ …» («جارٍ التحميل»، «جارٍ الضبط»، «… جارٍ تشغيل اللقطة»), so a status chip never reads as the command next to it («ضبط» is the TUNE button); finished actions use the passive («تم الحفظ»، «أُلغي التحميل»). Data that refreshes itself «يُحدَّث» (يتحدّث means "speaks"). A sentence about a `{placeholder}` whose gender and number vary (tool, layer and cohort names, call signs, vessel names) stays impersonal: «{layers}: تم التفعيل للتو»، ««{name}» قيد الاستخدام»، «{id}: لا بيانات واردة الآن»، «لم يعد {name} ضمن البيانات المحمّلة».
- A label followed by its value takes a colon, so it does not read as a sentence: «الصوت: نشط»، «السياق: {value}»، «الاحتواء: {percent}%». A named mode or control quoted in a sentence takes «»: «يظهر في وضع «كثيف» فقط».
- Arabic punctuation in Arabic text: ، ؛ ؟ and «» for quotes. Keep `·` as the HUD separator, `—` with spaces, and `…`.
- Arrows that show a sequence point the way Arabic reads: «الإشارات ← الأخبار ← المحلي», «{origin} ← {destination}».
- Product names, provider names and codes stay in Latin letters: Google, Cesium ion, CelesTrak, NOAA, FIRMS, AIS, ADS-B, GNSS, CCTV, HUD, CRT, NVG, FLIR, WHOT/BHOT, Ironbow, Street View, Mapillary. Aviation and camera abbreviations stay Latin too: HDG, FOV, BRG, CRS, GS, TRK, V/S, SQUAWK. Local place names from the Bhote Koshi scene (Rasuwagadhi, Bidur, Timure…) stay Latin, and a site known by two names takes one Arabic noun in front: «جسر Mailung / Upper Trishuli»; well-known cities and countries are written in Arabic (أوستن، طوكيو، نيبال).
- Months are the international names used across the Arab world: يناير، فبراير … أغسطس.

## Digits and direction

- **Western digits (0–9)**, as in the catalog. The HUD reads like an instrument panel, and mixing ٠–٩ with Latin codes and coordinates misreads. `intlLocale('ar')` in `src/i18n/locale.js` passes `ar-u-nu-latn` to every Intl formatter, so browsers that default to Arabic-Indic digits for an Arabic region still show 0–9.
- **Right to left.** `ar` is in `RTL_LOCALES`, so the page gets `<html dir="rtl">`. The title, style indicator and both rails swap sides; the dock and the corner row reverse. The intel HUD (classification block, MGRS, coordinates, GSD) stays a left-to-right instrument overlay; its translated lines read right to left inside it. Media transport (previous / play / next) and the radio dial stay left to right, as on any player. Layout rules: `src/ui/styles/rtl.css`.
- Latin runs inside Arabic sentences (product names, codes, `{placeholders}` filled with English data) are isolated by the bidi algorithm; write them as plain text, without manual direction marks.
- Position counters: a translated counter says «من» («القناة {index} من {total}», «الإطار {index} من {total}»); a spaced slash between two isolated numbers swaps them in right-to-left text. Counters the code builds from bare numbers (`01 / 25`, `1 / 3`) are shown left to right by `rtl.css`.
- Code stays left to right: the JSON fields of the scene editor are LTR in every language.
- Comparison signs `<` and `>` are mirrored glyphs in right-to-left text («< 2%» shows as «> 2%»). Write them as words: «أقل من 2%»، «أكثر من 10%»، «أقل من ساعة». A legend's open upper bound («300+», «-40») is isolated by `formatScaleLabel()`, so its sign stays where it is written; `formatScaleRange()` isolates the unit after the range too («°C», not «C°»).

## Units

Distances and speeds take Arabic abbreviations after the number, with a space: كم، م، كم/س، كم/ث، م/ث، ميل/س، عقدة (knots)، قدم (feet)، مم. Time: ث (seconds)، د (minutes)، س (hours)، يوم; compact age labels («3d», «5D AGO») use ي: «{count} ي»، «قبل {count} ي», since a plain string cannot make يوم agree with the count. Area: آكر (acres, the value is not converted; فدان is a different unit). Money: the word دولار after the amount, not a bare `$`: «{amount} مليون دولار». Scientific and radio units stay Latin: MHz، dB، dBFS، dBZ، hPa، MW، MiB. `°` and `%` stay. Hemisphere letters in coordinates: ش (N)، ج (S)، ق (E)، غ (W), as in `21.33ش`.

## Plurals

`Intl.PluralRules('ar')` uses all six CLDR categories, and a `tn()` entry needs every one:

| Form    | Counts                      | Example       |
| ------- | --------------------------- | ------------- |
| `zero`  | 0                           | 0 مصدر        |
| `one`   | 1                           | مصدر واحد (1) |
| `two`   | 2                           | مصدران (2)    |
| `few`   | 3–10, 103–110…              | 3 مصادر       |
| `many`  | 11–99, 111–199…             | 11 مصدرًا     |
| `other` | 100–102, 200–202, fractions | 100 مصدر      |

Every form must keep `{count}`. For one and two, Arabic names the quantity with the noun itself (مصدر واحد، مصدران), so the number follows in parentheses. `few` takes the plural noun; `many` the accusative singular (مصدرًا، مفتاحًا); `zero` and `other` the genitive singular. When a word next to the number cannot agree in every form, or a short chip has no room, put the number after a colon instead: «القريبة: {count}»، «الملفات المحددة: {count}». Where neither fits, «من أصل {total} من السجلات» agrees with any number. A standalone unit label («الدقائق») is never glued after a number: the voice-timeout options («3 دقائق»، «15 دقيقة») come from `Intl.NumberFormat` unit formatting, not from the catalog.

## Glossary

| English                                    | العربية                                                    |
| ------------------------------------------ | ---------------------------------------------------------- |
| layer / data layer                         | طبقة / طبقة بيانات                                         |
| feed / source                              | مصدر بيانات (short: مصدر) / مصدر                           |
| LIVE (status) / live data                  | مباشر / البيانات المباشرة (not حي)                         |
| Live ships, live detections (descriptions) | بيانات مباشرة عن السفن، رصد مباشر (not the adverb مباشرةً) |
| track, tracking                            | تتبّع (always with the shadda)                             |
| SIMULATED                                  | محاكى (status) / محاكاة                                    |
| stale / degraded / unavailable             | متقادم / متدهور / غير متاح                                 |
| ON / OFF (state)                           | مفعّل / متوقف                                              |
| retry                                      | إعادة المحاولة                                             |
| key (API key) / POWER UP                   | مفتاح (مفتاح API) / تشغيل                                  |
| Provider Settings                          | إعدادات المزوّدين                                          |
| globe / map / map source / basemap         | الكرة الأرضية / الخريطة / مصدر الخريطة / الخريطة الأساسية  |
| globe map (map source drawn on the globe)  | خريطة على الكرة الأرضية (not خريطة كروية)                  |
| tiles                                      | بلاطات                                                     |
| aircraft / flight / military flights       | طائرة / رحلة / الرحلات العسكرية                            |
| Live Flights / Live Vessels (layers)       | تتبّع الرحلات / السفن المباشر (not الرحلات المباشرة)       |
| call sign                                  | رمز النداء                                                 |
| vessel, ship                               | سفينة                                                      |
| satellite                                  | قمر صناعي                                                  |
| launch (rocket) / space mission            | إطلاق / مهمة فضائية                                        |
| contact (tracked object)                   | هدف                                                        |
| installation, site / mapped                | منشأة، موقع / مرسوم                                        |
| camera / CCTV camera                       | كاميرا / كاميرا CCTV                                       |
| earthquake / active fire / fire perimeter  | زلزال / حريق نشط / محيط حريق                               |
| containment (wildfire)                     | احتواء (not السيطرة)                                       |
| cyclone advisory                           | نشرة إعصار                                                 |
| scene / shot / scene recipe                | مشهد / لقطة / قالب المشهد                                  |
| briefing / panel / dock                    | إحاطة / لوحة / الشريط السفلي                               |
| preset / visual preset                     | إعداد مسبق / نمط بصري                                      |
| Scope (circular viewport mask) / keyhole   | المنظار / الفتحة                                           |
| Clean UI / EXIT CLEAN VIEW                 | واجهة نظيفة / الخروج من الواجهة النظيفة (not العرض)        |
| cockpit                                    | القمرة (قمرة القيادة)                                      |
| heading / altitude / ground speed          | الاتجاه (HDG) / الارتفاع / السرعة الأرضية                  |
| Street Level / Street View                 | مستوى الشارع / Street View                                 |
| Recent Imagery                             | الصور الحديثة                                              |
| Global Context / Context                   | السياق العالمي / السياق                                    |
| radio station / tuner / gain               | محطة / موالف / الكسب                                       |
| VOLUME (slider) / VOICE                    | مستوى الصوت / الصوت                                        |
| decoder (SDR)                              | مفكّك                                                      |
| transit / bike share                       | النقل العام / الدراجات المشتركة                            |
| Previous / Next                            | السابق / التالي                                            |
| compass points (N, NNE, …)                 | شمال، شمال شمال شرق، …                                     |
| forecast / valid (time) / issued           | توقع / عند، وقت التوقع (not صالح حتى) / صدر                |
| observation / observed                     | رصد / مرصود                                                |
| heard (aircraft received by the SDR)       | الملتقطة                                                   |
| upstream (camera feed)                     | المصدر الأصلي (in every CCTV message, not bare المصدر)     |
| field (weather) / model                    | حقل / نموذج                                                |
| parameters / ellipsoid                     | المعلمات / المجسّم الإهليلجي                               |
| scene cloud                                | غيوم المشهد                                                |
| box (Recent Imagery area) / pin            | منطقة / تثبيت                                              |
| width (box size) / view (current camera)   | اتساع / العرض الحالي (عرض alone reads as display)          |
| N/A                                        | غير متاح (no abbreviation)                                 |
| METRO (view band) / REGIONAL               | حضري (not حاضرة) / إقليمي                                  |
| THIS (voice pointer)                       | هذا                                                        |
| outline / mark (map annotation)            | مخطط / علامة، تعليم                                        |
| share (a view or link)                     | مشاركة                                                     |
| AI agent                                   | وكيل ذكاء اصطناعي                                          |
| stage (rocket) / downrange                 | مرحلة / على امتداد المسار                                  |
| landing position: CONFIRMED / PAD (RTLS)   | مؤكَّد / منصة الإطلاق                                      |
| recovery (rocket stage)                    | استعادة (not استرجاع)                                      |
| Arrive at your destination (route step)    | الوصول إلى وجهتك (a step, not وصلت)                        |
| forecast lead hours                        | مدة التوقع بالساعات (not ساعات المهلة)                     |
| cel-shaded                                 | بتظليل كرتوني                                              |
| (debris-)dammed lake                       | بحيرة خلف سدّ (ركامي)                                      |
| frame (bring into view)                    | إظهار في الإطار                                            |
| story beat                                 | مرحلة القصة                                                |
