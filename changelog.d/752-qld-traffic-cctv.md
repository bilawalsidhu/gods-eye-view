- Add Queensland traffic and flood cameras from the QLDtraffic API as a
  bring-your-own-key CCTV pack. With `QLDTRAFFIC_API_KEY` set (Provider
  Settings / Power Up, or `.env`), the server reads `/v1/webcams` and
  `/v1/floodcams` with the key kept server-side, caps each catalog at 4 MiB,
  and registers only HTTPS frame URLs on `cameras.qldtraffic.qld.gov.au`
  without credentials or a port. Council-supplied flood cameras are credited
  to their council. Without a key the pack is off and makes no request;
  `CCTV_QLDTRAFFIC_ENABLED=0` turns it off and `CCTV_QLDTRAFFIC_MAX_SOURCES`
  (default 350) caps it. Keep the key unset on public deployments until TMR
  confirms the camera stills fall under the API's CC BY 4.0 AU licence
  (ozbastion, #752).
