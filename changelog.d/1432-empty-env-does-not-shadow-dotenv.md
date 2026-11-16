- An empty environment variable no longer shadows the value the same key
  has in the checkout's `.env` file. A deployment that exported
  `CESIUM_ION_TOKEN=""` made the app bake an empty token into the browser
  bundle even though the real secret was mounted on disk; a key cleared on
  purpose in Provider Settings still stays empty (Fuulks, #1432).
