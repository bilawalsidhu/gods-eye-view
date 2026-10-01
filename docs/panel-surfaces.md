# Panel surface contract

`src/ui/styles/panel-surfaces.css` supplies an opt-in visual surface for new
panels. It uses the application's default color, font, border and radius tokens;
Cyber supplies its existing red/slate palette, monospace typography and shaped
frame. This is CSS shared by the existing panel system, not a panel registry or
a controller. A panel ID does not need a new theme selector.

## Markup

A rail panel uses an outer owner with its existing stable `id`, matching
`data-panel-id`, and `panel-collapsible` class. Its first non-glow child is the
surface. Keep the header and any outward popup outside the scrolling body:

```html
<section
  id="example-panel"
  data-panel-id="example-panel"
  class="panel-collapsible"
>
  <div data-panel-surface>
    <header data-panel-header>
      <h2 class="panel-title panel-surface-title">Example</h2>
      <button
        class="panel-collapse-btn panel-surface-control"
        data-collapse-target="example-panel"
        aria-expanded="true"
        aria-label="Collapse Example"
      >
        −
      </button>
    </header>
    <div data-panel-body data-rail-scroller>
      <label>Filter <input class="panel-surface-control" type="text" /></label>
      <button class="panel-surface-control" type="button">Apply</button>
      <p class="panel-surface-error" role="status" hidden></p>
    </div>
    <aside data-panel-popup hidden aria-label="Example help">
      <!-- The panel owns this popup's placement and interactions. -->
    </aside>
  </div>
</section>
```

Use native controls and accessible names. `.panel-surface-control` is an
optional skin for buttons, text fields, selects and textareas; it provides
hover, focus, disabled and invalid-state styling. Native `disabled` owns actual
disablement; `aria-disabled` alone only describes a state and must be enforced
by the controller. `.panel-surface-error` supplies error color, not announcement
or validation behavior. Keep checkbox/radio semantics and labels intact.

`data-panel-header` stays outside `data-panel-body`, so it remains reachable
when content scrolls. Give the body a bounded height through its containing
surface. The rail's allocation supplies that bound; a dock or dialog owner must
supply its own `max-height` or height. Avoid a flex body whose contents shrink to
fit when those contents should instead scroll.

## Placement and ownership

| Mount                                 | Shared contract                                                                                     | Owner responsibilities                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct child of `#left-panel-stack`   | An owner with a direct `[data-panel-surface]` child receives relative positioning and allocated height; inner surface/body skin | Add the wrapper shown above, use the existing layout/disclosure owners, and retain left-rail focus/auto-collapse rules.                                                                                  |
| Direct child of `#right-context-rail` | The same hooks with right-rail allocation and intrinsic measurement                                 | Keep `data-rail-scroller` on the body so measurement preserves its scroll position. Respect Cyber's one-expanded-panel policy.                                                                           |
| Surface inside `#command-dock`        | Surface, controls, popup decoration and inherited dock concealment                                  | Supply geometry, stacking, disclosure, pin behavior if wanted, safe viewport bounds and dismissal. This CSS does not extend the existing Location/Visual Presets tray stack manager to arbitrary panels. |
| `dialog[data-panel-surface]`          | The same surface/body skin; a closed dialog remains hidden                                          | Set width/max-height, use `showModal()` or `show()` and `close()`, and own labels, initial/return focus and dismissal. Do not put `panel-collapsible` on a dialog.                                       |

For rails, `--panel-expanded-width` and `--panel-collapsed-width` customize
the desired widths within the rail; otherwise Cyber uses its existing left,
right and collapsed panel widths. `--left-panel-allocated-height` and
`--right-panel-allocated-height` belong
to the existing layout owner, not to individual panels. The surface must be
the wrapper's first non-glow child because left-rail intrinsic measurement
inspects that child. Do not put an absolutely positioned popup before the
surface or inside its body. Position a popup beside or above its surface using
component CSS; the shared rules deliberately do not choose a direction that
could run beyond the viewport.

Rail measurement still considers visible child extents. A popup extending
below the surface can therefore increase its measured height. Prefer a popup
beside or above the surface, or integrate an external overlay host with the
feature's layout owner; this CSS does not change measurement algorithms.

At viewport widths of 720px or less, both rails are intentional scroll
containers. Their overflow can clip outward popups even when the panel's own
surface is unclipped. Use a popup contained within the rail's visible bounds,
or an explicitly owned overlay host outside the rail; the surface contract
does not provide automatic popup escape from these small-screen scroll regions.

For dock disclosure, use a semantic button with `.panel-surface-control` and
the feature's own accessible name, `aria-expanded` state and event binding.
Do not copy the rail example's `.panel-collapse-btn` class into the dock:
existing dock rules intentionally hide that class. The generic surface skin
does not replace the dock's disclosure policy.

The existing `PanelChrome` binds `.panel-collapse-btn[data-collapse-target]`
at initialization and routes state through `setPanelCollapsed`. For additions
present at startup, keep those hooks and the existing chrome lifecycle. A
dynamically mounted panel must bind and dispose its own disclosure using
`bindPanelDisclosure` / `collapsePanelOnEscape` from `panelDisclosure.js`, with
the application owning state changes. Do not rerun the whole application chrome
initializer just to add one panel. `layoutLeftPanelRail` and
`layoutRightPanelRail` accept arbitrary direct `data-panel-id` children; their
host owns layout scheduling, observations and collapse callbacks. Dynamic
content that changes size may require an owner-scheduled layout pass or an
owned `ResizeObserver`; adding CSS attributes does not register new observers.

Persisted/share-link state, pinning, provider loading, keyboard shortcuts and
Cockpit-specific mounting still require deliberate integration with their
current owners. This contract does not add entries to named persistence, dock,
Cockpit or share-state policies. Dispose listeners, observers and timers,
dismiss open popups/dialogs and restore focus before removing a dynamic panel.

The Voice provider surface is the first dock adopter. Its outer provider owner
uses `data-panel-surface`; the provider row is its `data-panel-body`; Voice
Settings is an outward `data-panel-popup` with its own header and scrolling
body. Voice owns disclosure, focus return, timeout validation, local-only
persistence, provider replacement and session cleanup. The shared contract
only supplies the surface, controls, theme compatibility and concealment.

## Decoration, popups and visibility

The shared surface reserves `::before` for its non-interactive background. The
Cyber frame clips this pseudo-element only; the surface stays unclipped with
visible overflow. This follows the existing Display and Global Context pattern.
Putting the shape on an interactive ancestor clips all descendant popups even
if their `z-index` is high. A scrolling body also clips descendants by design,
so outward popups must be siblings of the body, or use an explicitly owned
overlay host outside every clipping ancestor.

`data-panel-popup` gives a positioned popup the same decorative and control
tokens. It is not a popover API, focus trap, collision solver or top-layer
manager. The owner must keep it inside the viewport, above relevant siblings,
and reachable by pointer and keyboard. A native modal dialog participates in
the browser top layer; a surface in a rail does not. Transform, containment,
mask, clipping or stacking rules on an additional ancestor can still obstruct
either an ordinary panel or its popup. Arbitrary future markup is not covered.

`hidden`, a closed native dialog and collapsed bodies/popups remain hidden.
Clean UI and recording conceal conforming surfaces, including outward popups;
owners must close modal dialogs when entering these modes so an invisible
modal cannot leave the application inert. Existing Cockpit rail and dock
exclusions remain in force. New left-rail/Cockpit functionality needs an
explicit product integration; the surface attribute grants no mode exception.
Never use theme styling to alter stored preferences or force hidden content
visible.

## Check an addition

Use the real application with the default and Cyber themes. Check open,
collapsed, hidden, disabled/error, theme round trips, clean UI/recording and
the intended Cockpit behavior. Exercise keyboard focus, Escape, pointer input,
the last scrolling item, resize without reload and any pin/unpin controls.
For an outward popup, test visible pixels and pointer hit-testing outside the
surface; a positive bounding box alone does not prove it escaped clipping.
Check each mount the addition actually supports. The CSS contract cannot
establish provider correctness, disclosure lifecycle or responsive placement
without those feature-specific checks.
