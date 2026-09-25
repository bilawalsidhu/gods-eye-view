---
name: ui-polish
description: Apply refined visual design to the AI Command Center panel using the frontend-design approach — distinctive tokens, deliberate typography, and intentional layout.
disable-model-invocation: true
---

# UI Polish — AI Command Center

Apply frontend-design methodology to elevate the AI Command Center panel from "functional dark UI" to a distinctive tactical interface.

## Design Brief

**Subject**: JARVIS AI Command Center — the control surface for a geospatial intelligence platform
**Audience**: Operators, analysts, developers who need tactical confidence
**Primary Job**: Convey supreme competence — this panel IS the AI assistant

## Token System (refined from foundation.css)

### Color (6 named hex values)

```
--void:       #020810       // deepest space — panel background base
--abyss:      #06141e       // elevated surfaces — cards, drawers
--teal-void:  #003d44       // interactive surface hover — subtle cyan tint
--teal:       #00f0ff       // primary accent — JARVIS cyan
--amber:      #ffb703       // secondary accent — warmth, warnings, active state
--emerald:    #10b981       // tertiary — success, connected, live data
```

### Typography

- **Display/Headlines**: 'JetBrains Mono' — monospace for tactical precision
- **Body/UI**: 'Inter' — clean, legible, -apple-system fallback
- **Scale**: clamp(12px, 0.75rem, 14px) base, modular scale 1.25

### Layout

- **Panel width**: 520px max (current) — good for dense tactical data
- **Alignment**: Left-aligned content, centered headlines
- **Spacing**: 8px base unit, 4/8/16/24/32px rhythm
- **Corner radius**: 10px panel, 8px buttons, 6px cards — hierarchy not uniform

### Principles

1. **One bold element** — the cyan scanline top border is the signature; keep it, amplify it
2. **Motion as feedback** — only on user action (expand, send, switch mode)
3. **Hierarchy via weight/opacity** — not color overload
4. **Glass is material** — backdrop-filter + subtle border = depth

## Implementation

Edit `src/ui/styles/ai-command-center.css` with these changes:

1. **Import refined tokens** from foundation.css (already available)
2. **Tighten panel chrome** — reduce visual noise, amplify scanline
3. **Mode tabs** — distinct active state using amber underline + weight, not background fill
4. **Message bubbles** — subtle surface elevation, monospace for code/telemetry
5. **Input area** — amber focus ring, teal scanline on active
6. **Remove generic defaults** — no ALL-CAPS labels, no identical rounded cards, no soft grey shadows
