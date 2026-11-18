# Running God's Eye View on Proxmox VE

`scripts/proxmox-lxc.sh` installs God's Eye View headless in its own Proxmox
container (LXC). The server is a Node process; the 3D globe is drawn by the
browser that opens it. The container therefore needs no GPU, no display and
no GPU passthrough, and any node in a cluster can host it. Put it on a node
that stays up rather than on one that is rebooted into other operating systems.

## What the script does

On the Proxmox node, it:

1. Downloads the Debian 12 container template if it is not already present.
2. Creates an unprivileged container (2 cores, 2 GB RAM, 1 GB swap, 10 GB disk)
   that starts on boot.
3. Installs Node 24 from NodeSource, clones this repository into
   `/opt/gods-eye-view` and runs `npm ci` and `npm run doctor`. It skips
   Puppeteer's Chromium download, which only the QA scripts use.
4. Runs the app as the unprivileged `gev` user through the `gods-eye-view`
   systemd service, bound to all interfaces on port 4173.
5. Copies `.env.example` to `.env` (mode `600`) for your keys, and installs a
   `gev-update` command.

Service settings live in `/etc/gods-eye-view/service.env`, outside the
checkout, so updates never overwrite them.

## Install

Copy the script to a Proxmox node and run it from that node's shell as root:

```bash
bash proxmox-lxc.sh
```

It shows a summary and asks before it changes anything. When it finishes, it
prints the address to open, for example `http://192.168.1.60:4173`.

Override any default by setting it in front of the command:

| Variable         | Default                     | Meaning                                                                                       |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `CTID`           | next free ID in the cluster | Container ID                                                                                  |
| `HOSTNAME_CT`    | `gods-eye-view`             | Container hostname                                                                            |
| `STORAGE`        | `local-lvm`                 | Storage for the container's disk                                                              |
| `TEMPLATE_STORAGE` | `local`                   | Storage for the downloaded template                                                           |
| `BRIDGE`         | `vmbr0`                     | Network bridge                                                                                |
| `IP_CONFIG`      | `dhcp`                      | Or a static address, e.g. `192.168.1.60/24,gw=192.168.1.1`                                    |
| `CORES` / `MEMORY` / `SWAP` / `DISK` | `2` / `2048` / `1024` / `10` | CPU cores, RAM and swap in MB, disk in GB                                 |
| `PORT`           | `4173`                      | Port the app listens on                                                                       |
| `DEBIAN_VERSION` | `12`                        | Template release; `13` needs a `pve-container` that recognises the template's point release   |
| `SOURCE_REF`     | `main`                      | Branch or tag to clone                                                                        |
| `ALLOWED_HOSTS`  | none                        | Host names you will type in the browser, comma-separated (becomes `GEV_ALLOWED_HOSTS`)        |
| `TRUSTED_PEERS`  | none                        | IP addresses of your own devices allowed to use Provider Settings (POWER UP)                  |
| `TRUSTED_HOSTS`  | `ALLOWED_HOSTS` plus the container's IP | Names or IPs those devices use to reach the app                                  |

Give the container a static address or a DHCP reservation, and do the same
for every device listed in `TRUSTED_PEERS`: both lists hold exact addresses.

If `pct create` stops with `unsupported debian version`, the template is newer
than the node's container tooling. Use the default Debian 12 template, or
update the node and try again.

## Browsing by name

IP addresses always pass the app's Host check. To open it by a name such as
`http://globe.lan:4173`, that name must be in `GEV_ALLOWED_HOSTS`; otherwise
the server answers `Blocked request. This host is not allowed.` Set
`ALLOWED_HOSTS` at install time, or edit the service settings later (below).

## API keys

The app starts without keys. You can add them in either of two ways.

**Edit `.env`** from the Proxmox node:

```bash
pct exec <CTID> -- nano /opt/gods-eye-view/.env
pct exec <CTID> -- systemctl restart gods-eye-view
```

**Use Provider Settings (POWER UP)** from your own device. Provider Settings
normally answers only the machine running the server, and a headless
container has no browser of its own. Two settings open it to devices you name:

- `GEV_KEY_SETUP_TRUSTED_PEERS`: exact IP addresses of your devices.
- `GEV_KEY_SETUP_TRUSTED_HOSTS`: the exact names or IP addresses those devices
  use to reach the server. These names count only for a request from a listed
  device; a request from anywhere else, or one using another name, is still
  refused. The Origin, Content-Type, proxy-header and sharing checks all
  still apply.

The installer writes both when you pass `TRUSTED_PEERS`. Any device you list
can read which keys are set and replace them, so list only your own devices.

## Changing settings after install

```bash
pct exec <CTID> -- nano /etc/gods-eye-view/service.env
pct exec <CTID> -- systemctl restart gods-eye-view
```

A complete file looks like this:

```dotenv
HOST=0.0.0.0
PORT=4173
PUPPETEER_SKIP_DOWNLOAD=1
GEV_ALLOWED_HOSTS=globe.lan
GEV_KEY_SETUP_TRUSTED_PEERS=192.168.1.46,192.168.1.50
GEV_KEY_SETUP_TRUSTED_HOSTS=globe.lan,192.168.1.60
```

All three host settings take exact entries separated by commas: no ports,
wildcards, suffixes or address ranges. Device names do not work in
`GEV_KEY_SETUP_TRUSTED_PEERS`; it compares the address a request arrives from.
Over a VPN such as Tailscale, that is the device's VPN address, and the name or
address it browses to belongs in the two host lists.

## Updating, logs and removal

```bash
pct exec <CTID> -- gev-update                       # pull, reinstall dependencies, restart
pct exec <CTID> -- journalctl -u gods-eye-view -f   # follow the logs
pct stop <CTID> && pct destroy <CTID>               # remove the container entirely
```

Your keys (`.env`) and the data cache (`.gev-cache/`) live in
`/opt/gods-eye-view` and survive updates. Proxmox backups of the container
include them.

## Security

The server spends your configured API keys for anyone who can reach it (see
[SECURITY.md](../SECURITY.md#network-exposure--the-operator-threat-model)).
Keep the container on a network you trust, do not publish it through a public
tunnel, and set spending limits with each provider that bills you. The app's
own rate limits are not billing caps.
