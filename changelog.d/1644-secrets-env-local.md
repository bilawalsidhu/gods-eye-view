- Keep API keys in `.env.local` and settings in `.env`. `.env.example` now
  opens with a SECRETS section and a SETTINGS section, each key linked to
  where it comes from; `npm run env:init` creates both files (the keys file
  owner-only) and moves each key line in an existing `.env` into its
  placeholder in `.env.local`, printing names only. Provider Settings saves
  to `.env.local` and removes the key from `.env`, the setup doctor names the
  file each key came from and warns while a key is still in `.env`, and the
  `tools/` scripts read `.env.local`. The launchers no longer pass OpenSky's
  retired username/password, and the Pinokio template gains the same two
  sections (BeerMan81, #1644). Repeated key assignments in an existing
  `.env` now keep the latest nonblank value active after migration, preserving
  the earlier value as a comment.
