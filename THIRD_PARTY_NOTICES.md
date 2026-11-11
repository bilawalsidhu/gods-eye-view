# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR feature and the
Street Level viewer, and the CesiumJS code ported into `src/geo/`; the complete
resolved dependency inventory remains in `package-lock.json`.

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

## CesiumJS (portions ported to src/geo)

- Package: `cesium` 1.138.0 (`@cesium/engine` 22.3.0); the files in `src/geo/`
  are adapted from `@cesium/engine/Source/Core` (`Math.js`, `Ellipsoid.js`,
  `scaleToGeodeticSurface.js`, `Cartographic.js`, `Cartesian2.js`,
  `Cartesian3.js`, `Matrix3.js`, `Matrix4.js`, `Quaternion.js`,
  `Transforms.js`, `BoundingSphere.js`, `EllipsoidGeodesic.js`, `JulianDate.js`,
  `Simon1994PlanetaryPositions.js`) and say so in their first
  line. The changes: the classes' static functions became module functions,
  vectors, geodetic positions and quaternions became plain-data instances of
  module-private constructors (own enumerable fields only, no methods),
  matrices plain arrays, and the ellipsoid a frozen object; the debug
  argument checks were left out, as in Cesium's release build; only the subset
  gev uses was kept.
- Author: Copyright 2011-2024 CesiumJS Contributors
- Source: <https://github.com/CesiumGS/cesium>
- License: Apache License 2.0
- License text: `node_modules/@cesium/engine/LICENSE.md` (shipped with the
  dependency) and <https://www.apache.org/licenses/LICENSE-2.0>
