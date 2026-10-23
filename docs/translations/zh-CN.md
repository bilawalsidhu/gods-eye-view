# Simplified Chinese (`zh-CN`)

Catalog: `src/i18n/locales/zh-CN.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation sources: abiyeenzo (#914) and EDIT-Aeterna (#979).

## Style

- Mainland usage and Simplified characters. Address the user neutrally, without 您/你 where a plain imperative works: 「点击地图」, 「重试」.
- Chinese has no case: an UPPERCASE English HUD label becomes the same short Chinese label. Keep labels as short as the English: 「实时」, 「过期」, 「关」.
- Full-width punctuation in Chinese text: ，。：；？！（）“”. A dash is 「——」 without spaces; keep `·` as the HUD separator and `…` for ellipsis.
- One space between Chinese and Latin letters or digits: 「AIS 船舶」, 「24 小时」, 「{count} 个」. No space next to full-width punctuation.
- Units: km, m, km/h, m/s, kn, ft, MW, °, % stay as written; time words are 小时, 分钟, 秒 after a number (「5 分钟前」).
- Product names, provider names and codes stay as they are: Google, Cesium, CelesTrak, NOAA, FIRMS, AIS, ADS-B, GNSS, CCTV, HUD, CRT, NVG, FLIR, WHOT/BHOT, Ironbow, CONUS.

## Plurals

`Intl.PluralRules('zh-CN')` has one category, `other`: a `tn()` entry has only that form. Use a measure word next to the number where Chinese needs one: 「{count} 个密钥」, 「{count} 架飞机」, 「{count} 艘船」.

## Glossary

| English                               | 中文                        |
| ------------------------------------- | --------------------------- |
| layer / data layer                    | 图层 / 数据图层             |
| feed                                  | 数据源                      |
| source / data source                  | 来源 / 数据源               |
| LIVE (status) / live data             | 实时 / 实时数据             |
| SIMULATED                             | 模拟                        |
| stale / degraded / unavailable        | 过期 / 降级 / 不可用        |
| retry                                 | 重试                        |
| key (API key) / POWER UP              | 密钥（API 密钥）/ 增强      |
| Provider Settings                     | 服务商设置                  |
| globe / map / map source / basemap    | 地球 / 地图 / 地图源 / 底图 |
| aircraft / flight / military flights  | 飞机 / 航班 / 军用航班      |
| vessel, ship                          | 船舶                        |
| satellite                             | 卫星                        |
| launch (rocket) / space mission       | 发射 / 太空任务             |
| contact (tracked object)              | 目标                        |
| installation, site                    | 设施                        |
| camera / CCTV camera                  | 摄像头 / CCTV 摄像头        |
| earthquake / active fire              | 地震 / 活跃火点             |
| scene / shot                          | 场景 / 镜头                 |
| briefing / panel / dock               | 简报 / 面板 / 停靠栏        |
| preset / visual preset                | 预设 / 视觉预设             |
| Display / HUD layout                  | 显示 / HUD 布局             |
| Tactical / Operator / Minimal / Cyber | 战术 / 操作员 / 精简 / 赛博 |
| Scope (circular viewport mask) / keyhole | 视域                      |
| Clean UI                              | 纯净界面                    |
| cockpit                               | 座舱                        |
| heading / altitude / ground speed     | 航向 / 高度 / 地速          |
| map heading / North up                | 方位 / 正北朝上             |
| Street Level / Street View (Google)   | 街景 / 街景（Google）       |
| Recent Imagery                        | 近期影像                    |
| Global Context / Context (panel)      | 全局态势 / 态势             |
| radio (station)                       | 电台                        |
| transit / bikeshare                   | 公共交通 / 共享单车         |
| Previous / Next                       | 上一个 / 下一个             |
| compass points (N, NNE, …)            | 北, 北东北, …               |
| weather field / FIELD (selector)       | 气象场 / 要素               |
| weather model / forecast lead hours   | 模式 / 预报时效             |
| valid (forecast time)                 | 有效时间                    |
| scene cloud / mosaic                  | 整景云量 / 镶嵌图           |
| pin (Recent Imagery)                  | 固定                        |
| THIS (voice pointer)                  | 所指                        |
| outline / trace an outline            | 轮廓 / 绘制轮廓             |
| mark (map annotation)                 | 标注                        |
| camera badge                          | 摄像头标记                  |
| provider / embedded provider controls | 服务商 / 平台控件           |
| share (a view or link)                | 分享                        |
| AI agent                              | AI 智能体                   |
| stage (rocket) / downrange            | 子级 / 航程                 |
| capture shot / camera move            | 保存镜头 / 运镜             |
| story beat / evidence beat            | 事件节点 / 证据节点         |
| camera pose                           | 位姿                        |
| forecast uncertainty cone             | 预报不确定范围              |
| seed (catalog data)                    | 预置                        |
| frame (bring into view)               | 将…纳入视野                 |
