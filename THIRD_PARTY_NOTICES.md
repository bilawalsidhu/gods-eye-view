# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR feature; the complete
resolved dependency inventory remains in `package-lock.json`.

## WebXR spatial view

- `three` 0.186.0: MIT, copyright three.js authors; license in the npm package.
- `cannon-es` 0.20.0: MIT, copyright cannon.js authors; license in the npm package.
- Local controller and hand models in `public/webxr-profiles/` are copied from
  the supplied WebXR Template's `@webxr-input-profiles/assets` snapshot.
  MIT, copyright 2019 Amazon. Full license: `public/webxr-profiles/LICENSE.md`.
- The interaction modules in `src/xr/vendor/` come from the user-provided
  WebXR Template. Their provenance and synchronization contract are recorded
  in `docs/XR_CONVERSION.md`; the template did not provide a separate license.
- The base map uses the repository's Natural Earth country pack (public domain).
  Its source metadata remains in `src/data/local_data/natural_earth/countries.json`.

## Web RTL-SDR

- Package: `@jtarrio/webrtlsdr` 3.0.6
- Author: Jacobo Tarrio Barreiro; portions copyright Google Inc.
- Source: <https://github.com/jtarrio/webrtlsdr>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## Signals

- Package: `@jtarrio/signals` 0.10.1
- Author: Jacobo Tarrio Barreiro
- Source: <https://github.com/jtarrio/signals>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>
