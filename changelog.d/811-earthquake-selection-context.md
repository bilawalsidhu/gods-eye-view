- Explicit USGS earthquake clicks now publish source-backed context to the
  shared selected-entity owner. Selection refreshes do not re-announce clicks,
  switching quake A to B drops the obsolete record, and empty-space deselection
  reports `deliberate` rather than feed `evicted`. Current feed disappearance
  remains `evicted`. Quake discs stay out of pick ownership, so FIRMS and
  vessel cards painted over them remain clickable. Credits: kvnloo (#811),
  the original GEV layer contributors and quanticsoul4772's independent
  Windows review of #811.

Foreground overlay cards take precedence over earthquake discs in either click-listener order. Failed snapshot staging preserves both the displayed events and their selection metadata.
