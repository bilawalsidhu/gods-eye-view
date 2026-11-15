- Let an application add its own Cockpit subjects through
  `services.cockpitSubjects`. A provider supplies the subject's position,
  heading and HUD (in the page's language, via `getLocale` and
  `onLocaleChange` from `./i18n`); the camera can follow it without the
  ground clamp, anchored exactly on it, and a generic HUD adds source rows, a
  banner, a veil (off under reduced motion) and a bottom progress line. The
  Rail and Transit layers expose read and hold APIs so a selected train or
  vehicle can be ridden, and `./layers/rail/paths` is exported; that export
  and the read APIs are experimental. `docs/APPLICATION.md` shows a minimal
  provider. GEV itself registers none, and entry to the built-in aircraft,
  satellite and vessel views is unchanged; a provider's subject takes entry
  when it was selected after them (Denis Groshev, @ZloyS, #1686).
