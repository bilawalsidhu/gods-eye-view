- Harden Vite's filesystem deny list for local-only artifacts: repo `dist/`,
  `.gev-logs/`, and `.gev-cache/` are denied without blocking dependency
  `dist/` directories, and checkout paths containing glob metacharacters are
  escaped before building the root-anchored pattern (blowing-a-raspberry, #948).
