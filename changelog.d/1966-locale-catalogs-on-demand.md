- The page loads only the translation catalog for the language it starts in,
  instead of all thirteen. It loads another language's catalog when you pick
  that language, and switches once the catalog has loaded. If you pick again
  before it arrives, your last choice wins. If a catalog fails to load, the
  page keeps its current language. At startup, the page uses English if its
  language fails to load or takes longer than 4 seconds. The loading screen's
  status line stays hidden until the language applies, so English text no
  longer shows first. `startPageLocale` and `switchLocale` from the `./i18n`
  entry now return promises: await `startPageLocale` before views render, and
  await `switchLocale` before relying on the new language. `switchLocale`
  resolves `'superseded'` when a later choice replaced it, and rejects when
  its catalog fails to load (Sameh Khamis, @samehkhamis, #1966).
