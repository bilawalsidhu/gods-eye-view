# Share-link format

A share link restores a view: where the camera is, what it follows, the visual
style, data layers and panel layout. There are two forms.

- **Long form** — `#v=2&lat=30.2672&lon=-97.7431&…`. Parsed by
  `src/sharelink.js`. The address bar follows the live view in this form, and
  links already in the wild keep working; the long form is never removed.
- **Short form** — `<app>/share/<code>`, where `<app>` is wherever the app is
  served (an origin's root, or a base path) and `<code>` is encoded and
  decoded by `src/share/viewCodec.js`, which is pure (no DOM, no Cesium) and
  needs no server. Hosts import it as `@gods-eye-view/core/share/view-codec`
  (a server can read a code to describe the view in a link preview). The share button makes this form. The same code opens on
  any copy of the app. `src/share/shareLinkPath.js` reads and builds the
  address, and `src/share/legacyShareState.js` converts between the long
  form's parsed state and the code's state.

The same view in both forms (a real session's link):

| Form  | Characters        |
| ----- | ----------------- |
| Long  | 302 (the hash)    |
| Short | 39 (the `<code>`) |

For example, a camera-only place view is a 24-character code (31 with its
created-at time).
Following an aircraft is 42–50: 42 when the link is made from the app's own
follow camera with the fix taken as the link is made, 44 with a fix four
seconds older, and 50 after orbiting to another heading and pitch. A view in
any other style that keeps the style's own look adds only the style (two
bytes): the 42-character followed aircraft in Noir is 44.

## Opening a short link

At start-up the app reads `<code>` from an address whose path ends in
`share/<code>` (a host can pass the code instead, as `initialShareCode` to
`createApplicationControls`). A code that decodes runs the same restore as a
long link; once the app next writes the address, `/share/<code>` is replaced
by the app's own address and the long form, without a new history entry, so
a reload follows the live view. A code that is rejected restores nothing: the
app starts as usual and says the link can't be opened.

A thing view turns on its entity's layer and follows the entity by id, using
the same restore as a long link's followed flight or satellite (and its
expiry windows); a vessel is selected once the vessel feed has it. Opening is
best effort: until the entity is found, and if it is not found in time, the
camera is where the link was made, looking at the entity's last-known fix,
and the app says that the entity isn't reporting and when the fix was taken.
The share button makes a thing view while the camera follows an aircraft,
military aircraft or satellite. A selected vessel is not followed (the camera
stays where the user puts it), so a link made then is a place view; vessel
thing views open, but the app does not make them yet.

## Payload

The code is unpadded base64url (`A–Z a–z 0–9 - _`). The decoded bytes are:

1. one **version byte**, currently `1`;
2. a sequence of **fields**, each a varint tag `field_number << 3 | wire_type`
   followed by its value;
3. one **check byte**: the CRC-8 of everything before it.

| Wire type | Value                                                       |
| --------- | ----------------------------------------------------------- |
| 0 varint  | unsigned LEB128, at most 8 bytes, at most 2^53 − 1          |
| 1 fixed64 | 8 bytes (not used by v1; skipped)                           |
| 2 LEN     | varint length, then that many bytes (text or a sub-message) |
| 5 fixed32 | 4 bytes (not used by v1; skipped)                           |

Signed values are zigzag varints (0, −1, 1, −2 → 0, 1, 2, 3). Text is printable
ASCII. Fields are written in ascending order; the decoder accepts any order.

A field whose value equals its default is **omitted**. The decoder fills every
omitted field from the same defaults table the encoder reads (for a
style-dependent field, the decoded style's defaults), so an empty
payload (code `AQc`: the version byte and its check byte) is the all-default
view.

### Check byte

The check byte is CRC-8 with polynomial x⁸ + x² + x + 1 (`0x07`), initial
value 0, no reflection and no final XOR (CRC-8/SMBUS; the check value of the
ASCII digits `123456789` is `0xF4`). A decoder that computes a different value
rejects the code (`checksum`) before reading any field, so a mistyped code
never opens a different view. A degree-8 CRC catches every error burst of up
to 8 bits; one base64url character is 6 bits, so **every single-character
typo is rejected** (a test tries every substitution at every position). Two
swapped neighbours, a dropped or an extra character are caught with a
probability of about 255 in 256 (many of them already fail as base64url).

## Field registry (top level)

| #   | State key                    | Type  | Default     | Encoding                                                          |
| --- | ---------------------------- | ----- | ----------- | ----------------------------------------------------------------- |
| 1   | `view.kind`                  | enum  | see below   | 0 place, 1 thing                                                  |
| 2   | `lat`                        | coord | 0           | zigzag of degrees × 10⁴                                           |
| 3   | `lon`                        | coord | 0           | zigzag of degrees × 10⁴                                           |
| 4   | `alt`                        | sint  | 800         | whole metres                                                      |
| 5   | `heading`                    | angle | 0           | whole degrees, see angles                                         |
| 6   | `pitch`                      | sint  | −35         | whole degrees                                                     |
| 7   | `roll`                       | angle | 0           | whole degrees                                                     |
| 8   | `sharedAtMs`                 | epoch | none        | zigzag seconds since 2026-01-01T00:00:00Z                         |
| 9   | booleans                     | flags | 0           | bit set when the value differs from default                       |
| 10  | `layerState.enabledLayerIds` | LEN   | none        | layer bitset, see layers                                          |
| 11  | `layerState.options`         | LEN   | none        | packed option triples, see layers                                 |
| 12  | `panelState`                 | LEN   | none        | packed panel entries, see panels                                  |
| 13  | thing                        | LEN   | none        | sub-message, see thing views                                      |
| 14  | `style`                      | enum  | `normal`    | normal, retro, surveillance, thermal, anime, noir, snow (retired) |
| 15  | `mapStack`                   | enum  | `photoreal` | photoreal, bing-aerial, bing-labels, esri-imagery, osm            |
| 16  | `hudVariant`                 | enum  | style       | tactical, operator (retired), minimal, cyber                      |
| 17  | `bloomIntensity`             | uint  | style       |                                                                   |
| 18  | `bloomVersion`               | uint  | 2           |                                                                   |
| 19  | `sharpenIntensity`           | uint  | style       |                                                                   |
| 20  | `detectionMode`              | enum  | style       | OFF, SPARSE, BALANCED, DENSE                                      |
| 21  | `detectionDensity`           | uint  | style       | one of 0, 25, 50, 75, 100                                         |
| 22  | `detectionAllocation`        | enum  | style       | ELASTIC, WEIGHTED                                                 |
| 23  | `detectionFadePct`           | uint  | style       | 0–40                                                              |
| 24  | `detectionOutsideOpacityPct` | uint  | style       | 0–100                                                             |
| 25  | `scopeFeatherPct`            | uint  | 100         | 0–200                                                             |
| 26  | `scopeTerminusPct`           | uint  | none        | 94–100; absent is the adaptive terminus                           |
| 27  | `styleParams`                | LEN   | style       | packed `(token, value × 100)` pairs                               |

Field 1 absent means `thing` when field 13 is present and `place` otherwise,
so v1 never writes it; a later view kind writes its code.

Enum codes are the list position (0, 1, 2…). A name not in the list is written
as LEN text in the same field, so the app can add a style or map before this
table learns its code. A new style's settings are encoded against its own
defaults, while a decoder that does not know the style uses Normal's; adding a
style also extends the pinned style-defaults table.

`hudVariant` code 1 (`operator`) is retired: the app no longer offers that
layout and restores it as `tactical`. The code stays reserved.

Flag bits (field 9): 0 `bloom`, 1 `sharpen`, 2 `hudVisible`, 3
`celestialRing` (each defaulting by style), 4 `scopeEnabled` (default on).

### Style defaults

A default marked **style** is what the view's style applies when it is
selected in a fresh session (`SHARE_VIEW_STYLE_DEFAULTS`): the app's
first-load baseline (`GLOBAL_POST_DEFAULTS` in `src/ui/visualPresets.js`),
with the style's preset on top (`STYLE_PRESET_DEFAULTS`), and the style's
shader parameters at the preset's values, else the shader's own. The encoder
compares against the defaults of the view's style, and the decoder fills
omitted settings from the defaults of the style it decoded (an unknown style
uses Normal's). So a view that keeps its style's look costs its camera and
style alone. (A recipient-side preference the app remembers, such as the
detection allocation, is not a style default: a sender who changed it pays
for it.) In v1:

| Setting                   | Every style   |
| ------------------------- | ------------- |
| bloom, intensity          | off, 0        |
| sharpen, intensity        | on, 49        |
| HUD visible, variant      | on, tactical  |
| detection mode, density   | DENSE, 75     |
| allocation, fade, outside | ELASTIC, 7, 1 |
| celestial ring            | off           |

| Style        | Shader parameters (field 27 defaults)                           |
| ------------ | --------------------------------------------------------------- |
| normal       | none                                                            |
| retro        | pixelation 1, distortion 0, instability 0.42                    |
| surveillance | gain 0.18, bloom 0.22, scanlineStr 0.96, pixelation 1           |
| thermal      | sensitivity 0.85, bloom 0.2, mode 0.33, pixelation 1, palette 0 |
| anime        | saturation 1, edgeThick 0.5                                     |
| noir         | contrastAmt 1.2, grainAmt 0.5, vignetteAmt 0.5                  |
| snow         | retired: decodes as normal; its parameters are dropped          |

These are frozen like every other default: the codec reads them from the
app's tables today, and a test pins them, so if a table moves the old values
are frozen in the codec rather than changing what shared links mean.

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
A thing view's entity layer is always on, so its bit is not written: in a
thing view, present-but-empty means "only the entity's layer", and an absent
field opens with only the entity's layer on (the app writes the field
whenever it has a layer set).

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

Pairs of varints `(token index, value × 100)` for the parameters of the
view's style that differ from its defaults, using the long form's `sp` tokens
(`SHARE_VIEW_STYLE_PARAMS`). The decoded state always lists every parameter
of the style: the stored ones over the style's defaults. A long link without
`sp` converts to the style's defaults.

## View kinds

A **place** view (field 13 absent) opens at its camera, fields 2–7.

A **thing** view (field 13 present) follows an entity. Field 13 is a
sub-message:

| #   | Field       | Encoding                                                 | Default |
| --- | ----------- | -------------------------------------------------------- | ------- |
| 1   | aircraft    | entity id: varint (24-bit ICAO address) or LEN text      |         |
| 2   | military    | entity id: varint (24-bit ICAO address) or LEN text      |         |
| 3   | vessel      | entity id: varint (MMSI) or LEN text                     |         |
| 4   | satellite   | entity id: varint (NORAD catalog number) or LEN text     |         |
| 5   | range       | uint metres from the entity to the camera                | 2000    |
| 6   | heading     | angle, the camera's heading while following              | 0       |
| 7   | pitch       | sint whole degrees, the camera's pitch while following   | −35     |
| 8   | fix lat     | coord, the entity's last-known latitude                  | none    |
| 9   | fix lon     | coord, its last-known longitude                          | none    |
| 10  | fix alt     | sint metres                                              | 0       |
| 11  | fix age     | sint seconds the fix predates the created-at time        | 0       |
| 12  | observed-at | epoch, when the fix was taken; only without a created-at | none    |

The entity kind is the field that carries the id (its code in
`SHARE_VIEW_ENTITY_KINDS`), so it costs nothing; exactly one of fields 1–4 is
present (two is malformed). Entity ids are the ones the layers look up: an
aircraft's ICAO 24-bit address (six hex digits, stored as a number; other
forms such as TIS-B `~abc123` as text), a vessel's MMSI and a satellite's
NORAD catalog number (decimal numbers; an MMSI with a leading zero stays
text). Ids are lowercase and match `[0-9a-z~_-]{1,16}`.

Fields 5–7 are the follow offset: the camera looks along (heading, pitch) at
the entity from `range` metres away, heading clockwise from north, in the
entity's local east-north-up frame. The defaults match the app's own follow
camera, which looks north at about −35°, so only its range is written.

Fields 8–12 are the last-known fix, the entity's position when the link was
made. Fields 8 and 9 are both written whenever there is a fix; their presence
marks it. Its time is the created-at time (field 8 at the top level) minus
field 11, or field 12 when the view has no created-at time.

**The camera of a thing view with a fix is derived, not stored**: fields 2–7
are not written, and the camera is where following the fix from the offset
puts it (`followCameraFor` in `src/share/follow.js`): the camera sits
`−r·cos p·sin h`, `−r·cos p·cos h` and `−r·sin p` metres east, north and up
of the fix (heading h, pitch p, range r), on a sphere of radius 6 371 000 m,
and looks back at the fix (its heading and pitch are those of that direction
at the camera, roll 0; at follow distances they equal h and p). A
decoder ignores fields 2–7 when the fix is present. A thing view without a
fix (one converted from a long link, which records neither offset nor fix)
writes its camera in fields 2–7 like a place view.

A decoder that meets a view kind or an entity kind it does not know (an id in
a thing field it skips) opens the view as a place at its camera — the derived
one when there is a fix — and reports `fallback`.

## Decoding rules

`decodeShareView(code)` takes the bare code and never throws. It returns
`{ ok: true, state, unknownFields?, fallback? }` or `{ ok: false, reason }`.

Rejected (the whole link): input over 2048 characters, bad base64url
(padding, foreign characters, impossible length, stray bits), fewer than two
bytes, a check byte that does not match (`checksum`), an unknown version byte,
a truncated value, a varint over 8 bytes or above 2⁵³ − 1, an
overlong varint, a LEN longer than what remains (at any level, including
inside the thing sub-message), a reserved wire type, field number 0, a known
field with the wrong wire type or repeated, two entity ids in one thing, a
duplicate panel/option/style entry, non-ASCII text, and a latitude or
longitude (camera or fix) beyond ±90/±180.

Tolerated and reported in `unknownFields`: unknown fields at any level
(skipped by wire type), unknown enum codes and names (the default is used),
unknown flag bits, layers, panel values and style parameters, and layer
options the layer-state codec rejects or that are filed under a layer other
than their owner. Detection mode and allocation names outside their lists
fall back to the default rather than reaching the long form's lenient
migration. The map stack and HUD variant are open: a name outside their lists
that matches `[A-Za-z0-9_-]{1,32}` is kept as written (the app decides what
it means) and is not reported; only a name outside that grammar is. A
created-at time in the future is dropped, as the long form's `at` is.

## Changing the format

These rules keep every link that was ever shared working, in every version of
the app that can open it.

1. **Field numbers are permanent.** Never renumber, never reuse. A field that
   is no longer written stays in `SHARE_VIEW_FIELDS` marked `retired: true`.
2. **A field's type and wire type are permanent.** To change one, add a new
   field.
3. **Defaults are frozen meanings.** A default is what an omitted field meant
   when links were written. If the app's default moves, leave the table alone:
   the encoder will start writing the new value explicitly. Style defaults
   are read from the app's style tables; when those move, freeze the old
   values in the codec (see Style defaults). The same applies
   to `SHARE_VIEW_LAYER_OPTION_ABSENT` and the panel defaults.
4. **Codes are append-only.** Enum lists, entity kinds, flag bits, panel
   numbers and style parameter tokens only grow. A style the app no longer
   offers keeps its code: `snow` (6) is retired, so a link that names it
   opens as Normal and the parameters written for it are dropped.
5. **Add, don't change.** A new setting takes the next free field number
   (28 onwards; fields 1–15 have one-byte tags and are all taken). A new
   boolean takes the next flag bit instead, which costs nothing when it is at
   its default.
6. **New view kinds and entity kinds** get the next code. A new entity kind's
   id takes the next free thing field (13 onwards), so older apps skip it and
   fall back to the camera. A thing that needs more than an id (for example a
   CCTV camera, a radio station or a transit vehicle) adds further thing
   fields the same way.
7. **A new layer option** needs an entry in `SHARE_VIEW_LAYER_OPTION_ABSENT`
   (a test fails until it has one).
8. **Bump the version byte only** for a change older decoders must refuse.
   Decoders reject any version they do not know. The trailing CRC-8 check
   byte belongs to every version.
9. **Derivations are frozen too.** `followCameraFor` and the follow-offset
   defaults are part of the format: changing them moves the camera of every
   thing link already shared.

Add a test for every change: a round trip, and a payload written with the new
field that the previous decoder still reads.
