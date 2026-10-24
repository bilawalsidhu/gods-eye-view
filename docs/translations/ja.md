# Japanese (`ja`)

Catalog: `src/i18n/locales/ja.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

## Style

- Messages, hints, errors and confirmations use polite です/ます form: 「地点を選択してください」「データを取得できませんでした」. Do not mix it with plain だ/である form.
- Buttons and menu items are short nouns or verb stems, not sentences: 「保存」「閉じる」「再試行」「キャンセル」. Toggles name the thing: 「ラベル」, not 「ラベルを表示する」.
- Headings, chips, HUD readouts and status labels end in a noun (体言止め) with no 「。」: 「ライブ」「データ取得中」「接続なし」.
- Sentences end with 「。」 and use 「、」, both full-width. Short labels take no final punctuation, the same as the English.
- Write numbers, Latin letters and placeholders half-width. Put no space between Japanese text and a number, a Latin word or a `{placeholder}`: 「{count}件のカメラ」「Mapillaryの画像」. Keep a space where the English uses one between a number and a unit (`12 km`), and keep the separators `·`, `—`, `→`, `↗` and `…` with the spacing the English gives them.
- Use full-width parentheses （ ） and 「 」 quotation marks inside Japanese text. Keep ASCII brackets that belong to codes or data: `[LIVE]`, `(UTC)`.
- English UPPERCASE has no Japanese equivalent. Short Japanese is the equivalent: translate `LOADING` as 「読込中」, not 「ローディング」. Keep established Latin codes as they are (see below).
- Use katakana only for terms Japanese users already read in katakana (レイヤー, フィード, プリセット). Otherwise prefer kanji: 「追跡」 not 「トラッキング」, 「設定」 not 「セッティング」. Long vowel marks follow current JIS/Microsoft style: 「レイヤー」「フォルダー」「ユーザー」「サーバー」.
- Keep HUD text short. If the Japanese would wrap where the English does not, choose the shorter standard term: 「到着予定」 → 「ETA」 is fine on a readout, but use 「到着予定時刻」 in a sentence.

## Plurals

`Intl.PluralRules('ja')` has a single category, `other`. Each `tn()` entry holds one string, normally with a counter: 「{count}件」.

| Thing counted                                 | Counter | Example         |
| --------------------------------------------- | ------- | --------------- |
| aircraft, flights, satellites, drones         | 機      | {count}機       |
| vessels, ships                                | 隻      | {count}隻       |
| cameras, vehicles, receivers, devices         | 台      | {count}台       |
| records, results, alerts, events, sources     | 件      | {count}件       |
| places, sites, stations, installations, cells | か所    | {count}か所     |
| people                                        | 人      | {count}人       |
| keys, layers, items not listed here           | 個 / 件 | {count}個のキー |

When a counter reads unnaturally, put the number after a colon instead: 「回答: {responses}」「利用可能: {bikes}」.

## Units and numbers

- Distance and speed: km, m, km/h, m/s, kt (knots), ft, mi. Leave unit symbols half-width and untranslated. Spell out 「ノット」 only in sentences where `kt` would be unclear.
- Time: 時間/分/秒 in sentences (「5分前」), and h, min, s in compact HUD readouts that the English writes that way.
- Numbers and dates always go through the formatters (`formatNumber`, `formatDate`, `formatRelativeTime`), which produce `1,234` and 2026/10/18-style dates for `ja`. Never write a date order into a string.
- Degrees and percentages stay `°` and `%`.

## Codes kept in Latin

As in Japanese aviation and broadcast practice, these stay as written in English, and are listed under `ja` in `src/i18n/same-as-english.json` when an entry is nothing else: HDG, BRG, CRS, FOV, DEST, SPD, ALT, ETA, UTC, ADS-B, AIS, CCTV, FLIR, NVG, CRT, GEO, REC, NAV, MHz, AM/FM, compass codes on instruments (N, NNE, …), and product, provider and dataset names (Google Maps, Cesium ion, OpenAI, NASA FIRMS, USGS, OpenSky, Mapillary, OpenStreetMap …).

## Glossary

| English                                                    | 日本語                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| layer / data layer                                         | レイヤー / データレイヤー                                     |
| feed                                                       | フィード                                                      |
| source / data source                                       | ソース / データソース                                         |
| LIVE (status) / live data                                  | ライブ / リアルタイムデータ                                   |
| SIMULATED                                                  | シミュレーション                                              |
| stale / degraded / unavailable                             | 古いデータ / 品質低下 / 利用不可                              |
| loading / retry / offline                                  | 読込中 / 再試行 / オフライン                                  |
| key (API key) / POWER UP                                   | キー（APIキー） / パワーアップ                                |
| Provider Settings                                          | プロバイダー設定                                              |
| globe / map / basemap / map source                         | 地球儀 / マップ / ベースマップ / マップソース                 |
| aircraft / flight / military flights                       | 航空機 / フライト / 軍用機                                    |
| callsign / tail number / squawk                            | コールサイン / 機体記号 / スコーク                            |
| vessel, ship / vessels                                     | 船舶 / 船舶                                                   |
| satellite / orbit                                          | 衛星 / 軌道                                                   |
| launch (rocket) / space mission                            | 打ち上げ / 宇宙ミッション                                     |
| contact (tracked target) / tracking                        | 目標 / 追跡                                                   |
| follow (camera) / unfollow                                 | 追従 / 追従解除                                               |
| installation, site                                         | 施設                                                          |
| camera / CCTV camera                                       | カメラ / CCTVカメラ                                           |
| earthquake / magnitude                                     | 地震 / マグニチュード                                         |
| active fire / fire perimeter                               | 火災検知 / 延焼範囲                                           |
| cyclone / advisory (NHC/CPHC)                              | サイクロン / アドバイザリー                                   |
| weather / wind / radar                                     | 気象 / 風 / レーダー                                          |
| air quality / AQHI                                         | 大気質 / AQHI                                                 |
| traffic / transit / bike share                             | 交通状況 / 公共交通 / シェアサイクル                          |
| scene / shot / scene recipe                                | シーン / ショット / シーンレシピ                              |
| briefing / panel / dock                                    | ブリーフィング / パネル / ドック                              |
| preset / visual preset                                     | プリセット / 表示プリセット                                   |
| Scope (circular viewport mask)                             | スコープ                                                      |
| heading / altitude / ground speed                          | 方位 / 高度 / 対地速度                                        |
| bearing / range / distance                                 | 方位角 / 距離範囲 / 距離                                      |
| Street View (Google) / Street Level                        | ストリートビュー / ストリートレベル                           |
| Recent Imagery / imagery                                   | 最新画像 / 画像                                               |
| anchor / data pack / bundle (scene)                        | アンカー / データパック / バンドル                            |
| camera move                                                | カメラ移動                                                    |
| PREV / NEXT (short), Previous / Next                       | 前 / 次、前へ / 次へ                                          |
| SIG / NEWS / LOCAL (briefing tabs)                         | 信号 / ニュース / 地域                                        |
| L / R (relative bearing)                                   | 左 / 右                                                       |
| voice / push to talk                                       | 音声 / プッシュトゥトーク                                     |
| share link / copy link                                     | 共有リンク / リンクをコピー                                   |
| enable / disable, ON / OFF                                 | 有効にする / 無効にする、オン / オフ                          |
| settings / clear / reset                                   | 設定 / クリア / リセット                                      |
| mapped (sites, installations, data)                        | マップ上の / マップデータ（「地図」は使わない）               |
| calibration / CAL                                          | 校正（「キャリブレーション」「較正」は使わない）              |
| station: radio / bike share / space / weather, air quality | 局（文中は放送局） / ステーション / 宇宙ステーション / 観測所 |
| coverage: street imagery, CCTV / weather / imagery box     | 撮影範囲 / 対象範囲 / カバー範囲                              |
| rate-limited                                               | リクエスト制限中                                              |
| upstream (feed origin)                                     | 配信元                                                        |
| routing / route / turn-by-turn                             | ルート検索 / ルート / ルート案内                              |
| roundabout / ramp / lane                                   | ロータリー / ランプ / 車線                                    |
| Global Context / Context (mode) / CONTEXT (panel title)    | グローバルコンテキスト / コンテキスト / 状況                  |
| NOT AN ALL-CLEAR / CONTACT LOST                            | 異常なしとは限りません / 目標喪失                             |
| Normal (vision style, NORMAL)                              | 標準                                                          |
| Reduced motion (OS setting)                                | 動きの軽減                                                    |
| reconstruction / story beat / evidence                     | 再現 / ストーリー区切り / 証拠                                |
| historical reference / post-event                          | 過去参照 / 事後                                               |
| export / import                                            | エクスポート / インポート                                     |
| containment / FIRMS confidence low, nominal, high          | 鎮圧（率） / 低・中・高                                       |
| COURSE ALIGNED                                             | 針路一致                                                      |
| Draw / CAPTURE SHOT / SWAP / MIC / Enable, Disable (Radio) | 描画 / ショットを記録 / 入替 / マイク / 有効化、無効化        |
| PILOT (AIS vessel type 50)                                 | 水先船                                                        |
| loading (label / sentence)                                 | 読込中 / 読み込み（文中）                                     |

### Joiners, ranges, money

- `', or '` and `'{requirement}, or {offer}'` (key guidance, src/ui/keyGuidance.js) join whole requests: 「。または、」. Each option is a full request ending in 「…してください」, so 2 and 3+ options read 「A。または、B。または、C」.
- `' or '` (provider names, src/ui/streetLevelPresentation.js) is 「または」 with no spaces: 「GoogleストリートビューまたはMapillary」.
- Ranges use 「～」: 「2～6日」「50～99%」.
- Money `${amount}K/M/B` stays as in English (`$1.2M`, listed in same-as-english): the amount arrives pre-formatted, and 千ドル/百万ドル would give 「1.2百万ドル」.
- Ages: a FIRMS card age can be 「1時間未満」, so templates around it use 「経過」 (「{value}経過」), never 「{value}前」.

### Nepal / Bhote Koshi place names

| English                    | 日本語                            |
| -------------------------- | --------------------------------- |
| Bhote Koshi                | ボテコシ川                        |
| Rasuwa / Rasuwagadhi       | ラスワ / ラスワガディ             |
| Gyirong                    | 吉隆（キーロン）                  |
| Timure                     | ティムレ                          |
| Syabru Besi                | シャブルベシ                      |
| Mailung                    | マイルン                          |
| Trishuli / Trishuli Bazaar | トリシュリ / トリシュリ・バザール |
| Bidur                      | ビドゥル                          |
| Devighat / Taadi Khola     | デビガート / ターディ・コーラ     |
| Dandagaun                  | ダンダガウン                      |
