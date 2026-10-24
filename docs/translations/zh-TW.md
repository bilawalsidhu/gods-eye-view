# Traditional Chinese (`zh-TW`)

Catalog: `src/i18n/locales/zh-TW.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Sources: caxer (#724), tbdavid2019 (#652), and the zh-CN catalog credited to abiyeenzo (#914) and EDIT-Aeterna (#979). The remaining entries were seeded with OpenCC s2twp and edited for Taiwan usage.

## Style

- Use Traditional characters and Taiwan terminology. Prefer short, neutral instructions: 「點選地圖」、「儲存金鑰」.
- Use full-width Chinese punctuation and 「」 for quotations. Keep `·`, `…`, provider names, codes and placeholders unchanged.
- Separate Chinese from Latin letters and numbers with a space: 「AIS 船舶」、「24 小時」. Keep unit symbols unchanged: km, m, km/h, m/s, kn, ft, MW, °, %.
- Chinese labels have no uppercase variant. Keep button labels short and avoid splitting short words across lines.
- Browser tags with Hant or TW/HK/MO select this Taiwan catalog. Explicit Hans selects Simplified Chinese, including Hans-TW. This is not a separate Hong Kong localization.

## Plurals

`Intl.PluralRules('zh-TW')` uses only `other`. Keep suitable measure words: 「{count} 架飛機」、「{count} 艘船」、「{count} 個金鑰」.

## Taiwan terminology

| English              | Taiwan                | Mainland            |
| -------------------- | --------------------- | ------------------- |
| data / information   | 資料 / 資訊           | 数据 / 信息         |
| file / folder        | 檔案 / 資料夾         | 文件 / 文件夹       |
| settings / save      | 設定 / 儲存           | 设置 / 保存         |
| API key / token      | API 金鑰 / 權杖       | API 密钥 / 令牌     |
| live / load          | 即時 / 載入           | 实时 / 加载         |
| camera / video       | 攝影機 / 影片         | 摄像头 / 视频       |
| network / link       | 網路 / 連結           | 网络 / 链接         |
| image / imagery      | 圖像 / 影像           | 图像 / 影像         |
| click / double-click | 點選 / 按兩下         | 点击 / 双击         |
| response / timeout   | 回應 / 逾時           | 响应 / 超时         |
| layer / data layer   | 圖層 / 資料圖層       | 图层 / 数据图层     |
| cockpit / context    | 駕駛艙 / 態勢         | 座舱 / 态势         |
| air quality          | 空氣品質              | 空气质量            |
| transit / bikeshare  | 大眾運輸 / 公共自行車 | 公共交通 / 共享单车 |
