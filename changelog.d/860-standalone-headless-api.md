- Add a standalone way to run the `/api/*` provider proxies without Vite.
  `server/standalone/headless.mjs` mounts the same provider middleware
  `vite dev`/`vite preview` use onto a plain Node server, so the provider
  API can run unattended — CONTRIBUTING.md already notes `vite preview`
  "is not a production server". It refuses a non-loopback bind unless
  `GEV_HEADLESS_UNSAFE_PUBLIC=1` is set, rejects unexpected `Host` headers
  with the same rule and `GEV_ALLOWED_HOSTS` list as the dev and preview
  servers, and bounds shutdown. `GEV_HEADLESS_PORT=0` asks the OS for a free
  port and the startup line reports the port actually bound.
  `server/apiRoutes.js` lists every `/api` mount as data, with a test pinning
  it against the dev, preview and headless servers (daikaginza, #793), and
  `docs/API_REFERENCE.md` documents a selected subset of those routes in
  detail (atripathy86, #860).
