# Traditional Chinese (`zh-Hant`)

Catalog: `src/i18n/locales/zh-Hant.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

`zh-Hant` is the Simplified Chinese catalog (`zh-CN`, credited to abiyeenzo, #914, and EDIT-Aeterna, #979) written in Traditional characters with OpenCC character conversion. Wording and terminology are the same as in `zh-CN`: change a term in [zh-CN.md](./zh-CN.md) and the `zh-CN` catalog first, then convert. Only the script differs.

After `s2tw` conversion, fix the characters OpenCC picks wrongly: 年曆史 → 年歷史, 下遊 → 下游, 並道 → 併道, 發佈 → 發布, 公佈 → 公布.

## Style

- Follow [zh-CN.md](./zh-CN.md) for wording, punctuation, spacing, units and the glossary, written in Traditional characters.
- Relative-time placeholders may already include 前. In `LIVE · updated {age}`, the caller supplies the complete relative age; do not append another 前.
- The picker displays 中文（繁體） / Chinese (Traditional); explicit Hans tags select Simplified Chinese.

## Plurals

`Intl.PluralRules('zh-Hant')` uses only `other`. Keep the measure words of the `zh-CN` entry: 「{count} 架飛機」、「{count} 艘船」.
