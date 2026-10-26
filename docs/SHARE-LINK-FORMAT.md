# Share-link format

A share link restores a view: where the camera is, what it follows, the visual
style, data layers and panel layout. There are two forms.

- **Long form** — `#v=2&lat=30.2672&lon=-97.7431&…`. Parsed by
  `src/sharelink.js`. Links already in the wild keep working; the long form is
  never removed.
- **Compact form** — `#s=<base64url>`. Encoded and decoded by
  `src/share/viewCodec.js`, which is pure (no DOM, no Cesium) and needs no
  server. `src/share/legacyShareState.js` converts between the long form's
  parsed state and the compact form's state.

The same view in both forms (a real session's link):

| Form    | Characters |
| ------- | ---------- |
| Long    | 302        |
| Compact | 50         |

A camera-only place view is 25 characters (32 with its created-at time), and
following an aircraft with offset and last-known fix is 76.

## Payload

The hash is `s=` followed by unpadded base64url (`A–Z a–z 0–9 - _`). The
decoded bytes are:

1. one **version byte**, currently `1`;
2. a sequence of **fields**, each a varint tag `field_number << 3 | wire_type`
   followed by its value.

| Wire type | Value                                                       |
| --------- | ----------------------------------------------------------- |
| 0 varint  | unsigned LEB128, at most 8 bytes, at most 2^53 − 1          |
| 1 fixed64 | 8 bytes (not used by v1; skipped)                           |
| 2 LEN     | varint length, then that many bytes (text or a sub-message) |
| 5 fixed32 | 4 bytes (not used by v1; skipped)                           |

Signed values are zigzag varints (0, −1, 1, −2 → 0, 1, 2, 3). Text is printable
ASCII. Fields are written in ascending order; the decoder accepts any order.

A field whose value equals its default is **omitted**. The decoder fills every
omitted field from the same defaults table the encoder reads, so an empty
payload (`s=AQ`) is the all-default view.

## Field registry (top level)

| #   | State key                    | Type  | Default     | Encoding                                                |
| --- | ---------------------------- | ----- | ----------- | ------------------------------------------------------- |
| 1   | `view.kind`                  | enum  | `place`     | 0 place, 1 thing                                        |
| 2   | `lat`                        | coord | 0           | zigzag of degrees × 10⁴                                 |
| 3   | `lon`                        | coord | 0           | zigzag of degrees × 10⁴                                 |
| 4   | `alt`                        | sint  | 800         | whole metres                                            |
| 5   | `heading`                    | angle | 0           | whole degrees, see angles                               |
| 6   | `pitch`                      | sint  | −35         | whole degrees                                           |
| 7   | `roll`                       | angle | 0           | whole degrees                                           |
| 8   | `sharedAtMs`                 | epoch | none        | zigzag seconds since 2026-01-01T00:00:00Z               |
| 9   | booleans                     | flags | 0           | bit set when the value differs from default             |
| 10  | `layerState.enabledLayerIds` | LEN   | none        | layer bitset, see layers                                |
| 11  | `layerState.options`         | LEN   | none        | packed option triples, see layers                       |
| 12  | `panelState`                 | LEN   | none        | packed panel entries, see panels                        |
| 13  | thing                        | LEN   | none        | sub-message, see thing views                            |
| 14  | `style`                      | enum  | `normal`    | normal, retro, surveillance, thermal, anime, noir, snow |
| 15  | `mapStack`                   | enum  | `photoreal` | photoreal, bing-aerial, bing-labels, esri-imagery, osm  |
| 16  | `hudVariant`                 | enum  | `tactical`  | tactical, operator, minimal, cyber                      |
| 17  | `bloomIntensity`             | uint  | 0           |                                                         |
| 18  | `bloomVersion`               | uint  | 2           |                                                         |
| 19  | `sharpenIntensity`           | uint  | 49          |                                                         |
| 20  | `detectionMode`              | enum  | `OFF`       | OFF, SPARSE, BALANCED, DENSE                            |
| 21  | `detectionDensity`           | uint  | 50          | one of 0, 25, 50, 75, 100                               |
| 22  | `detectionAllocation`        | enum  | `ELASTIC`   | ELASTIC, WEIGHTED                                       |
| 23  | `detectionFadePct`           | uint  | 7           | 0–40                                                    |
| 24  | `detectionOutsideOpacityPct` | uint  | 1           | 0–100                                                   |
| 25  | `scopeFeatherPct`            | uint  | 100         | 0–200                                                   |
| 26  | `scopeTerminusPct`           | uint  | none        | 94–100; absent is the adaptive terminus                 |
| 27  | `styleParams`                | LEN   | none        | packed `(token, value × 100)` pairs                     |

Enum codes are the list position (0, 1, 2…). A name not in the list is written
as LEN text in the same field, so the app can add a style or map before this
table learns its code.

Flag bits (field 9): 0 `bloom` (default off), 1 `sharpen` (off), 2
`hudVisible` (off), 3 `celestialRing` (off), 4 `scopeEnabled` (on).

### Precision

| Value                       | Stored as                 | Matches the long form |
| --------------------------- | ------------------------- | --------------------- |
| Latitude, longitude         | 10⁻⁴ degree (about 11 m)  | `toFixed(4)`          |
| Altitude, range             | whole metres              | `Math.round`          |
| Heading, pitch, roll        | whole degrees             | `Math.round`          |
| Intensities and percentages | integers                  | `Math.round`          |
| Style parameters            | hundredths after clamping | `sp` (× 100)          |
| Created-at and observed-at  | whole seconds             | `at`                  |

Angles: heading and roll are normalized into [0, 360) — the long form can
write `roll=360` for a camera at 359.6°, which the compact form stores as 0 —
and written as the nearer signed turn, so 350° costs one byte (−10).
When a state is encoded, out-of-range input is clamped (latitude, pitch) or
wrapped (longitude). A payload that stores a latitude or longitude beyond
±90/±180 cannot come from the encoder and is rejected.

### Layers (fields 10 and 11)

A layer's number is derived from its permanent layer-state token
(`src/data/layerStateTokenReservations.json`): a one-character token is its
index in `0–9a–z`, a two-character token is 36 + first × 36 + second. The
token ledger never reassigns a token, so layer numbers never change and new
layers need no change here.

Field 10 is a bitset: bit _n_ of byte ⌊n/8⌋ (least significant first) is set
when layer _n_ is on. Present-but-empty means "every layer off"; an absent
field leaves the recipient's layers alone (the long form's `l=` versus no `l`).

Field 11 repeats `(layer number, option key, value)` for each option that
differs from its frozen absent meaning (`SHARE_VIEW_LAYER_OPTION_ABSENT`). The
option key is `option token index × 2 + kind`: kind 0 means the value is a
zigzag varint (an option whose long-form spelling is a canonical integer),
kind 1 means a varint length and ASCII text (the long-form spelling). Values
are decoded by the layer-state codec's own option decoders.

A followed aircraft, military aircraft or satellite is a thing view in the
compact form, not a tracking option: the encoder moves it out of the layer
options, and the converter moves it back for the long form.

### Panels (field 12)

Each entry is one varint: `panel number × 16 + collapsed × 4 + pinned`, where
collapsed and pinned are 0 (no value), 1 (false) or 2 (true). Only panels that
differ from the frozen default layout are written, plus a collapsed-0 entry
for each panel the state has no opinion about (an older long-form link that
predates the panel); a panel with no entry takes its default. Values of 3 are
reserved: a decoder ignores that entry, as for collapsed 0.

| #   | Panel                  | Long-form token | Default             |
| --- | ---------------------- | --------------- | ------------------- |
| 0   | `control-panel`        | `c`             | collapsed, unpinned |
| 1   | `location-bar`         | `l`             | collapsed, unpinned |
| 2   | `data-panel`           | `d`             | collapsed           |
| 3   | `cctv-panel`           | `v`             | collapsed           |
| 4   | `recent-imagery-panel` | `i`             | expanded            |
| 5   | `street-level-panel`   | `t`             | collapsed           |
| 6   | `radio-panel`          | `r`             | collapsed           |
| 7   | `scene-panel`          | `s`             | collapsed           |
| 8   | `global-context-panel` | `g`             | collapsed           |
| 9   | `pp-toggles`           | `p`             | collapsed           |
| 10  | `param-slider-panel`   | `m`             | expanded            |

### Style parameters (field 27)

Pairs of varints `(token index, value × 100)` for the active style, using the
long form's `sp` tokens (`SHARE_VIEW_STYLE_PARAMS`).

## View kinds

Every view carries a camera (fields 2–7). It is where a place view opens and
where any other view falls back to.

A **thing** view (field 1 = 1) also carries field 13, a sub-message:

| #   | Field       | Encoding                                                    |
| --- | ----------- | ----------------------------------------------------------- |
| 1   | entity kind | 1 aircraft, 2 military aircraft, 3 vessel, 4 satellite      |
| 2   | entity id   | varint in the kind's numeric form, or LEN text              |
| 3   | offset      | sub-message: 1 range (m), 2 heading (angle), 3 pitch (sint) |
| 4   | last known  | sub-message: 1 lat, 2 lon, 3 alt, 4 age, 5 observed-at      |

Entity ids are the ones the layers look up: an aircraft's ICAO 24-bit address
(six hex digits, stored as a number; other forms such as TIS-B `~abc123` as
text), a vessel's MMSI and a satellite's NORAD catalog number (decimal numbers;
an MMSI with a leading zero stays text). Ids are lowercase and match
`[0-9a-z~_-]{1,16}`.

The offset's absent range is 0, and an absent heading or pitch equals the
camera's. The last-known fix is the entity's position when the link was made:
lat and lon are stored as the difference from the camera's (in 10⁻⁴ degree),
altitude in metres, and the time either as seconds before the created-at time
(field 4) or, when the view has none, as an epoch time (field 5).

A decoder that meets a view kind or entity kind it does not know opens the
view as a place at its camera and reports `fallback`.

## Decoding rules

`decodeShareView(hash)` never throws. It returns
`{ ok: true, state, unknownFields?, fallback? }` or `{ ok: false, reason }`.

Rejected (the whole link): input over 2048 characters, bad base64url
(padding, foreign characters, impossible length, stray bits), an unknown
version byte, a truncated value, a varint over 8 bytes or above 2⁵³ − 1, an
overlong varint, a LEN longer than what remains (at any level, including
inside a thing sub-message on a place view), a reserved wire type, field
number 0, a known field with the wrong wire type or repeated, a duplicate
panel/option/style entry, non-ASCII text, and a latitude or longitude beyond
±90/±180.

Tolerated and reported in `unknownFields`: unknown fields at any level
(skipped by wire type), unknown enum codes and names (the default is used),
unknown flag bits, layers, panel values and style parameters, and layer
options the layer-state codec rejects or that are filed under a layer other
than their owner. Detection mode and allocation names outside their lists
fall back to the default rather than reaching the long form's lenient
migration. A created-at time in the future is dropped, as the long form's `at`
is.

## Changing the format

These rules keep every link that was ever shared working, in every version of
the app that can open it.

1. **Field numbers are permanent.** Never renumber, never reuse. A field that
   is no longer written stays in `SHARE_VIEW_FIELDS` marked `retired: true`.
2. **A field's type and wire type are permanent.** To change one, add a new
   field.
3. **Defaults are frozen meanings.** A default is what an omitted field meant
   when links were written. If the app's default moves, leave the table alone:
   the encoder will start writing the new value explicitly. The same applies
   to `SHARE_VIEW_LAYER_OPTION_ABSENT` and the panel defaults.
4. **Codes are append-only.** Enum lists, entity kinds, flag bits, panel
   numbers and style parameter tokens only grow.
5. **Add, don't change.** A new setting takes the next free field number
   (28 onwards; fields 1–15 have one-byte tags and are all taken). A new
   boolean takes the next flag bit instead, which costs nothing when it is at
   its default.
6. **New view kinds and entity kinds** get the next code. A thing that needs
   more than a kind and an id (for example a CCTV camera, a radio station or a
   transit vehicle) adds fields to the thing sub-message; older apps skip
   them and fall back to the camera.
7. **A new layer option** needs an entry in `SHARE_VIEW_LAYER_OPTION_ABSENT`
   (a test fails until it has one).
8. **Bump the version byte only** for a change older decoders must refuse.
   Decoders reject any version they do not know.

Add a test for every change: a round trip, and a payload written with the new
field that the previous decoder still reads.
