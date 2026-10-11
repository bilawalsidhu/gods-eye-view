# Bundled Sound Attribution

The sound files in this directory are third-party assets. They are not covered
by the repository's MIT source-code license; each remains available under the
license listed below.

| File | Original work and creator | Source | License | Project modifications |
|---|---|---|---|---|
| `hud-lock.wav` | `confirmation_003.ogg` from “Interface Sounds” (1.0) by [Kenney](https://www.kenney.nl) | [kenney.nl/assets/interface-sounds](https://kenney.nl/assets/interface-sounds) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Converted from Ogg Vorbis to 44.1 kHz mono 16-bit WAV with trailing silence trimmed. Played when the HUD Target lock acquires a subject (Target sound "HUD lock"). |
| `sci-fi-click.wav` | “Sci-Fi UI Click Sound” by soundshelfstudio | [Pixabay sound 596258](https://pixabay.com/sound-effects/technology-sci-fi-ui-click-sound-596258/) | [Pixabay Content License](https://pixabay.com/service/license-summary/) | Converted from MP3 to 44.1 kHz mono 16-bit WAV, leading and trailing silence trimmed, and gain raised 14.8 dB to match `hud-lock.wav`. Played when the HUD Target lock acquires a subject (Target sound "Sci-fi click"). |

CC0 places the work in the public domain; credit is given as a courtesy.

**Licence carve-out:** `sci-fi-click.wav` is not CC0. The Pixabay Content
License allows free use, including commercial use, inside a project without
attribution, but forbids selling or redistributing the file on its own or as
part of a sound library. It is bundled only as part of the application. If your
use doesn't fit those terms, delete the file; the Target sound option then
plays nothing for "Sci-fi click".
