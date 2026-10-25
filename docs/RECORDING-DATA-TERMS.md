# Recording data: what you may and may not keep

This is a plain-language note, not legal advice. The recorder saves copies of
position data that other people publish. Some of those sources allow that, some
limit it, and the rules can change. You are responsible for checking each
source before you record or share it. Recording is off by default for this
reason.

## What the recorder keeps

| Layer    | Where the data comes from                                  |
| -------- | ---------------------------------------------------------- |
| `air`    | OpenSky Network, or adsb.lol when OpenSky is not answering |
| `mil`    | adsb.lol                                                   |
| `vessel` | AISStream (needs your own key)                             |
| `local`  | Your own ADS-B receivers                                   |
| `sat`    | CelesTrak orbital elements (opt-in)                        |

The recorder cannot tell whether an `air` position came from OpenSky or from
the adsb.lol fallback, so treat `air` as if the stricter OpenSky terms apply.

## Source by source

**OpenSky Network (`air`).** Its terms of use say the REST API is provided for
non-profit research and educational use only. Recording it for personal
research may fit that; using or selling it for commercial purposes does not.
Do not share a recording of it. Read:
https://opensky-network.org/about/terms-of-use

**adsb.lol (`mil`, and `air` fallback).** It publishes its API and data under
the Open Database Licence (ODbL 1.0), described as free to use as long as you
keep it open. In short: you must credit adsb.lol, and if you share a database
built from it, you must share it under the same licence. Read:
https://www.adsb.lol/docs/open-data/api/

**AISStream (`vessel`).** I could not confirm what its terms say about storing
or sharing the data, so assume nothing. Read the terms for your account at
https://aisstream.io before turning on `vessel`, and leave it out of
`layers` until you have.

**CelesTrak (`sat`).** Satellite positions are calculated on your machine from
CelesTrak orbital elements, not copied from a position feed. CelesTrak asks
clients not to fetch more than about every two hours, and the app already
respects that. Check https://celestrak.org before sharing recordings.

**Your own receivers (`local`).** These are your own observations, so the
source's terms do not apply. Local law may still limit what you may receive,
keep or share, and laws about personal data may apply (see below).

## Personal data

A position of a private aircraft or a small vessel can identify one person,
especially when it is kept over days. In some countries that counts as
personal data, with rules about how long you keep it and who sees it. Keep
retention short, keep recordings on a machine only you use, and do not publish
tracks of identifiable private individuals.

## Safe settings

- Leave the recorder off unless you need it.
- Record only the layers you have checked: set `layers` in
  `recorder.config.json`, or `GEV_RECORDER_LAYERS`, for example `["local"]`.
- Keep retention short (`GEV_HISTORY_RETENTION`, for example `7d`) and set a
  size cap (`GEV_HISTORY_MAX_MB`).
- Do not export, upload or publish recordings from a source whose terms forbid
  it. The CSV, GeoJSON, GPX and JSON downloads carry no licence checks.
- Pin (`PIN`) only what you have a reason to keep past the retention period.
- To remove everything, delete `data/history.sqlite` (and the `-wal` and `-shm`
  files next to it), or drop the PostgreSQL tables.

## If a provider objects

Stop recording that layer, delete what you hold from it, and tell whoever you
shared it with. When in doubt, ask the provider.
