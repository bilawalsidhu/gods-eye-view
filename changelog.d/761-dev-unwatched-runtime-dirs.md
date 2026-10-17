- The dev server no longer watches `.gev-cache` and `.gev-logs`. Providers write
  cache files and logs there while the app runs, and none of it is source, so
  the watcher now skips it; this guards against the DNS-lookup delays heavy
  cache writes have caused, though no difference was measured on current main
  (monwiss, #761).
