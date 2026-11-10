- The Nominatim disk-cache test checks the cache directory and file modes
  only where POSIX modes exist, so it no longer always fails on Windows
  (quanticsoul4772, #1547).
