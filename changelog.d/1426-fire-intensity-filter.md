- Color every Active Fires detection by fire radiative power on a six-stop
  ember → white-hot ramp (ember · red · flame · orange · gold · white-hot at
  0 · 5 · 20 · 50 · 100 · 300 MW, brighter as power rises), and add a
  log-scale minimum-FRP slider whose track is the ramp, an All / Nominal+ /
  High confidence switch and an "N of M shown" counter to the layer row. Far
  zoom shows a Snap Map–style heatmap in the same colors instead of squares,
  one distinct spot per fire, empty where nothing burns, and cross-fades with
  the markers around 4,500 km with no gap, keeping weak fires as markers. The filter applies once before
  rendering, so markers, cards, the heatmap, context and the top-fires query
  agree; share links keep it (`w` token: `f`, `c`), and `get_active_fires`
  takes matching `min_frp_mw` and `confidence` arguments. Default 0 MW / All
  (gekh, #1426).
