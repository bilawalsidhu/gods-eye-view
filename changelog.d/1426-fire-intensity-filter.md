- Color every Active Fires detection by fire radiative power on a six-stop
  cold → hot ramp (blue · teal · lime · amber · orange · red at 0 · 5 · 20 ·
  50 · 100 · 300 MW), and add a log-scale minimum-FRP slider whose track is the
  ramp, an All / Nominal+ / High confidence switch and an "N of M shown"
  counter to the layer row. Far zoom shows a Snap Map–style heatmap instead
  of squares, empty where nothing burns. The filter applies once before
  rendering, so markers, cards, the heatmap, context and the top-fires query agree; share
  links keep it (`w` token: `f`, `c`), and `get_active_fires` takes matching
  `min_frp_mw` and `confidence` arguments. Default 0 MW / All (gekh, #1426).
