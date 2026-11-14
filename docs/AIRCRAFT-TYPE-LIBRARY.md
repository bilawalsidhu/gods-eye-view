# Aircraft type library

The selected-aircraft card shows what kind of aircraft a contact is. The library behind it maps an ICAO type designator (`B789`) to a name, a model class, a few specs and one licensed photo. It ships with the build, so the card needs no network for this data.

The per-airframe photo from Planespotters (`src/layers/flights/enrichment.js`) is separate. It needs a network and exists only for some airframes. The library covers the type.

## Data

`src/data/aircraftTypes/catalog.json` is an array sorted by `icao`. Each entry has these fields.

- `icao`, `name`, `manufacturer`.
- `role`, one of `civil`, `military` or `both`.
- `class`, one of the ten classes `classifyAircraft` returns. When it differs from `classifyAircraft`, `classOverride` holds the `classifier` and the `reason`.
- `specs`, with `lengthM`, `spanM`, `engines`, `engineType` and `firstFlightYear`. A field with no source is left out, never guessed. `specsSource` names the source of each field.
- `wikidata` and `match`, the Wikidata item and how the designator was matched to it.
- `photo`, or `null`. It holds `path` (`/aircraft-types/<ICAO>.webp`), `width`, `height`, `author`, `licence`, `licenceUrl`, `sourceUrl` (the Commons file page), `cropped` and `reason`.
- `notes`, where the match is ambiguous.

`src/data/aircraftTypes/index.js` exports two functions. `aircraftTypeEntry(typeCode)` returns the entry or `null`, ignoring case and padding. `aircraftTypeClass(typeCode)` returns the entry's class and falls back to `classifyAircraft` for a type the library lacks. Class-level 3D models still come from `CLASS_MODEL_REAL` through this function.

The photos are in `public/aircraft-types/`. [AIRCRAFT-PHOTO-CREDITS.md](AIRCRAFT-PHOTO-CREDITS.md) lists the author, licence and source of each one, and is generated.

## Licence policy

Only CC0, public domain, CC BY x.y and CC BY-SA x.y photos are kept. The builder rejects NonCommercial, NoDerivatives, GFDL on its own, fair use, unknown licences and Commons files marked `NonFree`. CC BY and CC BY-SA entries must name an author. `licenceUrl` is the canonical https deed. Each photo is scaled to at most 640 px wide, encoded as WebP (quality 70) with metadata removed, and not cropped.

`src/data/aircraftTypes/validateCatalog.js` holds these rules. The builder refuses to write a catalog that breaks one, and `aircraftTypes.test.mjs` runs the same rules with a bad case for each.

## Rebuilding

```sh
node scripts/build-aircraft-catalog.mjs [--top 150] [--offline]
node scripts/build-aircraft-catalog.mjs --explain B733,C150
node scripts/build-aircraft-catalog.mjs --snapshot <adsbdb.json>
```

The first command builds `catalog.json`, `public/aircraft-types/*.webp` and `docs/AIRCRAFT-PHOTO-CREDITS.md` for the commonest civil types of `typeFrequency.json` plus every type in `designators.json`. `--explain` prints the ranked photo candidates of a type, for choosing a `photo` pin. `--snapshot` regenerates `typeFrequency.json` from an adsbdb cache (`.gev-cache/adsbdb.json`). It keeps only type counts and the commonest type name.

The sources are ICAO Doc 8643 (designator, engines, engine type), the English Wikipedia list of aircraft type designators (designator to article), Wikidata (item, specs, image, Commons category) and Wikimedia Commons (licence and author).

- Wikidata has no ICAO type designator property. The item comes from `designators.json` first (an item or article chosen by hand), then from the Wikipedia list. The item must be an aircraft. Matching by label was tried and rejected, because it picked the wrong aircraft for TB2, F16 and C172.
- A variant entry is a subclass of the family item whose last label word equals the Doc 8643 model code (`787-9`) and starts with the same letter as the family.
- Specs come from the most specific item that has the field. Engines come from Doc 8643.
- The photo is the variant's Wikidata image, then the family's. Only when neither is usable does the builder list the Commons category and its "in flight" subcategory, ranking names and descriptions that say in flight, landing or take-off. Commons rate-limits anonymous clients hard, so this step runs only when needed.
- A class in `designators.json` wins. Otherwise Doc 8643 corrects `classifyAircraft` only when it returned `airliner`, its default for a code outside every set. Helicopters become `helicopter`, turboprops and turboshafts `turboprop`, piston and electric aircraft `light`, and jets with a business-jet name `bizjet`. The reason goes in `classOverride.reason`.

The builder sends the generic User-Agent `aircraft-catalog-builder/1.0`, waits at least 400 ms between requests and honours `Retry-After`. Every response is cached under `.gev-cache/aircraft-catalog/` (gitignored), so a rerun is offline and writes byte-identical files. `--offline` fails when the cache lacks a response.

To add a type, put its designator in `designators.json` (with an `article` if the Wikipedia list lacks it), rerun the builder, read `notes` and look at the new photo.

## Known limits

- The Wikidata specs are not reviewed by a person. The Boeing 787 family item gives a 52 m wingspan, where the real value is 60.1 m. `specsSource` names the item, so the card can say where a number comes from and a fix can be made on Wikidata.
- Designators the feeds use that are not ICAO-standard (`G650`, `GL6T`, `CL65`) take their Doc 8643 data through `docDesignator` in `designators.json`.
- Two photos show a sibling variant of the family, because the variant item has no image of its own. DH8A shows a Dash 8-400 and E190 shows an E175.
- The photo shows the aircraft type, not the tracked airframe, and the card says so.
