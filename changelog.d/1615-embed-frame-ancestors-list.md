- `GEV_EMBED_FRAME_ANCESTORS` now accepts comma-separated lists as well as
  space-separated ones. A comma list used to be pasted into the CSP header
  verbatim, which browsers reject as an invalid source, so every embedding page
  was silently refused. Bare `self`/`none` gain their quotes, and anything that
  is not a CSP source (a path, a `;`) is dropped with a startup warning instead
  of being written into the header (#1615).
