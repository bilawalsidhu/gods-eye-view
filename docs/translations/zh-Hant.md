# Traditional Chinese (`zh-Hant`)

Catalog: `src/i18n/locales/zh-Hant.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

**Do not translate or edit this catalog: it is generated.** `zh-Hant` is the Simplified Chinese catalog (`zh-CN`, credited to abiyeenzo, #914, and EDIT-Aeterna, #979) written in Traditional characters. Wording and terminology are the same as in `zh-CN`; only the script differs. To add or change an entry, edit [zh-CN.md](./zh-CN.md) and the `zh-CN` catalog, then run:

```sh
npm run i18n -- --zh-hant        # rewrite zh-Hant.json from zh-CN.json
```

`npm test` fails when `zh-Hant.json` differs from the conversion of `zh-CN.json`, naming the entry, and `npm run i18n -- --missing zh-Hant` points to this command instead of printing a template.

The command converts with OpenCC `s2tw` ([opencc-js](https://github.com/nk2028/opencc-js), `cn` → `tw`), which changes characters only. Never `s2twp`: it also swaps in Taiwan vocabulary (影片, 伺服器, 載入, 圖示), which this catalog does not use. After the conversion it fixes the characters OpenCC picks wrongly here: 年曆史 → 年歷史, 下遊 → 下游, 並道 → 併道, 發佈 → 發布, 公佈 → 公布, 控制檯 → 控制台, and 周 → 週 where it means a week (1 週/秒). The list is `ZH_HANT_CORRECTIONS` in `scripts/i18n.mjs`; when the conversion picks another wrong character, add the pair there and run the command.

An entry `zh-CN` keeps in English on purpose needs the same line under `zh-Hant` in `src/i18n/same-as-english.json`.

## Style

- Wording, punctuation, spacing, units and the glossary are those of [zh-CN.md](./zh-CN.md), written in Traditional characters.
- Relative-time placeholders may already include 前. In `LIVE · updated {age}`, the caller supplies the complete relative age; do not append another 前.
- The picker displays 中文（繁體） / Chinese (Traditional); explicit Hans tags select Simplified Chinese.

## Plurals

`Intl.PluralRules('zh-Hant')` uses only `other`. The measure words come from the `zh-CN` entry: 「{count} 架飛機」、「{count} 艘船」.
