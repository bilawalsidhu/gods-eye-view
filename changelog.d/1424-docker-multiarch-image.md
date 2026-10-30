- Publish a hardened multi-arch (linux/amd64, linux/arm64) Docker image
  to GHCR on each release, built on native runners with provenance and SBOM
  attestations, and build, smoke-test and
  scan it on both architectures in CI. Compose keeps building the `dev` target
  (damianperera, #1424).
- Add `GEV_DATA_DIR`, which moves the `.env` that Provider Settings saves, plus
  `.gev-cache` and `.gev-logs`, out of the repository root. The Docker image sets
  it to `/data` so its code stays read-only and saved keys survive a recreated
  container (damianperera, #1424).
