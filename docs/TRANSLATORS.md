# Translating God's Eye View

Shipped languages: **English** (source and fallback), **Spanish** (`es`), **Russian** (`ru`) and **Simplified Chinese** (`zh-CN`).

## How it works

The English text is the key: code calls `t('Save keys')`, and markup marks elements with `data-i18n`. How developers mark text is in [I18N.md](./I18N.md).

Every other language is one flat JSON file, `src/i18n/locales/<code>.json`, keyed by the English text:

```json
{
  "Save keys": "Сохранить ключи",
  "{count} cameras": {
    "one": "{count} камера",
    "few": "{count} камеры",
    "many": "{count} камер",
    "other": "{count} камеры"
  }
}
```

A `tn()` entry is keyed by the English plural form and holds one string per `Intl.PluralRules` category of that language. A missing entry falls back to English.

The page picks its language from `?lang=`, then the choice stored by the language picker (the globe button in the bottom-right corner), then the browser languages, then English. `?lang=` is not stored, and copied share links leave it out. Switching reloads the page.

## The check

```sh
npm run i18n                      # what is missing, unused or broken, per language
npm run i18n -- --missing ru      # missing ru entries as JSON, ready to translate
npm run i18n -- --prune           # drop entries the code no longer uses
```

`npm test` runs the same check. It fails on a missing, empty or unused entry, on placeholders that differ from the English, on a missing plural form, and on text or plural forms still in English. The `--missing` template fails until every entry is translated. If an entry is right in English (a code such as CRT, a product name), add it under your language code in `src/i18n/same-as-english.json`.

Changing English text changes its key: the old translation becomes unused and the new text shows as missing. Translate it and prune.

## Fixing a translation

Edit `src/i18n/locales/<code>.json` and run `npm run i18n`. To see your change, open the app with `?lang=<code>`.

## Adding a language

1. Create `src/i18n/locales/<code>.json`, fill it from `npm run i18n -- --missing <code>` (start from `{}`), and translate every entry.
2. Import it in `src/i18n/index.js` and add it to `CATALOGS`.
3. Add the code to `LOCALES` and its own-language name to `LOCALE_NAMES` in `src/i18n/locale.js`. Right-to-left languages also go in `RTL_LOCALES`.
4. Add `src/i18n/locales/<code>.json` next to `ru.json` in `scripts/package-boundaries.json`.
5. Write `docs/translations/<code>.md`: glossary, plural forms, units and style (copy the structure of `ru.md`).
6. Run `npm run i18n` and `npm test`, then check the panels in the app at narrow widths.

## Rules

- Keep every `{placeholder}` name exactly as in the English: do not rename, drop or add one. Its position inside the sentence follows the grammar of your language, e.g. `"{accepted} of {raw} records accepted"` → `"принято записей: {accepted} из {raw}"`.
- UPPERCASE English stays UPPERCASE. Short labels, chips and HUD readouts should stay short; prefer an abbreviation over a wrapped line.
- Keep the separators `·`, `—`, `→`, `↗`, `…`.
- Leave product, provider and data names in their original form: Google Maps, Cesium ion, OpenAI, ChatGPT, NASA FIRMS, USGS, OpenSky, ADS-B, AIS, CCTV, HUD, TomTom, OpenStreetMap, Mapillary, and keyboard keys (Space, Esc, H, 1–9).
- Units follow the language's convention; see the language notes.

## Never translated

These are contracts, not copy: layer ids and registry keys, status enums and other machine values (translate only the label shown for them), share-link and hash parameters, `?lang=`, storage schemas, API fields, voice tool names and schemas, provider and dataset names, data from feeds (callsigns, vessel, satellite, station and place names, headlines), attribution, console diagnostics, and user-authored content.

## Language notes

Each language keeps its glossary, plural forms, units and style in its own file, `docs/translations/<code>.md`: [Spanish](./translations/es.md), [Russian](./translations/ru.md), [Simplified Chinese](./translations/zh-CN.md). Read it before translating, and add a term there when you settle on one.
