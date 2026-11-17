# Tracking comparison for PR #1783

The unmodified stock tracking harness was run in the same environment against the ports feature and a clean upstream worktree without the ports layer.

| Revision | Passed | Failed | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: |
| Feature (`6748841`; runtime unchanged by `b20e906`) | 97 | 6 | 4 | 1 |
| Upstream baseline (`624c229`) | 97 | 6 | 4 | 1 |

Both runs reproduce exactly the same six assertion names and failure details:

- display-floor: the fleet billboard lifts onto the planted floor (control for the tracked check)  — tracked exit model identity changed
- display-floor/gate: with NO resolved ground the grounded model is withheld and the billboard is floored  — tracked exit model identity changed
- display-floor/placement: a resolved grounded model stands ON the floor, not under it and not hidden  — tracked exit model identity changed
- display-floor/regime: the TRACKED grounded contact is floored exactly when the billboard is the visual  — tracked exit model identity changed
- display-floor/regime: data APIs report sensor truth in BOTH regimes, floored or not  — tracked exit model identity changed
- display-floor/loading: tracked regime active with no rendering model stays floored  — rendering models during load=undefined, entity at NaN m on a NaN m floor

Both runs report no browser console errors and no HTTP 5xx responses. The four skipped probes concern trail-head / retained or loading grounded model visuals.

Environment: Node 24.22.1, Chrome Headless Shell 156.0.8078.47, SwiftShader. The workspace blocks the Unix singleton socket required by full Chrome. Public network requests used the environment proxy; the tracking harness supplied its normal synthetic aircraft/satellite feeds and bundled imagery.

Command (with a development server running in the same execution context):

```sh
PUPPETEER_EXECUTABLE_PATH=<pinned-headless-shell-wrapper> npm run test:track -- --url http://127.0.0.1:<port> --offline-imagery
```

The tracking harness is byte-identical in both worktrees (Git blob `4e163cd398c9775b7f079090cb96fc2eb687b0ad`). No tracking code or assertions were changed by this PR.

Both revisions reproduce the same failures. The required tracking gate remains unresolved; PR #1783 stays draft pending a successful run or maintainer resolution. The ports-specific fixture and live-source gates, full unit suite, focused panel/lifecycle suite, production build and repository policy checks passed.
