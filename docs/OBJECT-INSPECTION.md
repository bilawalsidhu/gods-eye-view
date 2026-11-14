# Object inspection and focus return

Single-click a map object to keep it selected and reveal **OBJECT DETAILS** on
the right rail. The camera stays in place in the normal inspect-on-click mode.
The panel reads the selected layer's current telemetry and public metadata every
half second, updating only when values change. Clicking a different object
replaces the panel contents. It uses the same panel accordion as CCTV; cameras
continue opening their existing live-feed panel.

Aircraft, satellites and vessels retain their selected highlight and live source
state without engaging the follow camera. The inspector includes their available
identifiers, position, telemetry and source fields. S2 reports expose their selected report fields. Static Cesium entities with public properties, such
as earthquake markers, can also be inspected. Missing measurements are left
absent; static report locations retain the source's accuracy and provenance.
Source text is rendered as text, not HTML.

AIS vessels show their full name, speed and type cards only while selected.
Their map icons remain available when unselected.

Double-click the object to focus it. Moving aircraft and satellites use the
owning layer's normal follow-camera action. Other objects use their source's
focus action or a view framed on the object's coordinates. The panel's **FOCUS**
button offers the same operation. Pointer tools retain priority: drawing and
other leased gestures cannot initiate inspection or double-click navigation.

An accepted focus captures the camera's world position, direction and up vector
**before** navigation starts. **Restore last view** then appears in the top
camera action bar and is enabled in the details panel. It cancels camera motion
and follow/orbit ownership, then restores that exact snapshot without a flight.
The button remains available when a different object is inspected or the details
panel is collapsed. Each accepted focus replaces this one return snapshot;
restoring consumes it. A refused focus does not replace an earlier snapshot.


The details panel receives its own pointer events, including clicks on text,
Focus and Restore, so those interactions do not reach the globe or clear the
selected object.

Closing the details panel does not move the camera. Selecting another object
opens it again. The inspector is transient: its selection and return snapshot
are not serialized into share links or saved as provider data.

## Verification

```sh
node --import=./build/registerVue.js --test \
  src/ui/objectInspection.test.mjs src/ui/objectInspectionPanel.test.mjs \
  src/ui/focusReturn.test.mjs
QA_BASE_URL=http://localhost:4173 node scripts/qa-object-inspection.mjs
```

The browser gate uses synthetic vessel records and real mouse events. It checks
single-click inspection, live telemetry refresh, switching objects without camera
movement, real pointer hit-testing of Focus, clicks on panel text, both Focus and
Restore buttons, double-click focus and world-vector return (position within 1 µm and
orientation vectors within 1e-12). Evidence is saved under the ignored
`qa-shots/object-inspection/` directory.
