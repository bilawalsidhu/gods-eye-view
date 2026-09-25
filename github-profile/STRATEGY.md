# GitHub Profile Strategy — @Sireesh01

A plan for turning github.com/Sireesh01 into a profile that reads like the ones
on [Trending Developers](https://github.com/trending/developers). It's based on
the trending list and the profiles behind it, studied on 2026-09-24.

---

## 1. What the trending developers have in common

I read the 25 developers on the trending page and looked closely at six
profiles: henrygd, 0xAX, skyzh, maziyarpanahi, squidfunk and kane50613.

| Pattern | Evidence | What it means for you |
|---|---|---|
| **One flagship project gets people onto the list, not the README** | Every entry is there because of one repo: beszel (25.7k★), linux-insides (33.6k★), openmed (5.4k★), mkdocs-material (27.5k★), takumi (3k★) | Work on the repo first. Decoration comes last. |
| **The repo description is a one-line promise** | *"Lightweight server monitoring with historical data, docker stats, and alerts."* · *"A 100% private AI voice assistant that lives on your computer (works offline)."* · *"4.2x faster than Ollama"* | Each description says what the project does and why it's better, with a number where possible. |
| **Each person owns a clear niche** | 0xAX works on Linux internals, maziyarpanahi on medical AI, squidfunk on docs tooling, skyzh on LLM inference | Pick one niche you can own and repeat it in your bio, README and pins. |
| **Profile READMEs are short** | skyzh has 1 sentence and 3 links. kane50613 writes *"Why we need a fancy portfolio website when GitHub stats just works."* 0xAX has About, Projects and Contact | Keep it to 10–30 lines with no widget clutter. |
| **Proof comes as numbers** | maziyarpanahi lists *853M downloads*, *5,093 models* and *14+ years*. Star counts appear on pins | Put a measured result in every claim: accuracy, latency, dataset size, users. |
| **Pins mix their own projects with upstream work** | 0xAX pins his own repos **and** the Linux kernel and systemd. kane50613 pins takumi **and** fumadocs, which he co-maintains | Pin your original work plus merged PRs to well-known projects. Pinned forks with no commits count against you. |
| **Topics follow what's in demand** | 2026's list is full of local-first/on-device AI, agents and MCP servers, and "runs without API keys" | Aim your flagship at a current theme such as on-device, private, zero-config or agent-ready. |
| **Launch assets matter** | This repo's own README opens with a hero GIF, a one-line hook, social proof, "start without API keys" and a Quick Start | Treat each flagship README as a landing page. |

**Anti-patterns that are absent from these profiles:** walls of stats cards and
trophy widgets, typing-SVG banners, lists of 40 skill icons, follow-for-follow
behavior, and pinned forks nobody has touched.

---

## 2. Where your profile is today

| Item | Current state | Problem |
|---|---|---|
| Name / bio / location / links | Empty | Visitors can't tell who you are or what you do |
| Profile README (`Sireesh01/Sireesh01`) | Missing | The page has no landing content |
| Original repos | 1 (`pothole-detction`) | **It's empty (0 KB)** and the name has a typo |
| Forks | 4 (ai-project-gallery, 30-Days-of-Python, H3, gods-eye-view) | Forks with no commits of your own look like bookmarks, not work |
| Pins | None | GitHub falls back to showing forks |
| Followers | 0 | This follows from shipping work. Don't chase it directly |

**Hidden strength:** your forks point to a coherent niche. Pothole detection is
computer vision. H3 is geospatial indexing. God's Eye View is a real-time 3D
globe. ai-project-gallery is ML. Together that's **Geospatial AI: computer vision
+ maps**, and very few people own that combination.

---

## 3. Positioning

> **"I build AI that sees the physical world — computer vision + geospatial systems."**

Use this line (or your own version of it) in the bio, the README headline and
every flagship repo so the story stays consistent.

---

## 4. Action plan

### Phase 0: Profile basics (1 hour, today)
- [ ] **Settings → Profile:** full name, a clear headshot, location and a website or LinkedIn link.
- [ ] **Bio (160 chars):** `Geospatial AI · computer vision + maps · building road-safety tools from dashcam video 🛰️`
- [ ] **Create the public repo `Sireesh01/Sireesh01`** and copy `github-profile/README.md` into it. Fill in every `TODO`.
- [ ] **Unpin and archive, or delete, forks you haven't changed** (30-Days-of-Python, ai-project-gallery). Keep a fork only if you'll commit to it.
- [ ] Turn on **Settings → Public profile → "Include private contributions"** so private work shows on the contribution graph.

### Phase 1: Turn `pothole-detction` into a real project (1–2 weeks)
This becomes your first flagship.
- [ ] Rename it to **`pothole-detection`**. GitHub redirects the old URL.
- [ ] Push the code: a YOLO11/RT-DETR model fine-tuned on a public road-damage dataset (RDD2022 is a good starting point).
- [ ] Write the README like a landing page:
  1. **Hero GIF** showing dashcam video with boxes drawn on potholes
  2. **One-line hook** with a number, for example *"Real-time pothole detection from any dashcam — 45 FPS on a laptop CPU, mAP50 0.xx."*
  3. **Run it in one command:** `pip install …` / `python detect.py --source video.mp4`
  4. **Results table** comparing mAP, FPS and model size against a baseline
  5. **How it works** diagram, a limitations section, a licence and a citation
- [ ] Add a live **Hugging Face Space** demo and link it from the repo's About box.
- [ ] Add 5–8 **topics** (`computer-vision`, `yolo`, `object-detection`, `road-safety`, `geospatial`, `edge-ai`) and a social-preview image (Settings → Social preview).
- [ ] Tag a **v1.0.0 release** with the model weights attached.

### Phase 2: A signature project that brings your niche together (3–6 weeks)
Combine the three things you already work with:

> **Road-hazard map:** dashcam video → pothole detection → GPS-tag every
> detection → aggregate into **H3 hexagons** → severity heatmap on a 3D globe.

- It's visual, so it GIFs well, and it's useful to cities, cyclists and insurers.
- It fits 2026's trends: it runs on-device, needs no API keys, and it's privacy-preserving because faces and plates get blurred on-device.
- **Stretch goal:** contribute it upstream as a "Road Hazards" layer to
  [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view),
  a repo that reached #1 on GitHub Trending. A merged PR there does more for your
  profile than any README widget. Read `CONTRIBUTING.md` first: `npm run build`,
  `npm test` and `npm run test:track` must pass.

### Phase 3: Upstream contributions (ongoing)
- [ ] Look for `good first issue` / `help wanted` in **uber/h3**, **h3-py**, **ultralytics**, **gods-eye-view**, **supervision** and **CesiumJS**.
- [ ] Start with docs fixes, tests and small bugs, then larger features.
- [ ] Pin the merged work. The Pull Shark achievement and the "Contributed to" list come from this.

### Phase 4: Distribution (every launch)
Projects reach Trending through a burst of stars in the first 24–48 hours:
- [ ] Post a 20–30 s screen recording on X/LinkedIn with the repo link.
- [ ] Share it in r/computervision, r/MachineLearning (the [P] Project tag), r/gis, Hacker News (Show HN) and relevant Discords.
- [ ] Write a short build write-up on dev.to, Medium or a personal blog, and link it from the README.
- [ ] Reply to every issue quickly. Early maintainers get followers by being responsive.

---

## 5. Final pin layout (target)

| # | Pin | Why it's there |
|---|---|---|
| 1 | `road-hazard-map` (signature project) | Your flagship, and it tells the whole story |
| 2 | `pothole-detection` | Computer vision depth, with a live demo |
| 3 | Merged PR repo: `gods-eye-view` | Social proof from a #1-trending project |
| 4 | Merged PR repo: `h3` / `h3-py` | Geospatial credibility |
| 5 | A small, polished utility (for example `h3-heatmap-cli` or `dashcam-gps-extract`) | Shows range; small tools pick up stars easily |
| 6 | Blog/notes repo, or another CV project | Adds personality and consistency |

---

## 6. Rules to keep

1. **Ship before you polish.** One real project with a demo counts for more than any profile design.
2. **Back every claim with a number.** Use measured numbers only and never inflate them.
3. **Keep one niche and one story** across the bio, README, pins and topics.
4. **Commit consistently** with small, real commits. Don't game the contribution graph.
5. **Skip widget overload.** One activity graph at most. Trending developers don't use them.
