# Director data packs

Version-5 scene documents can declare `dataPacks` on a scene and select them by
`dataPackIds` on each shot. Import validates declarations without loading assets.
Loading, seeking or playing a shot acquires only its selected packs. A shot with
no pack IDs clears the preceding shot's packs. Existing scene recipes and assets
keep their current paths, notices and behavior.

A pack manifest is version 1 and requires an ID, format, source, attribution and
placement. Sources describe storage; placement describes geography. Source names
refer to trusted application registrations, never scripts to import. A document
cannot supply request headers, keys, cookies, endpoints or executable handlers.

```json
{
  "version": 5,
  "scenes": [
    {
      "id": "example",
      "title": "My geographic notes",
      "dataPacks": [
        {
          "id": "notes",
          "version": 1,
          "format": "geojson",
          "source": { "adapter": "assets", "path": "my-scene/notes.geojson" },
          "attribution": {
            "text": "Your name",
            "license": "Your asset's actual license"
          },
          "placement": { "altitudeReference": "ellipsoid" }
        }
      ],
      "shots": [
        {
          "id": "overview",
          "camera": {
            "lat": 30.2672,
            "lon": -97.742,
            "alt": 2600,
            "pitch": -70
          },
          "durationSec": 4,
          "holdSec": 2,
          "dataPackIds": ["notes"]
        }
      ]
    }
  ]
}
```

For the standalone application, put that asset at
`public/scene-assets/my-scene/notes.geojson`. The registered `assets` source has
an explicit `/scene-assets/` base on the application's origin. Importing a file
from disk does not grant access to adjacent local files or infer a remote base.
Relative paths cannot contain traversal, query strings, fragments, URL syntax,
percent escapes or empty segments. Asset directories are served as static files;
this is not a new arbitrary-URL proxy.

## Formats and placement

- **`geojson`:** a UTF-8 `FeatureCollection`, served as `application/geo+json` or
  `application/json`. Each feature needs a unique string `id`. Point, LineString
  and Polygon (including holes) are supported. Coordinates are WGS84
  `[longitude, latitude, ellipsoidHeightMeters]`; missing height means zero,
  which can be underground. Supply appropriate heights. Geometry properties
  are ignored: they cannot select external icons, HTML, styling or scripts.
  Placement is `{ "altitudeReference": "ellipsoid" }`.
- **`image`:** PNG served as `image/png`, at most 4096×4096 pixels, checked before
  decoding. Placement is `{ "bounds": [west, south, east, north], "height": 300,
"altitudeReference": "ellipsoid" }`. Bounds must increase and cannot cross
  the dateline. The image is a horizontal geographic rectangle at that height.
- **`media`:** MP4/WebM video or MPEG/Ogg/WAV/WebM audio, with the matching standard
  MIME type. Placement is `{ "anchorId": "media-location" }`, referring to a
  scene-local anchor with explicit ellipsoid height. A labelled marker locates
  the media; an attribution card provides native, user-operated playback
  controls. Media never autoplays. Codec support depends on the browser. D5 does
  not synchronize media time with scene time or embed third-party players.

Pack attribution always includes nonempty `text` and `license`; an optional
HTTPS `url` opens as a source link with no opener/referrer. Importing or sharing
an asset never changes its license. D5 adds no third-party content and preserves
all existing Nepal content and contributor notices.

Optional `byteLength` specifies the exact expected byte count; optional `sha256`
is a lowercase hexadecimal SHA-256 digest checked before rendering. There are at
most 8 packs per scene, 8 MiB per asset, and 32 MiB of selected assets per shot.
GeoJSON additionally allows at most 2,000 features and 50,000 positions.
Transforms, terrain-relative placement, terrain collision avoidance, arbitrary
GeoJSON styles and archive extraction are not implemented. Explicit local files
can be shared through [JSON asset bundles](DIRECTOR-SHARING.md).

## Loading and resource ownership

The `director` package export provides `createAssetDirectorySource` and
`createDataPackSession`. The former receives an explicit trusted HTTP(S)
directory `baseUrl` and optional `fetchImpl`; it confines every relative asset
path to that directory. Cross-origin directories require CORS. Requests omit
credentials and referrers, reject redirects, and use `cache: 'no-store'`.
There is no persistent pack cache, offline fallback or silent substitute. A
missing, invalid, oversized or integrity-mismatched asset fails the shot's pack
load, removes partial results and reports a stable error without exposing a URL.
Successful loading leaves the attribution cards visible with the assets.

`createApplicationTools({ sceneDataPacks: { sources } })` and
`new SceneDirector(viewer, style, data, { dataPacks: { sources } })` accept a
registry of source functions. Each receives `{ path, signal, maxBytes }` and
returns `{ bytes: Uint8Array, mimeType }`. Custom transports must honor the
signal, bound reads and return the real MIME type. They remain application code,
not scene document fields. Without registrations, referenced sources fail closed.

The portable session receives format adapters separately. Each adapter receives
`{ pack, asset, anchors, signal }` and returns a resource with an idempotent
`dispose()`. Core's scene composition supplies Cesium geometry/image rendering
and text-only attribution/native media controls. The session applies a 15-second
load deadline and rejects late results, even when an adapter ignores abort.

Stop, replacement, next-shot selection, scene release and destruction cancel
pending work, remove owned entities/cards, stop media and revoke object URLs.
Run completion releases packs with its run signal. Direct LOAD and seek retain
packs until the next operation or Stop. Resources are reacquired per shot;
there are no disabled pack refresh loops. `getDataPackState()` returns copied
status and resource counts for lifecycle diagnostics.

Run `node scripts/qa-director-packs.mjs` against a credentialed local server to
exercise the real import/load/seek/Stop path with self-authored synthetic assets.
See [actions](DIRECTOR-INTERACTIONS.md) and [authoring/sharing](DIRECTOR-SHARING.md)
for the controls built on this manifest/loading boundary.
