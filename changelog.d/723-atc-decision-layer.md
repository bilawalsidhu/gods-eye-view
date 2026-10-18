- Add the ATC decision layer behind #715: `flightPhase.js` classifies a tracked aircraft's
  phase from height above the **field** and its vertical rate — and returns `airborne` with the
  missing input named rather than a phase it invented when either is absent; `atcTuning.js`
  turns that phase into a preference order, resolves it against what the airport actually
  publishes, and reports an uncontrolled field as uncontrolled instead of captioning a CTAF as
  a controller; `atcStreamPreference.js` keeps the viewer's own https stream URL in their
  browser and nowhere else; `atcAudio.js` plays it through the shared audio claim, so starting
  ATC stops whatever else was sounding and vice versa. No stream URLs ship with the app
  (daikaginza, #723).
