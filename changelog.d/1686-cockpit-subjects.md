- Let an application add its own Cockpit subjects through
  `services.cockpitSubjects`. A provider supplies the subject's position,
  heading and HUD (in the page's language, via the new `./i18n/locale`
  export); the camera can follow it without the ground clamp, anchored
  exactly on it, and a generic HUD adds source rows, a banner, a veil (off
  under reduced motion) and a bottom progress line. The Rail and Transit
  layers expose read and hold APIs so a selected train or vehicle can be
  ridden, and `./layers/rail/paths` is exported; `docs/APPLICATION.md` shows
  a minimal provider. GEV itself registers none. Cockpit entry now goes to
  the most recently selected subject, so a vessel selected after an aircraft
  is tracked enters BRIDGE (Denis Groshev, @ZloyS, #1686).
