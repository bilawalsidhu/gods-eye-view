# Application UI ownership

The standalone entry composes the UI with the application's layer, terrain,
navigation and rendering operations. `src/ui/applicationShell.js` receives those
instances, constructs and assembles the controls, connects their explicit inputs
and coordinates shutdown. Panel layout scheduling, loading notices, recording
presentation and DOM lookup have focused owners. The ordinary control snapshot
includes the current 3D model toggle and mode. `shellFacade.js` preserves the
methods used by layers, scene playback and voice. It delegates; new behavior
belongs with its owner. There is one application per page.

| Owner | Responsibility |
| --- | --- |
| `navigationController.js` | Navigation generation, tracking release and camera authority |
| `locationNavigation.js` | Destination lookup/selection, orbit, world jumps and globe-reset completion |
| `cockpitCoordinator.js` | Cockpit entry/rollback, readouts and the single Display portal |
| `visualSettings.js` | Effects, detection overrides, visual restoration and render-loop lifetime |
| `panelChrome.js` | Disclosure, docking, layout and Cockpit panel restoration |
| `panelNavigation.js` | Desktop panel rails: each side's offered panels and the open one |
| `aircraftDisplay.js` | Shared commercial/military 3D display preferences and controls |
| `layerBindings.js` | Data-manager attachment, selected-tracker adoption and camera-entry listeners |
| `displayBindings.js` | Keyboard/display subscriptions and frame-rate monitor lifetime |
| `shareRestoration.js` | Initial share/layer restoration and cancellation |
| `shellFeedback.js` | Loading feedback, notices and toast lifetime |
| `SpaceMissionsControls` | Connects the launches layer to the Space Missions panel and store (`src/ui/spaceMissionsControls.js`) |

**Shared control CSS.** Shared styles own ordinary control surfaces and
interaction states; feature CSS owns surrounding layout and context-specific
sizing. `style.css` imports component styles in their original cascade order.
CCTV's calibration editor width lives in `ui/styles/cctv.css`, while the shared
inline field variant owns only density and spinner treatment. Radio supplies its
field palette and disabled opacity through the `--gev-field-*` variables and
keeps compact typography and arrow space locally.

Owners that present UI do so through Vue: they publish plain view objects to a
Pinia store in `src/ui/stores/`, views in `src/ui/views/` render them, and user
actions return through the handlers the owner connects to that store. See
[Building UI](../CONTRIBUTING.md#building-ui).

Feature controls own their surfaces. Scene controls own creation and deletion
prompts, panel listeners, shot rows, playback and recording presentation and
keyboard cancellation. Cockpit presentation is separate from its camera and
controller behavior; the Display portal owns group anchors, focus and scroll
restoration and listeners. Context controls own Contacts state, entry and exit
transactions, layer snapshots and restoration; Clear Selected Layers shares that
owner, so an older restore cannot replay over a newer Clear action. Space
Missions is an ordinary layer outside it. CCTV frame loading, calibration
editing and status display are separate modules. One owner presents the Radio
panel, compact controls and tuner; tuner calculations have a pure entry, beside
the layer's own exports. One component holds the City/POI rows, search and
reset bindings, location readouts and the orbit indicator; a separate lookup
controller cancels superseded searches and checks camera authority before
flight and result presentation. A renderer-free panel component owns layer
rows, feed feedback, counts, focus-preserving chips and toggle listeners. Map
Source controls own chip listeners, source-state subscriptions and selection
feedback. VisualEffects keeps the records of the styles, their crossfades, bloom
and sharpen, and drives them through the renderer's effects port: it defines
each preset there as a style, and the renderer runs the passes and animates the
animated ones; effect execution has no DOM dependency. Display button, selector
and slider listeners have a single destroyable owner.

Owners receive named services, elements, operations and readers. They do not
receive the application shell itself. Readers resolve a replaceable collaborator
at use time; operations cross an ownership boundary without copying its state.
The facade exposes existing properties as delegates rather than duplicate state.
The director gives Scene controls project reads and explicit editing and
playback actions, and keeps persistence, camera and layer sequencing. Cockpit
receives layer, terrain and rendering operations by composition, with the same
tracked identity, ground acquisition, motion correction and cadence. Context
receives the layer manager, installations search and camera and panel actions.
CCTV controls receive the camera port and explicit application actions;
providers, camera placement and navigation policy keep their own owners. Radio
receives playback, layer actions and layout callbacks; station ingestion, marker
placement, audio playback and camera policy keep their own owners. Location
receives explicit navigation actions; search providers and camera handoff policy
keep their own owners. The layer manager supplies the layer panel's current
snapshots, lifecycle actions and row descriptors. Map Source controls leave
loading with the supplied map controller. Display controls receive actions from
the application, which keeps effect settings, restore claims and rendering, and
supply actions to VisualEffects and render its settings. Share restoration
owns its coordinator, deferred notices, gestures and timer; visual settings also
own sensor cleanup.

Shutdown has two phases. First revoke input, deferred navigation, camera-entry
listeners, lookups, timers and rendering work, and settle pending globe resets.
Then await Context restoration,
release sensor overrides while the manager is still attached, detach layer
services and destroy scene resources. Late callbacks cannot acquire the camera.
Manager replacement also releases subscriptions and the previous Directions
module even if the replacement does not provide a Directions layer.
UI disposal revokes queued presentation and listeners before asynchronous
Context restoration, restores the recording HUD, releases status decoration
without replacing accessible text, and releases the CCTV subscription,
command-dock observer, legacy drag resize observer and window resize listener;
these are independent of the Location component and covered by whole-UI
browser teardown acceptance. Scene controls stop immediately. Cockpit input,
subscriptions and queued panel work, Context tab listeners and pending
presentation work, Visual effects animation and Display listeners stop before
asynchronous teardown and layer restoration; layer restoration keeps its
compensation and latest-intent rules, and final Cockpit camera and portal
cleanup follows it. Destruction releases CCTV listeners, subscriptions, image
handlers, summary timers and chip-hide timers; Location listeners, pending
searches and the orbit indicator; and Radio listeners and state subscriptions
before tuning ends. Replacing scene rows revokes their old listeners, replacing
or closing a POI row cancels its pending expansion frame, layer panel remount
and teardown remove listeners and row subscriptions, and Map Source refresh and
destruction revoke old listeners. Final Visual effects destruction removes its
styles and turns bloom and sharpen off, and the renderer restores the scene's
bloom configuration when it goes. Late completions cannot repaint: late scene
file and failed-action completions cannot update removed presentation,
superseded Cockpit portal frames cannot repaint old state or steal focus, a
delayed Radio Enable result cannot reveal or refocus removed controls, obsolete
layer panel completions do not repaint old rows, obsolete Map Source completions
cannot overwrite a newer selection, and destruction suppresses late Map Source
UI updates. Retained Cockpit actions cannot restart a disposed controller.

Source-contract tests follow both sides of delegated wiring. Lifecycle tests
exercise pending reset cancellation, stale camera callbacks, replacement and
idempotent teardown. Browser acceptance covers the composed application, including
share restoration, scene commands, navigation, Cockpit, display and voice.
