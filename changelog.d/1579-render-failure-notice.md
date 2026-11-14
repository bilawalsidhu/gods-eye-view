- When the globe stops drawing after a render error or a lost WebGL context,
  an alert dialog says so instead of leaving a frozen or black globe behind
  working controls. Retry restarts drawing (Reload after a lost context), and
  Reset view reopens the app without the view restored from the address bar.
  Cesium's "Rendering has stopped" panel no longer appears in the app
  (German, @gekh, #1579).
