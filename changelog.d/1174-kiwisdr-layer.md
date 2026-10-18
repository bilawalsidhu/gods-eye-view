- Add a KiwiSDR layer. Every public KiwiSDR receiver appears on the globe,
  coloured by how busy it is with a colorblind-safe palette, and clicking one
  opens an in-app player with live audio and a waterfall (no iframe). The player
  can be minimized to a slim bar while it keeps playing, supports favorites and
  per-receiver saved frequencies, and the waterfall zooms with the wheel, pans by
  dragging and tunes at the resolution of the visible span. Receivers behind
  `*.proxy.kiwisdr.com` connect on `:8073` (falling back to `proxy2`), and a
  failed connection shows the host, port and close code. The layer is local-only
  and needs a page that may open `ws://` connections (ZaraWeggies, #1202).
