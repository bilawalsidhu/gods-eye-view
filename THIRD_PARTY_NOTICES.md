# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR feature, the
Street Level viewer, the Data Library's GeoParquet reader and the GNSS Integrity
layer's hexagon grid; the complete resolved dependency inventory remains in
`package-lock.json`.

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

## MapillaryJS

- Package: `mapillary-js` 4.1.2 (loaded on demand by the Street Level viewer,
  with its stylesheet `dist/mapillary.css`)
- Author: Copyright (c) Facebook, Inc. and its affiliates
- Source: <https://github.com/mapillary/mapillary-js>
- License: MIT
- License text: <https://github.com/mapillary/mapillary-js/blob/main/LICENSE>

## RxJS (MapillaryJS dependency)

- Package: `rxjs` 7.8.2
- Author: Google, Inc., Netflix, Inc., Microsoft Corp. and contributors
- Source: <https://github.com/ReactiveX/rxjs>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## three.js (MapillaryJS dependency)

- Package: `three` 0.134.0
- Author: Copyright © 2010-2021 three.js authors
- Source: <https://github.com/mrdoob/three.js>
- License: MIT
- License text: <https://github.com/mrdoob/three.js/blob/dev/LICENSE>

## hyparquet

- Package: `hyparquet` 1.31.2 (loaded on demand when a Data Library
  GeoParquet entry is switched on)
- Author: Hyperparam
- Source: <https://github.com/hyparam/hyparquet>
- License: MIT

## fzstd (hyparquet ZSTD decompressor)

- Package: `fzstd` 0.1.1
- Author: Copyright (c) 2020 Arjun Barrett
- Source: <https://github.com/101arrowz/fzstd>
- License: MIT

## kdbush

- Package: `kdbush` 4.0.2 (the screen index that groups points drawn too
  close together into clusters)
- Author: Copyright (c) 2018, Vladimir Agafonkin
- Source: <https://github.com/mourner/kdbush>
- License: ISC

## H3 (h3-js)

- Package: `h3-js` 4.4.0 (the GNSS Integrity layer's H3 hexagon cells)
- Author: Copyright 2017-2021 Uber Technologies, Inc. (includes the H3 C
  library 4.4.1, compiled to JavaScript)
- Source: <https://github.com/uber/h3-js>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>
