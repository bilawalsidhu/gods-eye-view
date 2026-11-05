- Add Weather balloons from SondeHub (CC BY-SA 2.0), off by default in Weather
  with share-link token `9`. The layer row shows per-state counts and connection
  status or launch guidance. One shared MQTT subscription sends live updates
  with bounded client queues and a 3 h memory-only store. Cold starts use
  recent-first REST backfill and show partial data immediately. Cached
  20 px sprites and aircraft distance scaling distinguish flight states, with
  landed/lost contacts retained under the 2,000-contact render cap. The overlay
  host declutters up to 150 visible label candidates. Refreshes reuse billboards,
  skip unchanged signatures and coalesce pushes at 500 ms. Selection shows the
  flight trail, observed burst point and all available grouped metadata.
  Receiver fields are discarded; coverage depends on volunteer receivers
  (lyehe, #1).
