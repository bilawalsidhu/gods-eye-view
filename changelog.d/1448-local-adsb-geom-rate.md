- Local ADS-B decoder feeds now carry a GNSS-sourced vertical rate
  (`geom_rate`) when no barometric rate is sent, so the card shows V/S
  instead of a dash (Aditya, @Rohilalala, #1448).
- Local ADS-B, military and the adsb.lol flight fallback read the vertical
  rate through one shared readsb field reader, so all three prefer the
  barometric rate and fall back to the GNSS rate the same way (#1448).
