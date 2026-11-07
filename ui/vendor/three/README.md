# three.js r186 (0.186.1)

Vendored from the npm package `three@0.186.1` (MIT, see LICENSE) so the app
loads it locally (no CDN; the CSP only allows the app's own scripts):

- `three.module.js`, `three.core.js`: `build/` as published.
- `addons/RoundedBoxGeometry.js`, `addons/BufferGeometryUtils.js`,
  `addons/RoomEnvironment.js`: from
  `examples/jsm/`, their `from 'three'` import made relative
  (`'../three.module.js'`); nothing else changed.

Used by `ui/printer3d/` (the 3D printer view).
