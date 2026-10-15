# Preferred GPU and browser setup for PR review

Use this setup when the [maintainer workflow](MAINTAINER_WORKFLOW.md) identifies
isolation as warranted: security-sensitive changes, new external data sources or
data layers, new or changed access endpoints, or changes that introduce dependency
or script execution risk. For those PRs on Linux/WSL, strongly prefer Bubblewrap,
GPU-accelerated Chromium inside the sandbox, and browser MCP tools. These tools
are preferences, not acceptance requirements; equivalent restricted environments
and Puppeteer, Playwright, or manual inspection can supply browser evidence.

Low-risk UX-only PRs can use ordinary local tests and browser/MCP inspection after
static review. They do not need this launcher, a VM, or a dedicated review account
solely for layout, styling, or interaction changes that leave data access,
security boundaries, dependencies, and execution scripts unchanged. GPU evidence
for rendering or performance changes remains relevant regardless of isolation.

Read this reference from the same trusted policy revision as the workflow.
Keep launch wrappers and provisioned browser/MCP tools outside the contributor's
tree. The example below is a Linux starting point, not a universal sandbox policy.

## Prepare the review environment

1. Put the recorded PR revision in a disposable checkout or worktree. It separates
   files and Git state; Bubblewrap supplies the execution boundary. Do not copy
   personal dotenv files, Pinokio `ENVIRONMENT`, browser profiles, or agent settings.
   A standalone disposable checkout simplifies sandbox mounts. With a worktree,
   ensure its Git metadata pointer resolves inside the sandbox without exposing
   the maintainer's credential-bearing Git configuration or hooks.
2. Provision supported Node, Chrome for Testing or compatible Chromium, and a
   pinned browser MCP server in a separate tool directory. Pin the tool's version
   and lock its dependencies; avoid downloading a moving `latest` during review.
3. After static inspection, run `npm ci` for the PR in a credential-free,
   restricted provisioning environment. Allow only the dependency/download hosts
   actually needed, then restrict runtime networking. Do not run contributor
   lifecycle scripts on the host. A dedicated populated npm cache can support
   an offline install; record any skipped scripts or incomplete installation.
4. Start from `--unshare-all`, `--clearenv`, a private `/tmp`, and explicit mounts.
   Mount toolchains and libraries read-only; make only the disposable review tree
   and evidence directory writable. Do not mount the user's home, SSH agent,
   secret stores, system/session bus, or container-engine socket.
5. Keep the app, Chromium, and preferably the MCP server in the **same sandbox**.
   They share sandbox loopback; the agent communicates with MCP over stdio. This
   avoids exposing either the app or Chromium's debugging port on the host.

The default network namespace has no external connectivity. Use deterministic
fixtures first. For live data, configure a dedicated allowlisted proxy/relay or
equivalent restricted egress for both Node providers and Chromium. Merely setting
a browser proxy does not restrict server-side requests. Do not substitute
`--share-net` as though it preserved host-network isolation. Offline failures are
not evidence that live loading and provider paths work.

## Give the browser GPU and display access

Mount the required GPU device and matching userspace driver libraries. On typical
Linux systems this is a selected `/dev/dri/renderD*` device; the exact device and
driver configuration depend on the machine. Prefer a dedicated or nested Wayland
compositor for a visible browser. Give it only the required display socket. X11
access is broader and can expose other clients on the same display; a private
display is preferable for contributor code.

On WSL/WSLg, OpenGL commonly uses `/dev/dxg`, Mesa's D3D12 driver, and the libraries
and matching driver files under `/usr/lib/wsl`. A working host configuration may
need these explicitly restored after clearing the sandbox environment:

```bash
--dev-bind /dev/dxg /dev/dxg
--ro-bind /usr/lib/wsl /usr/lib/wsl
--setenv LD_LIBRARY_PATH /usr/lib/wsl/lib
--setenv GALLIUM_DRIVER d3d12
--setenv MESA_D3D12_DEFAULT_ADAPTER_NAME '<adapter-name>'
```

The adapter selection is optional and machine-specific. Do not publish a
maintainer's personal paths, GPU name, or display socket as mandatory settings.
GPU and display access expand the permitted interfaces; keep those mounts narrow
and retain Chromium's own sandbox. Avoid `--no-sandbox` and
`--disable-web-security`. If Chromium cannot launch securely in the chosen
environment, adjust the environment or record the check as unavailable.

## Example launcher and MCP connection

This Bash example assumes dependencies are already installed in the disposable
review tree and MCP is already installed in the separate locked tool directory.
Set the paths and GPU/display arguments for your environment. Provisioning is a
separate restricted step; this launcher deliberately starts with offline networking.

```bash
review_tree=/absolute/path/to/disposable-checkout
review_node=/absolute/path/to/node-installation
review_chrome=/absolute/path/to/chrome-directory
review_tools=/absolute/path/to/locked-mcp-tool-directory
review_state="$(mktemp -d)"
chmod 700 "$review_state"
mkdir -p "$review_state/evidence"
printf 'review:x:%s:%s::/tmp:/bin/sh\n' "$(id -u)" "$(id -g)" \
  > "$review_state/passwd"

# Populate these arrays for the machine. For example, a Linux render node:
review_gpu_args=(--dev-bind /dev/dri/renderD128 /dev/dri/renderD128)
# A Wayland socket from a dedicated/nested compositor:
review_display_socket=/absolute/path/to/dedicated/wayland-0
review_display_args=(
  --dir /run/review
  --ro-bind "$review_display_socket" /run/review/wayland-0
  --setenv XDG_RUNTIME_DIR /run/review
  --setenv WAYLAND_DISPLAY wayland-0
)

bwrap --unshare-all --die-with-parent --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp \
  --dir /etc --ro-bind "$review_state/passwd" /etc/passwd \
  --ro-bind /etc/hosts /etc/hosts \
  --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf \
  --ro-bind /etc/fonts /etc/fonts \
  --ro-bind "$review_node" /opt/node \
  --ro-bind "$review_chrome" /opt/chrome \
  --ro-bind "$review_tools" /opt/review-tools \
  --bind "$review_tree" /app \
  --bind "$review_state/evidence" /evidence \
  --clearenv --setenv PATH /opt/node/bin:/usr/bin:/bin \
  "${review_gpu_args[@]}" "${review_display_args[@]}" \
  --chdir /app /bin/bash -c '
    set -e
    npm run dev -- --host 127.0.0.1 --port 4173 --strictPort \
      > /evidence/server.log 2>&1 &
    app_pid=$!
    /opt/chrome/chrome --ozone-platform=wayland \
      --user-data-dir=/tmp/review-chrome \
      --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
      > /evidence/chromium.log 2>&1 &
    chrome_pid=$!
    trap "kill $app_pid $chrome_pid 2>/dev/null || true" EXIT
    # Wait for both endpoints without printing anything on MCP stdout.
    node --input-type=module -e '\''
      for (const url of ["http://127.0.0.1:4173/", "http://127.0.0.1:9222/json/version"]) {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
            await res.body?.cancel();
            if (res.ok) { ready = true; break; }
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error(`Review endpoint unavailable: ${url}`);
      }
    '\'' >&2
    /opt/review-tools/node_modules/.bin/chrome-devtools-mcp \
      --browser-url=http://127.0.0.1:9222 \
      --no-usage-statistics --no-performance-crux
  '
```

Adapt library paths on distributions without `/lib64`. For WSL, replace the GPU
arguments with the WSL device/driver arguments above. For a dedicated X11 display,
mount its socket and set its `DISPLAY`, and replace `--ozone-platform=wayland`
with `--ozone-platform=x11`. The correct ANGLE backend can also vary: the tested
WSL OpenGL setup used `--use-gl=angle --use-angle=gl`, without forcing SwiftShader.
Preserve driver environment settings deliberately rather than inheriting every
host variable. Some drivers need additional narrowly scoped discovery mounts.

Save the adapted launcher outside the review tree and configure the MCP client's
stdio `command` to run that trusted launcher. Keep launcher, app, and browser logs
off stdout: it carries the MCP protocol. The launcher stays alive until MCP exits,
and Bubblewrap's lifetime closes its child processes. Verify the connected
browser's version and page URL before exercising the candidate. An existing MCP
connector may target a different browser and may not support retargeting; do not
assume it inspected the sandbox. Use equivalent automation if it cannot connect.

If MCP must run outside the sandbox, expose only a dedicated browser-control
relay bound to host loopback, restricted to the review user, and remove it on
cleanup. Chromium's DevTools endpoint grants browser control: do not expose it on
the LAN or attach it to a personal profile. Loading the app in a host browser
places page execution outside Bubblewrap and is a different isolation choice.

## macOS alternatives

Bubblewrap depends on Linux namespaces and does not run natively on macOS. It
can run inside a Linux VM on a Mac, but that does not establish access to the
Mac's GPU or native browser performance. Docker Desktop's documented container
GPU support is for Windows with WSL2; do not assume a Mac container supplies
hardware-accelerated Chromium.

For Mac maintainers reviewing PRs that warrant isolation, choose the arrangement
that supplies the required evidence. Low-risk UX-only PRs can use native local
Chromium/MCP without setting up a VM or dedicated account:

- **Isolated execution and functional UX:** use a disposable Linux VM (or a
  container inside its VM) for the checkout, installs, server, Chromium, and MCP.
  Disable host-home sharing, credentials, shared clipboard, and unrestricted
  egress. Connect MCP over stdio or a restricted tunnel. Verify the renderer;
  software rendering supports functional checks but leaves GPU performance
  unverified. Bubblewrap inside the VM is optional additional isolation.
- **Native Mac GPU measurements:** keep contributor installs and server execution
  in that restricted VM. Forward only the review app port to Mac loopback. Run
  native Chromium and the trusted MCP server in a dedicated, non-admin review
  account with a fresh browser profile, no personal credentials, and Chromium's
  sandbox enabled. Connect MCP to that dedicated browser using stdio and a
  loopback-only DevTools endpoint; never attach to the maintainer's everyday
  profile. Verify the actual renderer and compare base/candidate on the same Mac.
  This preserves native browser GPU access, subject to verification, while page
  execution is on macOS outside the server VM. Account separation and Chromium's
  sandbox do not supply the same whole-process boundary as the Linux launcher;
  record that distinction and use a disposable review machine if stronger
  isolation is needed. Do not execute contributor Node scripts on the Mac host.
- **Browser and server together with GPU isolation:** use a dedicated Linux GPU
  review machine and the Bubblewrap setup above, with MCP reached through a
  restricted connection. Its performance evidence applies to that Linux setup;
  it does not replace Mac-specific regression checks.

VM graphics capabilities vary. Do not promise native FPS for either Linux or
macOS guests without checking their actual browser renderer and representative
workload. Record the chosen arrangement and remaining limitations; none of these
options makes Bubblewrap mandatory for Mac maintainers.

## Verify GPU, performance, and UX

- Inspect `chrome://gpu` and the actual app's WebGL renderer using
  `WEBGL_debug_renderer_info` where available. Record WebGL2 support, backend,
  GPU/driver identity, and relevant Chromium flags. SwiftShader, llvmpipe, and
  other software renderers are functional fallbacks, not GPU performance proof.
- Check `chrome://sandbox` to confirm Chromium's renderer protections are active.
- Use MCP to exercise changed and adjacent flows, keyboard navigation, viewport
  sizes, loading/empty/failure states, and teardown. Inspect console and network
  activity; capture evidence in the disposable evidence directory.
- Run the workflow's unit/build/tracking checks inside the restricted environment.
  Stop the dev server, launch `npm run preview` on the recorded port, and repeat
  relevant UX checks on the built candidate. Retarget MCP to that server.
- For performance changes, measure representative GEV scenes on base and candidate
  separately, with matching browser, viewport, camera, layers, fixtures, warmup,
  and display refresh rate. Record FPS and frame-time distribution with MCP
  screenshots, screencasting, and intrusive tracing idle during the measurement.
  GPU access does not promise full or identical FPS; a synthetic probe capped at
  60 FPS cannot establish performance in a heavier scene or at a higher refresh.
- Record limitations honestly. Prefer another restricted GPU environment if
  hardware acceleration is unavailable; continue functional review with software
  rendering when useful and mark applicable GPU/performance checks unverified.

When finished, stop the MCP/browser/server processes, remove any relay and fresh
browser profile, preserve only intentional review evidence, and remove the
disposable checkout and installation cache when they are no longer needed.

References: [Bubblewrap](https://github.com/containers/bubblewrap),
[Chrome DevTools MCP configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md),
[WSLg container GPU setup](https://github.com/microsoft/wslg/blob/main/samples/container/Containers.md),
and [Docker Desktop GPU support](https://docs.docker.com/desktop/features/gpu/).
