- The Pinokio launcher opens God's Eye View in the system browser. Pinokio
  shows an app inside an iframe, and since 0.2.1 every non-embed document sends
  `X-Frame-Options: DENY` and `frame-ancestors 'none'`, so the Pinokio tab
  showed a blocked frame instead of the app. The menu item now uses Pinokio's
  `popout` option; the framing policy is unchanged (NukeThemAII, #1222).
