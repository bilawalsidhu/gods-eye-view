# Vue migration

The application UI moves from static templates plus imperative DOM wiring to
Vue 3 components with Pinia stores. The migration keeps the experience the
same: element ids, classes, the global stylesheet, translations, keyboard
shortcuts, voice actions, share links and the phone layout all behave as
before. The one intended change is the panel rail described below.

## Goals

- Views are Vue single-file components; state that several views read lives in
  Pinia stores rather than in DOM classes.
- The owners listed in [UI-OWNERSHIP.md](UI-OWNERSHIP.md) keep their
  responsibilities. A component replaces DOM construction; it does not add a
  second owner of the same state.
- Public methods used by layers, scene playback, voice and host applications
  (`setPanelCollapsed`, `setContextMode`, `setStyle`, share and location
  subscriptions) keep their signatures.
- Ids and classes used by browser QA and host applications stay stable until a
  host can use an explicit extension point instead.

## The panel rail

Each desktop sidebar gets a floating icon rail that lists every panel available
on that side. Selecting an icon opens that panel; selecting it again closes it.
One panel is open per side at a time, so the rail replaces the accordion
stacking. Panels that are not available in the current mode (for example
Weather before a weather layer is active) are shown disabled or omitted as the
panel's own availability rule dictates. The rail hides with the rest of the
chrome in Cockpit, scene playback, recording and the clean view.

Phones keep the existing bottom tab bar and sheets; the rail is desktop only.

Voice and keyboard openings go through the same panel store, so they follow the
one-panel rule too. Share links continue to record which panels are open.

## Component kit

`src/ui/kit/` holds the generic components: `UiRail`, `UiTooltip`, `UiIcon`,
`UiButton`, `UiCloseButton`, `UiPanel`, `UiPanelToggle` (a panel's collapse
button, which `UiPanel` and `PanelCollapseButton` draw), `UiPanelEdge` (a
panel header's edge switch), `UiSegmented`, `UiSlider`, `UiChip`,
`UiSelect`, `UiSearchField`, `UiCheckbox`, `UiSwitch`, `UiDialog`,
`UiBadge` and `UiEmpty` so far, with more joining as the controls they serve are
converted. One component
serves every use of a control, with props for the differences (`UiPanel`'s
`sideways`, `glow`, `scroll`), rather than a copy per panel. The components
are styled by the existing stylesheet and custom properties, and they contain
no application state. The kit's own classes wear Core's standard looks, each
sharing one selector list with the Core skin it comes from, so the rules are
never copied:

| Kit class | Look | Rules |
| --- | --- | --- |
| `UiButton` `variant="ghost"` (default) | none: the caller's classes style it | — |
| `UiButton` `variant="action"` | the action surface (`gev-action-button`); `tone="danger"` hovers red, `size="compact"` is the shot-row footprint (on this variant only) | `src/ui/styles/action-button.css` |
| `UiButton` `variant="primary"` | the action surface with a group's main-action accent | `src/ui/styles/action-button.css` |
| `UiButton` `variant="icon"` | the 22px square glyph button of a panel's collapse toggle | `src/ui/styles/controls.css` |
| `UiCloseButton` | a close, dismiss or clear button: a bare glyph (× with `glyph="times"`, the Material `close` symbol with `glyph="icon"`) with no padding, border or background of its own and a pointer; the site's feature class sets size, colour, hover and any surface, and `bare` leaves the look off for a skin that sets its own padding and border | `src/ui/styles/close-button.css` |
| `UiSearchField` | a search field: the Material `search` glyph and a search input in a flex row, the input bare (no border or background, free to shrink); the site's feature classes set the frame's size, surface and focus ring and the input's type and outline, and the browser's own cancel button is left to each skin | `src/ui/styles/search-field.css` |
| `UiCheckbox` | a checkbox: a label wrapping a native box and its words in a centred flex row; the box keeps each site's size, margin and accent colour, and the site's feature class sets the row's gap, direction and colour | `src/ui/styles/checkbox.css` |
| `UiSwitch` | an on/off switch: a `role="switch"` button drawn as a 30 by 16 px pill track whose knob slides to the end and takes the accent while it is on (mirrored right to left); a disabled switch dims | `src/ui/styles/switch.css` |
| `UiDialog` | none: a native modal `<dialog>`; the site's feature class or inline style draws it | — |
| `UiChip` | the read-only chip (a pill of uppercase mono text); `selected` takes the accent | `src/ui/styles/chip.css` |
| `UiEmpty` | the one-line empty state (dim mono text), its hint on a line below | `src/ui/styles/empty-state.css` |
| `UiBadge` | the read-only badge (`gev-status-badge`) | `src/ui/styles/status-badge.css` |
| `UiSegmented` | the segmented control (`gev-segmented`, `gev-segment`) | `src/ui/styles/segmented-control.css` |

A pressed action, primary or icon button looks as a hovered regular one does
(a compact action's quieter hover is for an unpressed button), and a disabled
one dims and ignores hover and press. `tone` is `accent` or `danger`, and
`size` styles the action variant only. Each look's resting rule selects one
kit class; the button, chip and empty-state skins load before the feature
stylesheets that restyle them, so a feature class still wins. The badge and
segmented skins are the stylesheets their Core classes always used. A
converted control keeps its own classes beside the kit's.
`src/ui/kit/kitStyles.test.mjs` pins these rules.
`UiPanel` takes a `title`, slots and `v-model:collapsed`, but its
`collapsed` drives only the button and `ui-panel--collapsed`: the root's
`collapsed` class, which hides the body, is drawn at once by `v-panel-state`
from the panel chrome store, and there is no `closable`, since Core's panels collapse rather than close.
`UiSegmented` adds `keyboard` (`none`, `arrows`, or `radio` with
Home and End), since each of Core's groups keeps its own keyboard policy, and
`itemClass`/`activeClass` for Core's segment classes. A key moves focus at
once and asks for a change only when it lands on another option. Every
segmented group in Core is a `UiSegmented`; the old `segmentedControl.js`
adapter is gone.
No view hand-writes a control the kit has: every button in an SFC outside
the kit is a `UiButton`, `UiCloseButton` or another kit control, every
Material Symbols glyph a `UiIcon`, every checkbox a `UiCheckbox`, every
on/off switch a `UiSwitch`, every select a `UiSelect`, and every range a `UiSlider` except the radio
tuner's and the world timeline's, for the reasons given below. No module
outside the kit, and no SFC's script, builds a button, select, field or
Material glyph in script or writes one as markup in a string, apart from
the globe panel's standalone page (`src/tools/globePanel.js`), plain HTML
a host serves with no Vue or kit, whose Expand and Open buttons are
written as markup (`src/ui/kit/viewControls.test.mjs` pins all of it).
The native fields left are the text, number, password and file inputs
and the two text areas (the chat's message box and the scene dialog's
multiline field) the kit has no control for, and the search fields whose
surfaces this document names. The scene dialog's single-line field takes
its type from its caller, which passes text-like types only.
`UiButton` adds `pressedClass`, Core's class on a pressed toggle (most use
`active`); its pressed classes toggle through `classList`, so a class other
code adds (a voice highlight) survives a press. Every pressed toggle (a
control with `aria-pressed`) in the views is a `UiButton` with `pressed`
except Explore's story cards, which keep their own `aria-pressed` since
they are `role="button"` elements, not buttons
(`src/ui/kit/viewControls.test.mjs` pins it). Where the
converted buttons draw Material symbols (the tilt-map button, the Context
header's search and expand, the imported files' row actions and the rail
chips' icons), the glyphs are `UiIcon`s with `:size="null"`, so the site
rules still size them. Core's pressable chips and pills (the rail cards'
chips and action chips, Recent Imagery's day chips, SWAP and ZOOM IN, map
sources, cities and places, the view context's place and layer chips and
the key setup chip) are `UiButton`s too. `UiChip` is a non-interactive
label chip, used by the voice card.
header's search and expand, Draw, Import, the imported files' and drawn
shapes' row actions and the rail chips' icons), the glyphs are `UiIcon`s
with `:size="null"`, so the site rules still size them. Core's pressable
chips and pills (the rail cards' chips and action chips, Recent Imagery's
day chips, SWAP and ZOOM IN, map sources, cities and places, and the view
context's place and layer chips) are `UiButton`s too; the key setup chip
is still a plain button. `UiChip`
is a non-interactive label chip, used by the voice card.
The welcome card's buttons (SKIP, the three start tiles, BROWSE STORIES,
BACK and the main NEXT / ENTER DEFAULT MODE action) are ghost `UiButton`s:
the start tiles are pressed toggles, and all but SKIP keep `aria-disabled`
rather than `disabled`, so they stay focusable while the card is busy. Its
tile, tip, Stories and arrow glyphs are `UiIcon`s with `:size="null"`, so
first-run.css still sizes them (`src/ui/kit/welcomeControls.test.mjs` pins
it). Default mode's preview globe and callouts stay inline SVG drawings, and
its outbound links stay links.
Every button in the Stories views (the Stories entry and its popup and
toast, Explore, the Story screen, its header, rail, timeline and context
panel) is a ghost `UiButton`. Explore's topic chips and map pins, the
Story screen's Context button and the timeline's Expand map are pressed
toggles, with no pressed class since their skins read `aria-pressed`;
Explore's story cards are `role="button"` elements and keep their own
`aria-pressed`. Their glyphs are inline SVG drawn for Stories, which no
Material symbol the page loads draws the same, so they stay SVG; the three
search fields (Explore's two and the Story context sheet's story search, a
combobox) keep their own markup, since `UiSearchField`'s Material
magnifier would replace their SVG one, and Explore's two clear buttons,
which draw an SVG cross, are ghost `UiButton`s rather than
`UiCloseButton`s (`src/ui/kit/storiesControls.test.mjs` pins it).
Explore's sort is a `UiSelect`.
Every button in the Cockpit HUD (`CockpitView` and its panels: the vision
selector, Look ahead, the view switcher's Reset and Exit, the utility
strip's launchers, collapse buttons, Radio transport and desktop rail, the
briefing card's paging, Auto, collapse and page tabs, the Contact card's
navigation, collapse and Weather, a signal row's target, the orbital
view's TLE, Nadir, zoom and Sensor, and the bridge radar's range) is a
ghost `UiButton` that keeps its id and classes, so the Cockpit
controller's listeners and the cockpit stylesheets still find it. Radio's
Enable (with `active`), Auto and Weather are pressed toggles; the
disclosures keep `aria-expanded` and the page tabs `aria-current`. Its
glyphs (the rim pointers, the reticle, the heading caret, the chevrons and
panel glyphs, the contact and route arrows) are `UiIcon`s with
`:size="null"`; the heading caret's rule reads
`.cockpit-compass .cockpit-heading-caret`, so it still outranks the kit's
`.ui-icon`, which loads after cockpit.css
(`src/ui/kit/cockpitControls.test.mjs` pins it). The −, ◀ ▶ and + glyphs
are text characters and stay text, and the Radio volume is a `UiSlider`.
The Omnibar's mic (a pressed toggle with `active`) and its suggestion
strip's chips (options, so `aria-current` rather than `pressed`) are
ghost `UiButton`s, and its search, row and chip glyphs are `UiIcon`s with
`:size="null"`, so its own rules still size them
(`src/ui/kit/omnibarControls.test.mjs` pins it). The mic's and the chat
row's glyphs stay inline SVG, since no Material symbol the page loads
draws them, and its field is its own combobox rather than a
`UiSearchField`.
The Visual panel's buttons (its presets and map sources, HUD, Sonar,
Detection, 3D, Clean UI, Celestial, Bloom, Sharpen and Reset to default) are
ghost `UiButton`s. HUD, Sonar, 3D, Celestial, Bloom and Sharpen are
pressed toggles with `active` as their pressed class; Detection sets its own
`active` and `panoptic` classes, and Clean UI is not a pressed toggle (its
owner marks it `active`). The panel's Scope, Celestial,
sky, application-row and Reset glyphs are `UiIcon`s with `:size="null"`, so
the panel's rules still size them (`src/ui/kit/visualControls.test.mjs` pins
it). The toggles' other glyphs (◎ ▣ ✈ □ ✨ 🔍) and the presets' style glyphs
are text characters, not Material symbols, and stay plain spans.
The entity card's buttons are ghost `UiButton`s: its four preview buttons
(Photos, Route, 3D, Cockpit view) are pressed toggles with `active`, Follow
is one with `entity-card__action--on`, and the cockpit entry, Fly to and
Ask GEV are plain buttons; so are the camera preview's bigger-view and More
info buttons and the nearby lists' rows (`SpotConditions`, which the
context view shows too). Their glyphs are `UiIcon`s with `:size="null"`,
so entity-card.css and spot-conditions.css still size them
(`src/ui/kit/entityCardControls.test.mjs` pins it). Ask GEV's chat bubble
stays inline SVG, since no Material symbol the page loads draws it.
The command dock holds only the voice control, whose buttons are its own.
The Context panel's buttons (its two tabs, Contacts, the
cockpit entry and SEARCH NEARBY SITES, beside the header's search and
expand and the TR-3B chip) are ghost `UiButton`s; the tabs and Contacts
are `role="tab"` controls, chosen through `aria-selected` with their own
`active` class rather than `pressed`. The view context it shows while
nothing is picked (a worldwide tile that turns a layer on, an item's row,
the place and layer chips and Ask GEV) is on the kit too, and the glyphs of
all three are `UiIcon`s with `:size="null"`, so their site rules still size
them; an item's motion glyph keeps `role="img"` and its name, with the
kit's `aria-hidden` taken off (`src/ui/kit/commandDockControls.test.mjs`
pins it). Ask GEV's chat bubble stays inline SVG.
The Layer Finder's buttons (Search, Filter, the filter menu's Status and
Category options and the bar's two clear chips) are ghost `UiButton`s.
Search and the options are pressed toggles; the options' pressed class is
`active`, while Search keeps its own `active` binding, which also stays on
while a query is typed. The Filter button opens a disclosure and carries
`aria-expanded`, not `aria-pressed`. Every glyph its own template draws is
a `UiIcon` with `:size="null"`, so `layer-finder.css` still sizes them
(`src/ui/kit/layerFinderControls.test.mjs` pins it); the search field's
magnifier is `UiSearchField`'s own span.
The Space Missions panel's buttons (a mission's roster row, FOCUS,
REPLAY ASCENT, the replay's pause, PREV, NEXT and SHOW ALL / DESELECT),
the Contacts panel's (PREV, FOCUS, NEXT and a contact's row), the Radio
panel's (Enable, PREV, PLAY, NEXT and STOP), the RTL-SDR card's (Connect,
Locate, Change device, FM, ADS-B, Tune and the two seeks) and the key
setup's (the POWER UP chip, a key's REMOVE, the voice auth toggle and
SAVE KEYS) are ghost `UiButton`s. Radio's Enable and the card's Connect,
FM and ADS-B are pressed toggles with `active`; PLAY and Locate keep
their own `active` class without `aria-pressed`, since their words say
what they will do or have done. The chip's bolt is a `UiIcon` with
`:size="null"`, so provider-settings.css still sizes it
(`src/ui/kit/missionsRadioControls.test.mjs` pins it). The card's FM
frequency stays a native number field, which the kit has no control for,
and the replay's pause, the roster's chevron and the compass arrows are
text characters, not Material symbols.
Utilities' Draw and Import are on the kit. Draw (a pressed toggle with
`active`), Clear and Import are ghost `UiButton`s, their glyphs `UiIcon`s
with `pp-icon` and `:size="null"`. Draw's five colour swatches, in the
toolbar and in a drawn shape's row, are ghost `UiButton`s with
`role="radio"`: they say they are chosen with `aria-checked` and their own
`active` class, never `aria-pressed`. A drawn shape's row (its swatch,
show/hide, the application's row actions and fly to, beside its remove
`UiCloseButton`) is on the kit too, its glyphs `UiIcon`s with
`:size="null"`, so `controls.css` still sizes them; show/hide says what it
does in its name (Show …, Hide …) rather than being pressed. The Street
Level panel's controls already were kit controls; its EXPAND ⤢ ⤡ and its
errors' ⚠ are text characters and stay text
(`src/ui/kit/drawControls.test.mjs` pins it).
The AI chat panel's and the voice control's buttons are ghost
`UiButton`s: the chat's Settings, quick prompts, attachment removes,
Attach layer, Attach a file, Expand conversation, command suggestions,
Expand chat, Add attachment and Send (a submit button that turns into
Stop reply), and the voice control's Open AI chat, Back to chat, Back to
voice, its Preview and Settings tabs and the error tray's DISMISS, beside
the tier button, the mic and the dock and minimize buttons, which already
were. The tier button and dock are pressed toggles; the mic is one only
while its owner has a state for it; the tabs keep `role="tab"` and
`aria-selected`. DISMISS is a text button, not a cross, so it is not a
`UiCloseButton`. The Settings and tab glyphs are `UiIcon`s with
`:size="null"`, so voice-cost.css and voice-card.css still size them
(`src/ui/kit/chatVoiceControls.test.mjs` pins it). The chat bubble,
globe, attach, send and stop, expand and Back glyphs stay inline SVG,
since no Material symbol the page loads draws them the same, and the
message box, file picker and inactivity minutes stay native fields, which
the kit has none of. The voice modules build no controls in script.
The small surfaces' buttons are ghost `UiButton`s: the locale picker's
button, the phone tab bar's tabs, the globe actions' Clear, Share, Reset
and north-up compass, the imagery divider's handle, the scene sharing
dialog's buttons, the layer group index's ticks, the title logo, Exit
clean view, the HUD's cockpit entry, a News card's face, a rail card's
header, a layer row's toggle, the credits line's Data attribution and the
camera calibration chips. None is a pressed toggle; the disclosures keep
`aria-expanded`. Their Material glyphs (the tabs', the globe actions', the
compass needle, the cockpit entry's and the celestial ring's sun and moon)
are `UiIcon`s with `:size="null"`, so the site rules still size them. The
locale picker's globe, caret and check and a News card's category icon stay
inline SVG. The Omnibar guide draws the extra rings of a step with several
targets in its template, as many as `view.subRings` says, rather than
building them in script; the Omnibar's one other `material-symbols-outlined`
is a stylesheet selector, and the layer disclosure only names a button in a
comment (`src/ui/kit/smallSurfacesControls.test.mjs` pins it).
The Street Level photo viewer of KartaView and Panoramax (the photo, the
panorama canvas and the ‹ › buttons) is `StreetLevelPhotoViewer`, drawn
from what the photo viewer presents rather than built in script. Its ‹ and
› are ghost `UiButton`s, not pressed toggles, whose glyphs are text
characters; the viewer builds no element, and the street-level layer it
belongs to needs no Vue (`src/ui/kit/streetLevelPhotoControls.test.mjs`
pins it). The notice the God's Eye View panel page shows when it loses its
3D graphics (`#status`, in `src/app/globePanelRuntime.js`) stays built in
script: that script is sent to the host as source text and runs in the
host's panel page before the app loads, so it can import nothing.
The Bhote Koshi reconstruction panel's buttons (previous and next beat,
Play, Play scene, Cinematic, Full story, Open original, Lower gorge, the
field reports and Open public map) are ghost `UiButton`s that keep their
`data-action` hooks. Cinematic is a pressed toggle with no pressed class,
since bhote-koshi.css reads its `aria-pressed`: the event layer presents
its state as the record's `pressed`, which the panel passes to the
button, instead of writing an `aria-pressed` attribute. The ‹ and ›
arrows are text characters. The event's embedded media cards (each
anchored witness clip's frame, leader line, title, status and original
link, and the hidden YouTube preload) are drawn by
`BhoteKoshiMediaCards`, which `src/data/bhoteKoshiEmbeddedMedia.js`
renders into its overlay root with `h()` and `render()` on every change,
words again on a locale change, and places after each frame; they hold
no control, and the original link stays a link. The script still builds
the provider SDKs' script and preconnect tags, the overlay root, and the
Facebook player node: that node is warmed hidden before its card exists
and carried, loaded, into the card's player, where the SDK replaces its
contents, so a template could only rebuild it and reload the player; the
X post is likewise built by its SDK inside the player
(`src/ui/kit/bhoteKoshiControls.test.mjs` pins it).
`UiSelect` renders the bare native select (Core's labels sit outside it or
come as an `aria-label`) with `v-model`, `options` and `disabled`;
options that carry their own attributes come through the slot, a caller's
`@change` still reaches the select, and `hold` works as in `UiSlider`.
Without `hold`, a select takes its model back after its own change renders,
so a pick its owner refuses goes back; an owner that answers later (the SDR
gain) takes `hold`. A layer row's range ends are repainted on a later frame
and may come back reordered (a start picked after the end swaps them), so
they take a plain `value` instead of a model: a pick stays until the owner
publishes a different value, which shows at once, focused or not
(`src/ui/layerPanel/rowRange.test.mjs`). Every select in the views is a
`UiSelect` (`src/ui/kit/viewControls.test.mjs` pins it).
`UiBadge` takes a `tone` and carries Core's `gev-status-badge`; its
density variants and colours stay caller classes, and it renders the CCTV
source and calibration badges and the rail card badges. `UiEmpty` takes
a `title` and `hint`, but Core's empty states are one line, so the title
is the text itself rather than a bold heading; the News feed, Scene shot
list, mission roster and imagery strip use it. The locale picker's and the mission tables'
empty rows stay a paragraph and table cells.
`UiCloseButton` is a `UiButton` with a fixed glyph, a required `label` and
no tip unless the site passes a `title`; attributes and classes pass through,
so each site keeps its id, feature class and look. Every close, dismiss and
clear button in the views that draws a cross is one
(`src/ui/kit/closeButtons.test.mjs` and `viewControls.test.mjs` pin it,
for a bare × or one in a span) except Story Explore's two search clears,
whose SVG cross is neither of its glyphs, and an imported file's
Remove, one of the row's icon `UiButton`s (show or hide, fly to, remove)
that draw the icon the file import names for each. The Story context
sheet's Close is a text button, a plain `UiButton`. Street Level's and the
space mission's (its deselect and the replay's Cancel) keep `bare`, since
their skins set their own padding and border, and so does the credits
list's. The Quebec CCTV overlay's close is one too, and so is the Omnibar
guide's, which keeps its feature class and tip.
`UiSearchField` takes `v-model`, a required `label` (the input's
accessible name), `placeholder` and `tag` (`div`, given `role="search"` by
the site, or `label`); attributes and classes go to the frame, and
`inputId`, `inputClass`, `autocomplete` and `spellcheck` to the input. With
`clearLabel` it shows a `UiCloseButton` (`clearClass`, its label as its tip)
while text is typed, which empties the field and focuses the input again.
Escape stops at the input and is emitted with its event, so a site that also
keeps the browser from clearing the field prevents it there; `focus()`
focuses the input. The Context search and the Layer Finder's are
`UiSearchField`s; the locale picker's combobox, the Omnibar's location
field and the Data Library's labelled search are other controls. Its kit rules hold the declarations both search
skins had in common, moved rather than copied, and load before them.
`UiCheckbox` is a `<label>` wrapping a native `<input type="checkbox">` and
its default slot; `trailing` puts the box after the words, as the Visual
panel's rows have it. It takes `v-model` (the change emits the checked state)
and emits `change` with its event; without a `modelValue` the box is the
browser's own, as the welcome card's "Don't show this again" is, whose
owner puts a refused save back itself. `restore` puts the box back to
`modelValue` once a change has rendered without the owner taking it, so the
voice panel's quick commands and Voice Preview show the applied value after
a refused change. Attributes and classes go to the label; `inputId` and
`inputAttrs` (such as `aria-describedby` or a data hook) to the box. The
Visual panel's Scope, sky and application toggles, the voice and chat
preferences, the Data Library's filter and the welcome card's box are
`UiCheckbox`es, and so are Story Explore's filter options, whose label
keeps its `fopt` class (`src/ui/kit/checkboxes.test.mjs` pins it). Its kit
rule holds the centred row the checkbox-only labels drew, moved rather than
copied.
`UiSwitch` is a `role="switch"` button whose `aria-checked` shows
`modelValue` (`v-model`) or `checked`, and `label` is its accessible name.
A click emits `update:modelValue` and `change` with the state asked for,
and the switch keeps showing the prop until its owner passes the new one, so
a refused change never shows; `disabled` makes it a disabled button. The
rail cards' toggle rows (the air-quality card's station switch) are
`UiSwitch`es with `checked` and `change`, since the card applies the change
through its params (`src/ui/kit/UiSwitch.test.mjs`; no view hand-writes
`role="switch"`, which `src/ui/kit/viewControls.test.mjs` pins). Its kit
rules hold the rail card's switch look, moved rather than copied.
`UiDialog` is a native `<dialog>` its owner opens and closes with `open`:
true opens it with `showModal()` (on mount, for one mounted open), false
closes it, and unmounting closes it. Each change is applied once the content
has rendered and then emitted as `opened` or `closed`, so the Data Library
focuses its search field on open and returns focus to Browse on close.
Escape's `cancel` is prevented and emitted as `dismiss`, so the owner
decides; `backdropDismiss` makes a click on the dialog itself, outside its
content, a `dismiss` too. When the browser closes the dialog on its own
while `open` is still true (an Escape the page may not cancel),
`browserClose` tells the owner; closing on unmount reports nothing. A DOM
without `showModal()` leaves it closed rather than failing. Attributes,
classes, styles and listeners go to the dialog, and `element` is exposed.
The Data Library and the scene sharing dialogs are `UiDialog`s
(`src/ui/kit/dialogs.test.mjs` pins it); the panels drawn as
`role="dialog"` (key setup, the welcome launcher, the CCTV popup, Story
Explore's filter, the credits, the Omnibar guide's callout) and the render
failure's `alertdialog` are
other controls. The two dialogs share no declarations, so it has no kit
rules.
`UiSlider` keeps the native range input rather than drawing a
`role="slider"` track, so Core's keyboard, form behaviour and styling stay;
it takes `v-model`, `min`, `max`, `step` and `disabled`, emits a
number, and adds `hold` (never rewrite a focused handle, and take the model
back on blur) and `unstyled` (the browser's own range, as Bhote Koshi's
are, without Core's slider surface). A caller's own input, change and blur
handlers still reach the input, and a null model leaves it as it is. It is
a functional render-function component, so the portable `./ui/input` rows
use it without a component compiler. Every range in the views is a
`UiSlider` except two. The radio tuner's owner moves the handle back to the
selected station on a drag's first input without changing the slot, which
a functional component would not render again. The world timeline's
scrubber is a bare range inside its own gesture track: its `step="any"`
bounds follow the zoomed view, and a pinch puts the input back on the
handle itself.

Controls share one skin, so every panel reads the same. Every scrolling
surface carries the kit's `.ui-scroll`, which draws the thin
themed scrollbar from `--scroll-thumb` and `--scroll-track`, and Cockpit's HUD windows keep their accent tint. A
surface without it would draw the platform's light scrollbar, because the
page declares no dark `color-scheme`. Selects and number fields are
`.gev-field`, which draws its own chevron in place of the platform's arrow
and keeps native spinners dark; ranges are `.gev-quantitative-slider`, with
a feature supplying only its accent.

`t()` is reactive only while the locale is bound to a ref (the app binds
it to vue-i18n's). Words a view passes to a kit component as a prop
(`UiCloseButton`'s `label`) follow the view's render at once. Words and
props read in a kit component's slot follow a tick later, in the child's
own update, and never when the locale is unbound; a slot that reads a
`v-for` variable is already redrawn with its view. A view whose owner
patches synchronously and reads the result at once (a News card, a rail
card, the credits line, the Omnibar guide's buttons) gives such a slot
under a named condition that is always true
(`<template v-if="redrawWithView" #default>`): Vue redraws a conditional
slot whenever its view is drawn.

## Phases

1. **Foundation.** Vue, Pinia and the Vite Vue plugin join the browser build
   (`build/vite.js`, so host applications receive them too). One Vue runtime is
   created by the shell (`src/ui/vueRuntime.js`) with one Pinia instance that
   every view shares; disposing the shell unmounts them. Stores are added
   when a view needs one, mirroring state an owner already publishes, so
   there is never a second owner of the same state.
2. **Rail.** `PanelChrome` enforces one panel per side; the panel store
   mirrors each side's panels and the rail renders from it. The rail panels
   are `RailPanel`s: the kit's `UiPanel` drawing Core's panel markup, bound to the `gev-panel-chrome`
   store, with their titles rendered by `t()` rather than `data-i18n`. Each panel's
   collapse button renders the open state PanelChrome presents to the
   `gev-panel-chrome` store, and its clicks call it there. Each panel's
   root draws its own state from there too (`v-panel-state`: `collapsed`,
   `layout-auto-collapsed`, `accordion-collapsed`): PanelChrome, the rails
   and the accordion present
   it rather than writing classes. The directive applies it in a synchronous
   watcher, not on Vue's next render, because the rails measure a panel in
   the same task that opens or closes it. PanelChrome and its preference
   restore, and the phone shell, read a panel's state back from the store
   (`_shownPanel`; the markup's classes before its first presentation), so
   once a panel is presented a class written outside the store no longer
   counts. The rails and the accordion, which act within the same task as a
   layout, read the classes the directive has just drawn. Done.
3. **Panels.** Each template and its wiring become a component, keeping ids,
   classes and CSS; text a template renders with `t()` drops its `data-i18n`
   marker. The page places each view with a
   `.gev-view` host (`display: contents`), and `mountApplicationViews()`
   (`src/ui/views/index.js`) renders the view into it before the page is
   translated and wired. `createApplication()` calls it too, removing the
   hosts of any views its `omitViews` names. Views belong to the page and are
   unmounted only when a later call omits them. The loading screen is static markup in the page so it
   paints before any script runs. Markup
   tests read `renderApplicationHtml()` from `src/testSupport`, which renders
   the views on the server. Templates compile with Vue's `preserve`
   whitespace, which keeps the whitespace between elements as a single
   space, so a view renders as its template did; no view markup sits under a
   `white-space: pre` rule. Application views (`src/ui/views/*View.vue`) are
   kept out of Prettier; other components are formatted with strict
   whitespace sensitivity, so their source spacing is what renders. The
   markup has moved, unchanged:
   every template except the loading screen is a view.

   Next each view takes over its wiring: markup an owner builds with
   `createElement` becomes component markup that renders from a Pinia store
   the owner publishes to, and user actions come back to the owner through
   the store, so the owner keeps every decision. Component text uses
   `t()`, which follows the locale as the view renders; the views carry no
   `data-i18n*` markers, which `npm run i18n` rejects in a template. Shared builders become components first and
   keep their imperative entry points until their owners are components:
   the rail cards and card blocks (`src/ui/rail/`) render through
   Vue's synchronous `render()` behind `createRailCards()` and
   `createRailCardBlocks()`. Order: Scenes (done: `SceneOptions` and
   `SceneShotList` over the `gev-scenes` store; the panel's buttons, status
   line, progress bar and the runtime chip render the panel SceneControls
   presents there, and the buttons and file chooser call its actions), Weather (done: the owner
   renders `WeatherReadout` from the view it computes), Recent imagery
   (done: `RecentImageryReadout` and its day cards, the same way),
   Street level (done: `StreetLevelPanel` renders the `gev-street-level`
   store that `StreetLevelControls` publishes to; the controls keep their
   listeners, EXPAND, focus and resizing; `StreetLevelPhotoViewer`, beside
   it in the layer panels, teleports into the viewer host the photo viewer
   KartaView and Panoramax mount there, which `createPhotoViewer()`
   presents through the layer's `subscribePhotoViewer()` and the
   application shell publishes to the `gev-street-level-photo` store, so
   the portable `./layers/street-level` entries need no Vue; the viewer
   keeps every decision, the photo loading, keys, drag and zoom, and draws
   its panorama on the canvas the view hands back, a fresh one after a lost
   WebGL context; each mount and canvas is keyed, so no viewer reuses
   another's elements, and of two viewers mounting at once only the later
   is drawn while the earlier one's mount closes; with no view
   subscribed, as when the layer runs without the application shell, a
   KartaView or Panoramax photo cannot mount),
   CCTV (done: `CctvPanel` renders
   the whole panel from the `gev-cctv` store, including the camera picker,
   the inline pose editor, the frame preview, source badge and typed
   summary; `CctvControls` keeps its listeners, the frame requests and the
   live video surface; `QuebecCctvOverlay` teleports the Québec 511 player
   and its map preview to the end of the body, rendered synchronously by
   `createQuebecCctvOverlay()` from the view it computes, as the rail cards
   are; the owner keeps every decision and the parts the template never
   binds: each video's source, playback and refresh timer, the window's drag
   and the marker's per-frame visibility and place), Layers (done:
   `LayerPanel` presents each row and renders `LayerRows` synchronously; keyed chips and list items keep focus
   through the refresh their own click triggers, and clicks re-read the live
   descriptor before acting), Display (in progress: `DisplayPanel` renders
   the HUD, Sonar, Scope, Celestial, detection, bloom, sharpen and the
   active style's parameter sliders from the `gev-display` store, which
   VisualSettings publishes to and answers the sliders through, and the 3D
   aircraft group, the Draw controls and the imported file list, which
   AircraftDisplay, the draw tool and the file import publish beside it;
   the controls call DisplayBindings, the draw tool and the file import
   through the store's `connect`/`act`, the newest owner of an action
   answering it; `GeoImport` hands keyboard focus on before a focused row
   goes, with `v-focus-safe-children`; the
   style parameter rows render through Vue behind `createStyleParameters()`,
   as a render function so the portable `./ui/input` entry needs no
   component compiler; the other groups follow one owner at a time),
   Context and Radio (in progress: `RadioPanel` renders the directory row,
   station card, transport, volume and playback line from the `gev-radio`
   store that RadioControls publishes to and whose controls it answers
   through the store's `connect`/`act` (the shared `createOwners()`; a
   refused station tag gets the kept tag back from `act`), and `SdrCard` the
   local RTL-SDR card that LocalSdrControls publishes beside it and answers
   the same way; fields a person edits take their value through
   `v-field-value`, which never writes a focused field;
   `RadioTuner` renders the directory tuner, where RadioControls keeps the
   drag and its slot, takes the slider's pointer, key and value events
   through the store and publishes the band, readouts, slider and needle,
   and the component lays out the tick tape against the dial's measured
   width and lays out the snapped needle before it drops the drag class;
   `ContextView` renders the mode switch and the nearby sites
   search from the `gev-context` store, which ContextControls reaches only
   through its `publish` option, so `./ui/context` needs no Vue;
   `AwarenessPanel` renders the Contacts panel that the awareness layer
   publishes through `subscribePanel()`, the first layer to hand its rail
   content to a view, and `MissionRoster` and `MissionDetail` the Space
   Missions roster and selected mission that the launches layer publishes
   the same way), the command dock (the ACTIVE STYLE corner renders the
   style VisualSettings publishes to the `gev-display` store; Visual's map
   source chips and status badge render what `createMapSourceControls()`
   publishes beside it, so `./ui/maps` needs no Vue; the Omnibar's city and
   landmark chips and search error render what `LocationControls` publishes
   to the `gev-location` store; beside the voice control, the dock teleports each voice pointer reticle to the
   body where its `PointerReticle` presents it in the `gev-pointer-reticle`
   store; `startGuide()` renders the Omnibar's guided walk, `OmnibarGuide`,
   synchronously from the view it computes for each step, teleported to the
   end of the body, and keeps every decision and word, focus and its return,
   Escape, the entrance replay, and the callout's and spotlight rings' place
   each frame), the phone shell (`PhoneTabBar` renders the tabs and open sheet the shell
   publishes to the `gev-display` store, teleporting the tab bar and sheet
   backdrop to the end of the page from the first publish until the shell
   is destroyed; the shell takes their clicks from the document), the
   imagery dividers (`ImagerySplitView`, in the scene chrome, teleports each
   before/after divider that `createImagerySplit` publishes to the
   `gev-imagery-split` store to the body; the split keeps the
   drag, keyboard, CSS position and scene split), the status chips
   (the top-center loading status and the road network and camera grid
   chips render what ShellFeedback and CctvControls publish to the
   `gev-status` store; `SplitFlapText` plays the departure-board flip that
   `splitFlap.js` plans, writing only the label's one text node; the toast
   renders what each owner's `createToast()` publishes there, on that
   owner's own timer, and the title bar's FPS readout what
   `createFrameRateMonitor()` publishes), the globe actions
   (`GlobeActions` renders the top-center bar; its clear, share, tilt,
   north-up and reset buttons, and the cockpit's reset, call the shell
   through the `gev-globe-actions` store, which also carries a clear or a
   reset under way and the camera's tilt and heading
   that `bindCameraOrientationControls` publishes each drawn frame it
   changes, which only `GlobeCompass` renders; an owner publishes only
   while it answers the button, so a shell replaced by a newer one leaves
   its state alone), the recording safe frame (the scene chrome renders
   the frame `RecordingControls` publishes to the `gev-recording` store),
   the Scene actions panel (`SceneInteractions`
   teleports what the scene interactions owner publishes to the
   `gev-scene-interactions` store into the viewer's container; the owner
   keeps the pick handler and focuses the picked action), the data-pack
   attribution cards (`DataPacks` teleports what the data-pack presentations
   publish to the `gev-data-packs` store into the viewer's container and
   stops a removed card's player), the wind inspection marker
   (`WindInspectionMarker` teleports the marker into the wind layer's
   container where `createWindInspectionMarker()`, now in
   `src/layers/wind/inspectionMarker.js` so the portable `./tools` entry
   needs no Vue, places it after each rendered frame; an unchanged frame
   publishes nothing), the Space Missions replay vehicle
   (`MissionReplayOverlay` teleports into the globe container what the
   launches layer presents through `subscribeReplayOverlay()`, which the
   application shell publishes to the `gev-mission-replay` store, so the
   portable `./layers/launches` entry needs no Vue), the Bhote Koshi
   reconstruction panel (`BhoteKoshiPanel`, last in the context rail,
   renders what the event layer publishes to the `gev-bhote-koshi-panel`
   store: each control's text, hidden, disabled, value and attributes as
   the layer writes them, and the cinematic button's pressed state,
   unchanged frames sending nothing; the rail takes
   `bhote-event-active` while it shows), the full-globe celestial ring
   (`CelestialRing` teleports into the globe container what `CelestialRing`
   in `src/celestialRing.js` publishes to the `gev-celestial-ring` store and
   hands its two canvases back for the owner to paint; the application shell
   passes the store in, so the keyhole helpers other packages import need no
   Vue), the screen-space map annotations (`ScreenAnnotations` teleports to
   the body the board the screen annotation renderer publishes to the
   `gev-screen-annotations` store after each rendered frame: each mark's SVG
   parts as attribute records, the fading marks until they leave; the view
   hands back the callout text and mark groups the renderer measures, and
   the tracked-entity fade is measured once the frame is in the document;
   the styles it injected now live in `src/ui/styles/annotations.css`), the
   visible map target list (the scene chrome renders the buttons and status
   the world overlay presents through `subscribeWorldOverlayActions()`, which
   the application shell publishes to the `gev-world-overlay-actions` store
   and answers with `activateWorldOverlayAction()`; the module needs no Vue
   for the portable transit entry, and its card and detection canvases stay
   painting surfaces it draws on, like the Cesium canvas), the Global
   Context compass and contact bearings (`AwarenessDirection` teleports into
   the globe container what the awareness layer presents through
   `subscribeDirectionOverlay()`, which the application shell publishes to
   the `gev-awareness-direction` store, so the portable `./layers/awareness`
   entry needs no Vue), the Intel HUD (the `intel-hud` view renders
   `#intel-hud`, its corners, edges and bottom bar from the `gev-hud`
   store, which IntelHUD publishes to through its `publish` option: the
   readouts, the typing summary, the REC blink, visibility, layout variant
   and style colors; the vessel layer presents the selected vessel's
   readout through `src/hudReadouts.js` instead of writing into the HUD;
   the view reports through the store whether `#intel-hud` is displayed
   (not displayed once it is unmounted), and while it is not IntelHUD runs
   no timers and publishes only the root's `active`, variant and colors,
   then shows current readouts as soon as it is; the readouts that change many times a
   second keep their text node through `v-text-data`),
   the first-run mission launcher (the welcome view renders the card's
   visibility, busy state, status line, copy and scroll fade from the
   `gev-first-run` store that `initFirstRunExperience` publishes to, and its
   choices, DISMISS and "Don't show this again" call the launcher's
   controls; a refused save hands the tick back to the view to revert. The
   launcher still reads the rendered card for its hit test, keyboard trap,
   focus and overflow measurement), the attribution line (for a renderer
   without its own credit display, `mountCreditsView()` renders
   `CreditsView` synchronously, as the weather readout is, and the view
   teleports the line and its "Data attribution" list to the end of the
   body, where the page's rules select them; the owner keeps the credits
   shown, the list's open state and its focus, and words the view again
   when the locale changes; the list's close button is a bare
   `UiCloseButton`), then
   Cockpit (in progress: `CockpitBriefing` renders the briefing card's
   pages, cycle toggle, regional news and local conditions, and
   `CockpitContext` the Contact card's scope, navigation, counts, nearest
   contact and weather toggle, `CockpitView` the instruments, destination
   arrow and vision selector, and `CockpitRoute` the flight plan card, from
   the `gev-cockpit` store that the Cockpit controller publishes to,
   starting from `cockpitBriefPages.js`, `cockpitContextState.js` and
   `cockpitInstrumentState.js`, which both read; the odometer readouts
   (`CockpitRollingValue`) keep their throttle and roll in
   `cockpitRollingValue.js`. `CockpitSignalList` renders the live signal
   rows; `v-focus-safe-children` turns Vue's move of the focused row into
   moves of the rows around it, and hands focus to the shown briefing tab
   before the focused row is removed, so a keyed list reorders several times
   a second without dropping keyboard focus. The instruments publish on
   every HUD update (about 10 Hz); in a dev build their Vue patch costs
   about 0.5 ms, close to the DOM writes it replaced. The controller also
   publishes which surfaces are shown: the entry button and TR-3B chip in
   the Context panel, the HUD with its exit and reset buttons and briefing
   card, and the Contact card. Focus moves to the exit button, and back to
   the entry, only after Vue renders them. The cards' collapse is part of
   that presence too: each card's `data-collapsed` and its toggle's words
   and icon render from it. The controls keep the controller's listeners,
   and the cards' layout stays with the controller, which reads their
   visibility when it lays them out. Its layout pass publishes the utility
   strip's measured fit (the HUD's anchor and height limits, whether only the
   expanded control fits and which control is hidden from assistive
   technology), which `CockpitView` and `CockpitUtilityControls` render; the
   briefing and Contact cards' positions stay imperative, because the same
   pass measures them straight after writing them.
   `CockpitUtilityControls` renders the Display
   and Radio launchers, which popover is open and the compact Radio
   controls from the `gev-radio` store that RadioControls publishes to and
   answers through. The Cockpit display portal publishes the Display
   popover's slots to the `gev-display` store while Cockpit is on, and
   `DisplayPanel` teleports its HUD, Detection, Parameters and 3D groups into
   them and back; the portal keeps each surface's scroll position and puts
   back focus the move dropped).
   Layers that write into the right rail directly gain a slot instead.

4. **Cleanup.** The build-time template expansion is retired: `index.html`
   lists the view hosts and the loading screen itself. Every owner that
   showed UI state through hand-written DOM writes now publishes to a store
   that a view renders, apart from the imperative parts this document
   records surface by surface; [Building UI](../CONTRIBUTING.md#building-ui)
   now requires the pattern for new UI. The page-level markup tests read
   `renderApplicationHtml()`, the real views rendered on the server, and new
   tests mount components. Many tests still read `.vue` sources: the kit's
   control scans in `src/ui/kit/` (`viewControls`, `closeButtons`,
   `checkboxes`, `dialogs` and the per-surface ones) and markup checks such
   as `contextTabKeyboard`, `geoFileImport` and `panelStorageDocs`. The
   views translate with `t()` while rendering, and vue-i18n holds the
   locale they read; the attribute translation pass is left for static page
   markup (the loading screen and a host's own markup). An explicit API for
   hosts to register panels and rail items is deferred until a host needs
   one.

## Page-root state classes

A stylesheet that styles one surface by the state of another, in a different
view (the dock and credits while the Omnibar is on the page, the Stories
entry while the loading screen shows), selects a class on `<html>` rather
than `body:has(...)`. Chrome checks a `:has()` on body again after every node
added or removed anywhere on the page and restyles the whole page when it
does; a class changes only with the state it names. `src/ui/rail/rootClass.js`
holds them: `v-root-class` on the element whose presence or state it names
(the Omnibar, the voice control in the dock, `#intel-hud`, the first-run
launcher, the World Timeline, the language picker), its hooks running inside
Vue's patch so the class changes with the element; `followSelectorRootClass()`
for markup Vue does not render (the loading screen, followed by the Stories
view wherever in body it is added, removed or shown, as `:has()` would); and
`followRootClass()` for nodes that move at run time (the left panel stack's
own panels, followed by the layer panels view). They live on `<html>`, not
`<body>`, whose class changes several owners follow to lay the page out
again. A rule selects one as `body:is(.has-omnibar *, #gev-omnibar)`: the
second argument never matches body and keeps the specificity the
`:has(#gev-omnibar)` it replaced had. `src/ui/pageRootClasses.test.mjs`
holds each class to its state and every stylesheet to the pattern.

## Verification

- Unit tests: stores and components run under `npm test`. Single-file
  components are compiled by a test loader; component tests render with
  `@vue/test-utils` and `happy-dom`. `npm test` registers the loader; to run
  one file that reaches a component (including anything importing the
  shell), use `node --import=./build/registerVue.js --test <file>`.
- Never pass happy-dom nodes to `assert.equal` or `deepEqual`: a failure
  prints both operands, and a node reaches the whole page and window, which
  runs the process out of memory. Compare nodes with `assertSameNode()`
  (`src/testSupport/domAssert.mjs`).
- Panels lifted out of a view keep its verbatim markup in
  `src/ui/views/panels/`, which Prettier leaves alone like the views.
- Visual parity: before/after screenshots of every panel at desktop and phone
  widths, in the default theme, with the rail as the only expected
  difference.
- Browser QA: the selector-based `scripts/qa-*.mjs` suites keep passing.
- `npm run format:check`, `npm run check:boundaries`, `npm run i18n` and
  `npm run build`.
