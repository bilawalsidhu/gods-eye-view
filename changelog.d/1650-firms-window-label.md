- A FIRMS snapshot that ends at a set time (`at`, epoch ms, from a source that
  serves one) is no longer labelled live: the Active Fires row reads
  `NASA FIRMS · 24 h to 10-21 15:00 UTC`, and `get_active_fires` says "in the
  24 hours to" that time and reports it as `window_end` (samehkhamis, #1650).
