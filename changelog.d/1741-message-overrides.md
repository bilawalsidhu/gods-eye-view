- Let an application that composes Core use its translator and word Core's
  messages its own way. The `./i18n` entry exports `t`, `tn`, `msg`,
  `translateKnown` and the number and date formatters, and
  `setMessageOverrides({ en: {…}, de: {…} })` shows the application's text for
  any catalog key, in the active locale or else in English (samehkhamis,
  #1741).
