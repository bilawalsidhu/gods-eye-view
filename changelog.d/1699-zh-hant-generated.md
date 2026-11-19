- Generate the Traditional Chinese catalog instead of translating it:
  `npm run i18n -- --zh-hant` writes `zh-Hant` from `zh-CN` with OpenCC `s2tw`
  and its character corrections, and `npm test` fails, naming the key, when
  `zh-Hant` is edited by hand (German, @gekh, #1699).
