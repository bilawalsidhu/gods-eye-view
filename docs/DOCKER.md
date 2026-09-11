# Docker

The container includes Node.js 24 and the locked npm packages.
Users do not need a local Node.js or Git installation to run a published image.
Use Docker with Linux container support and Docker Compose 2.24 or later.
The image supports AMD64 and ARM64. Other processor types are not supported.
The browser provides WebGL; the container does not need a GPU.
Live data still needs an internet connection and available provider services.

## Start a published image

1. Save `compose.yaml` in a new directory.
2. Open a terminal in that directory.
3. Run `docker compose up -d`.
4. Open `http://localhost:4173` in a browser.

The default image is `ghcr.io/bilawalsidhu/gods-eye-view:latest`.
The owner must first publish the package and set its visibility to public.
For a fork, set `GEV_IMAGE=ghcr.io/OWNER/gods-eye-view:latest` in `.env`.
Replace `OWNER` with the repository owner's name in lowercase.
The workflow uses its own repository name; it never publishes to the parent repository.

## Add or change keys

Keep the ENV file private. It contains plaintext keys.
Never add real keys to Git, a Dockerfile, or image build arguments.
Docker administrators can read container environment values.

1. Copy `.env.docker.example` to `.env` beside `compose.yaml`.
2. Enter the optional provider keys you need.
3. On macOS or Linux, run `chmod 600 .env`.
4. Run `docker compose up -d --force-recreate`.
5. Reload the browser page.

The ENV file is optional. An absent file starts the app without keys.
For advanced provider options, use the names in `.env.example`.
Compose passes these values into the container through `env_file`.
It fixes the internal port to 4173 and enables ENV-only key configuration.
Use `GEV_PORT=4174` in `.env` to select another host port.
The `PORT` variable does not change the internal port in this image.

`docker compose restart` does not load new ENV values.
A key change needs container replacement, but no image build.
Google Maps and Cesium ion keys are public browser credentials.
Restrict these keys at the provider. All other provider keys stay on the server.
Never prefix a private key with `VITE_`.

Provider Settings is disabled in the image. `GEV_KEY_SETUP_DISABLED=1`
denies both status reads and key writes, even from container loopback.
The app cannot change values that Compose owns.
Docker Secrets support is not part of this first version.

## Update and retain data

```bash
docker compose pull
docker compose up -d
```

Compose retains the cache and log volumes when it replaces the container.
It also retains them after `docker compose down`.
Logs can contain voice-session data. Apply your own retention policy.

**Warning:** `docker compose down -v` deletes these volumes.

The app keeps view preferences in the browser's local storage.
Container volumes do not copy these preferences to another browser.
Use a version tag or a `sha-...` tag in `GEV_IMAGE` to select an earlier image.

## Build from source

From the repository root:

```bash
docker build -t gods-eye-view:local .
```

Set `GEV_IMAGE=gods-eye-view:local` in `.env`, then run:

```bash
docker compose up -d
```

The build excludes local ENV files, caches, Git history, and promotional media.
It skips the Puppeteer browser download.
The image retains Vite and `ws` because the live API server needs them.
It runs as an unprivileged user.

## GitHub Actions and forks

The Docker workflow builds and tests both supported platforms on pull requests.
Those jobs have no package write permission and do not publish images.
Tests check startup without keys, new keys after container replacement,
private-key isolation, disabled Provider Settings, and cache retention.

After these tests pass, a push to `main` publishes a `latest` tag and a commit tag.
A `v...` version tag publishes a version tag and a commit tag.
A manual run on the default branch can publish an image as well.
The workflow publishes to `ghcr.io/<repository-owner>/<repository-name>`.
It uses `GITHUB_TOKEN` with `packages: write`. No personal registry token is needed.

GitHub can disable Actions on a new fork. Enable Actions in the fork first.
After the first publication, set the package visibility to public if users
must pull it without a GitHub account. Public repository visibility alone
does not guarantee public package visibility.

For a local container check, run:

```bash
node scripts/test-docker.mjs gods-eye-view:local
```

This check uses fixture keys and does not call paid provider endpoints.
It removes its test containers and test volume when it exits.

## Network access

The supplied Compose file binds the host port to `127.0.0.1`.
It provides a local application, not a public service.

**Warning:** Other users can spend your API quota if they can reach the server.

Before you expose it to a network, add authentication and HTTPS through
a separate access proxy. Configure provider quotas as described in
[SECURITY.md](../SECURITY.md). Remote microphone access also requires a secure browser context.

This first image uses the existing development server to retain all API routes.
A future server split can remove that dependency without changing the ENV interface.
