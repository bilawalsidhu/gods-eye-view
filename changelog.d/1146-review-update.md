- Add optional CONAE GOES thermal detections to Active Fires with
  `CONAE_GOES_ENABLED=1`. The source works without a NASA key, uses an independent
  bounded cache and preserves FIRMS when CONAE is unavailable (and vice versa).
  GOES observations retain their UTC-3 acquisition times converted to UTC,
  CONAE attribution and unknown confidence; they are not confirmed wildfires.
  (radianx, #1146).
