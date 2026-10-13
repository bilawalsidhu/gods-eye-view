# Local receivers

The Local ADS-B layer draws aircraft heard by your own receivers. It has two
inputs, and it can use both at once.

| Input        | What it is                                                                                                                          | Bands                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Browser SDR  | A USB RTL-SDR opened by the browser through WebUSB (Radio panel, Local RTL-SDR card). Decoding runs in the page.                   | 1090 MHz             |
| Decoder feed | The `aircraft.json` served by a decoder you run: dump1090-fa, readsb or tar1090 (1090 MHz), or dump978-fa + skyaware978 (978 MHz). | 1090 MHz, 978 MHz UAT |

Aircraft from both inputs are merged by ICAO address. The newest position
wins, and the click card names every band and source that heard the aircraft
in the last 60 s. Aircraft heard only on 978 MHz UAT draw with a thin ring.

Local aircraft usually lead their public twins. The public Flights layer
renders positions about one poll interval (~30 s) behind so it can interpolate
smoothly between fixes, while local receiver aircraft are shown as heard. An
aircraft in both layers therefore draws twice, the magenta local marker ahead
of the public one; both markers are drawn on purpose.

## Which to use

- **One plain RTL-SDR dongle, desktop Chrome or Edge:** use the browser SDR.
  Nothing else to install.
- **A dual-band board, a Raspberry Pi feeder, or a dongle already used by a
  decoder:** use a decoder feed. A USB dongle can be opened by only one program
  at a time, so a dongle that dump1090 or dump978 owns cannot also be opened by
  the browser.

## Configuring feeds

Feeds are set in the server environment only (`.env`), never in the browser:

```sh
LOCAL_RECEIVER_FEEDS=1090=http://localhost:8080/data/aircraft.json,978=http://localhost:8978/data/aircraft.json
```

Each entry is `band=url`, where `band` is `1090` or `978`. The URL must:

- use `http` or `https`;
- point at loopback, a private (RFC1918) address, `localhost` or a `*.local`
  name. Public addresses, link-local addresses (including `169.254.169.254`),
  IPv6 and other host names are refused;
- have a path ending in `aircraft.json`, with no credentials, query or
  fragment.

An entry that breaks a rule is logged when the server starts, shown as
`invalid` and never fetched. Restart the server after changing the value.

The server reads every feed about once a second while the Local ADS-B layer is
on. A feed is `live`, `stale` (its own `now` is more than 10 s old, usually a
stopped decoder), `unreachable` or `invalid`. The Layers panel row and the
Local RTL-SDR card show these states.

## Example: dump1090-fa and dump978-fa on macOS or Linux

Write each decoder's JSON to a directory, then serve the directory on
localhost. Each command keeps running, so start each in its own terminal:

```sh
# 1090 MHz
dump1090-fa --device-index 0 --write-json /tmp/adsb1090
python3 -m http.server 8080 --bind 127.0.0.1 --directory /tmp/adsb1090

# 978 MHz UAT: dump978-fa decodes, skyaware978 writes aircraft.json
dump978-fa --sdr driver=rtlsdr,rtl=1 --raw-port 30978
skyaware978 --connect localhost:30978 --json-dir /tmp/adsb978
python3 -m http.server 8978 --bind 127.0.0.1 --directory /tmp/adsb978
```

```sh
LOCAL_RECEIVER_FEEDS=1090=http://localhost:8080/aircraft.json,978=http://localhost:8978/aircraft.json
```

A board with two identical-serial channels, such as the Nooelec FlyCatcher,
cannot be told apart by serial number. Select each channel by index:
`--device-index <n>` for dump1090-fa and `--sdr driver=rtlsdr,rtl=<n>` for
dump978-fa. `rtl_test` lists the indexes.

A tar1090 or readsb install on a Raspberry Pi already serves
`http://<pi-address>/tar1090/data/aircraft.json`. Use the Pi's private address
or its `.local` name.

## Reception horizon: what your antenna can hear

Turn on **Reception Horizon** (Data Layers → Movement, under Local ADS-B)
while Local ADS-B is on. For each altitude band it draws the farthest position
your receiver has heard in each direction, as a stepped shell around the
antenna: low traffic inside, high traffic reaching farther. A ridge, a
building or a mast shadowing the antenna shows as a shorter or open side.

It is built only from this page session's positions, kept in memory and
never shared, stored or sent. Positions count from page load, even before the
layer is turned on, and only positions confirmed by the same aircraft's
previous fix are used, so a corrupt frame cannot stretch the shell. Coverage
fills in as traffic passes: minutes for the overall shape, hours for a
complete picture.

It needs to know where the antenna is. In order, it uses:

1. a spot you click after **SET ANTENNA** (kept until you press **AUTO** or
   reload);
2. the location in your decoder's `receiver.json`, which dump1090-fa, readsb
   and tar1090 write beside `aircraft.json` when they are given one (for
   example `--lat`/`--lon`, or the location set in PiAware or the readsb
   config). The server reads it from the same address as the configured
   feed, refuses cross-site requests for it, and passes on only the latitude
   and longitude;
3. **LOCATE** in the Local RTL-SDR card (browser location).

**HEIGHT ×10** stretches the drawn heights so the steps read in 3D; ranges
are unchanged. **RESET** starts the session's horizon again.

## Trying it without a radio

`scripts/fake-adsb-feed.mjs` serves a synthetic sky the way dump1090-fa does:

```sh
node scripts/fake-adsb-feed.mjs --speed 20
LOCAL_RECEIVER_FEEDS=1090=http://127.0.0.1:8090/data/aircraft.json npm run dev
```

`--speed 20` plays the sky twenty times faster so the horizon fills in
minutes, `--lat`/`--lon` move the antenna, and `--no-location` leaves the
location out of `receiver.json` to try LOCATE and SET ANTENNA instead.
