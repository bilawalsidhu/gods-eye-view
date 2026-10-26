- Publish a hardened, signed multi-arch (linux/amd64, linux/arm64) Docker image
  to GHCR on each release, built on native runners, and build, smoke-test and
  scan it on both architectures in CI. Compose keeps building the `dev` target
  (damianperera, #0000).
