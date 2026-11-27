#!/usr/bin/env bash
# =============================================================================
#  God's Eye View: Proxmox VE LXC installer (headless, native Node 24)
#
#  Creates an unprivileged Debian container, installs Node 24 and the app, and
#  runs it as a systemd service on port 4173. The globe renders in the browser
#  that opens it, so the container needs no GPU and no display.
#  Full guide: docs/PROXMOX.md
#
#  Run on a Proxmox VE node's shell as root:
#     bash gods-eye-view-lxc.sh
#
#  Every setting below can be overridden in front of the command, e.g.:
#     CTID=210 STORAGE=local-zfs ALLOWED_HOSTS=globe.lan \
#       TRUSTED_PEERS=192.168.1.50 bash gods-eye-view-lxc.sh
# =============================================================================
set -euo pipefail

# ---------- Defaults (override via env) --------------------------------------
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME_CT="${HOSTNAME_CT:-gods-eye-view}"
STORAGE="${STORAGE:-local-lvm}"          # rootfs storage
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
IP_CONFIG="${IP_CONFIG:-dhcp}"           # or e.g. 192.168.1.60/24,gw=192.168.1.1
CORES="${CORES:-2}"
MEMORY="${MEMORY:-2048}"                 # MB — npm ci + Vite's first optimise pass want ~1.5 GB
SWAP="${SWAP:-1024}"
DISK="${DISK:-10}"                       # GB — app ~1 GB + map/satellite cache grows over time
PORT="${PORT:-4173}"
ALLOWED_HOSTS="${ALLOWED_HOSTS:-}"       # optional: comma list of DNS names you'll browse to (e.g. globe.lan); IPs always work
TRUSTED_PEERS="${TRUSTED_PEERS:-}"       # optional: exact IPs of YOUR devices allowed to use Provider Settings (POWER UP)
TRUSTED_HOSTS="${TRUSTED_HOSTS:-}"       # optional: names/IPs those devices browse to; defaults to ALLOWED_HOSTS + the container's IP
DEBIAN_VERSION="${DEBIAN_VERSION:-12}"   # 12 works on every PVE 8.x; 13 needs a pve-container that knows its point release
SOURCE_REF="${SOURCE_REF:-main}"
REPO="https://github.com/bilawalsidhu/gods-eye-view.git"
APP_DIR="/opt/gods-eye-view"

# ---------- Pretty output -----------------------------------------------------
c_ok=$'\e[32m'; c_info=$'\e[36m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_off=$'\e[0m'
msg()  { echo "${c_info}==>${c_off} $*"; }
ok()   { echo "${c_ok}✔${c_off}  $*"; }
warn() { echo "${c_warn}!${c_off}  $*"; }
die()  { echo "${c_err}✘  $*${c_off}" >&2; exit 1; }

# ---------- Preflight ---------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Run as root on the Proxmox host."
command -v pct >/dev/null || die "pct not found — this must run on a Proxmox VE node."
pct status "$CTID" &>/dev/null && die "CTID $CTID already exists. Set CTID=<free id>."
pvesm status | awk 'NR>1{print $1}' | grep -qx "$STORAGE" || die "Storage '$STORAGE' not found on this node."

cat <<EOF

${c_info}God's Eye View: Proxmox LXC installer${c_off}
  Node:        $(hostname)
  CT ID:       $CTID   Hostname: $HOSTNAME_CT
  Resources:   ${CORES} cores, ${MEMORY} MB RAM (+${SWAP} swap), ${DISK} GB on ${STORAGE}
  Network:     ${BRIDGE}, ${IP_CONFIG}
  Port:        ${PORT}
  Host names:  ${ALLOWED_HOSTS:-<IP address only>}
  POWER UP:    ${TRUSTED_PEERS:-<off — keys go in .env>}

EOF
read -r -p "Proceed? [y/N] " yn; [[ "${yn,,}" == y* ]] || die "Aborted."

# ---------- Template ----------------------------------------------------------
msg "Finding Debian ${DEBIAN_VERSION} template…"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E "^debian-${DEBIAN_VERSION}-standard" | sort -V | tail -1)"
[[ -n "$TEMPLATE" ]] || die "No debian-${DEBIAN_VERSION}-standard template available."
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  msg "Downloading $TEMPLATE…"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
fi
ok "Template: $TEMPLATE"

# ---------- Create container --------------------------------------------------
msg "Creating unprivileged container $CTID…"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$HOSTNAME_CT" \
  --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=${IP_CONFIG}" \
  --features nesting=1 \
  --unprivileged 1 --onboot 1 \
  --tags "gods-eye-view;node" \
  --description "God's Eye View (headless). Web UI: http://<ip>:${PORT}  — app in ${APP_DIR}, keys in ${APP_DIR}/.env, update with: pct exec <id> -- /usr/local/bin/gev-update" \
  >/dev/null
pct start "$CTID"
ok "Container started"

msg "Waiting for network…"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- bash -c 'getent hosts deb.debian.org >/dev/null 2>&1' && break
  sleep 2
done
pct exec "$CTID" -- bash -c 'getent hosts deb.debian.org >/dev/null 2>&1' || die "Container has no DNS/network."

# ---------- Install inside the container --------------------------------------
msg "Installing Node 24, git, and God's Eye View (this takes a few minutes)…"
pct exec "$CTID" -- env \
  REPO="$REPO" SOURCE_REF="$SOURCE_REF" APP_DIR="$APP_DIR" PORT="$PORT" \
  ALLOWED_HOSTS="$ALLOWED_HOSTS" TRUSTED_PEERS="$TRUSTED_PEERS" TRUSTED_HOSTS="$TRUSTED_HOSTS" \
  bash -s <<'INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git >/dev/null
apt-get -y -qq upgrade >/dev/null

# Node 24 LTS from NodeSource (package.json requires >=24.14 <25 or 26.x)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
apt-get install -y -qq nodejs >/dev/null
echo "Node $(node -v), npm $(npm -v)"

# Dedicated service user — never run the key-brokering server as root
id gev &>/dev/null || useradd --system --create-home --home-dir /home/gev --shell /usr/sbin/nologin gev

git clone --depth 1 --branch "$SOURCE_REF" "$REPO" "$APP_DIR"
chown -R gev:gev "$APP_DIR"

# Skip Puppeteer's ~150 MB Chromium (only used by the QA scripts)
sudo_gev() { runuser -u gev -- env HOME=/home/gev PUPPETEER_SKIP_DOWNLOAD=1 "$@"; }
cd "$APP_DIR"
sudo_gev npm ci --no-audit --no-fund
sudo_gev npm run doctor || echo "(doctor reported warnings — review above; usually just missing optional keys)"

# Keys file (owner-only). Edit it later; the service restarts pick it up.
if [[ ! -f .env ]]; then
  cp .env.example .env
  chown gev:gev .env
  chmod 600 .env
fi

# Service environment (kept outside the repo so git pulls never clobber it)
mkdir -p /etc/gods-eye-view
{
  echo "HOST=0.0.0.0"
  echo "PORT=${PORT}"
  echo "PUPPETEER_SKIP_DOWNLOAD=1"
  if [[ -n "$ALLOWED_HOSTS" ]]; then echo "GEV_ALLOWED_HOSTS=${ALLOWED_HOSTS}"; fi
  if [[ -n "$TRUSTED_PEERS" ]]; then
    echo "GEV_KEY_SETUP_TRUSTED_PEERS=${TRUSTED_PEERS}"
    if [[ -z "$TRUSTED_HOSTS" ]]; then
      CT_ADDR="$(hostname -I | awk '{print $1}')"
      TRUSTED_HOSTS="${ALLOWED_HOSTS:+${ALLOWED_HOSTS},}${CT_ADDR}"
    fi
    echo "GEV_KEY_SETUP_TRUSTED_HOSTS=${TRUSTED_HOSTS}"
  fi
} > /etc/gods-eye-view/service.env
chmod 640 /etc/gods-eye-view/service.env
chgrp gev /etc/gods-eye-view/service.env

cat > /etc/systemd/system/gods-eye-view.service <<UNIT
[Unit]
Description=God's Eye View (Vite server + API proxies)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gev
Group=gev
WorkingDirectory=${APP_DIR}
Environment=HOME=/home/gev
EnvironmentFile=/etc/gods-eye-view/service.env
ExecStart=/usr/bin/npm run dev -- --host 0.0.0.0 --port ${PORT} --strictPort
Restart=on-failure
RestartSec=5
# Light hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${APP_DIR} /home/gev

[Install]
WantedBy=multi-user.target
UNIT

# One-command updater
cat > /usr/local/bin/gev-update <<'UPD'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/gods-eye-view
systemctl stop gods-eye-view
runuser -u gev -- git pull --ff-only
runuser -u gev -- env HOME=/home/gev PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund
rm -rf node_modules/.vite
systemctl start gods-eye-view
echo "Updated to $(runuser -u gev -- git log -1 --format='%h %s')"
UPD
chmod +x /usr/local/bin/gev-update

systemctl daemon-reload
systemctl enable --now gods-eye-view >/dev/null
INNER

# ---------- Wait for it to answer ---------------------------------------------
msg "Waiting for the app to come up (first start optimises dependencies)…"
UP=0
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- bash -c "curl -fsS -o /dev/null http://127.0.0.1:${PORT}/"; then UP=1; break; fi
  sleep 3
done

CT_IP="$(pct exec "$CTID" -- bash -c "hostname -I | awk '{print \$1}'")"

echo
if [[ $UP -eq 1 ]]; then ok "God's Eye View is running."; else warn "Not answering yet — check: pct exec $CTID -- journalctl -u gods-eye-view -f"; fi
cat <<EOF

  ${c_ok}Open:${c_off}        http://${CT_IP}:${PORT}
  ${c_ok}API keys:${c_off}    POWER UP from a TRUSTED_PEERS device, or:
               pct exec ${CTID} -- nano ${APP_DIR}/.env
               then: pct exec ${CTID} -- systemctl restart gods-eye-view
  ${c_ok}Logs:${c_off}        pct exec ${CTID} -- journalctl -u gods-eye-view -f
  ${c_ok}Update:${c_off}      pct exec ${CTID} -- /usr/local/bin/gev-update

  ${c_warn}Heads-up:${c_off} anyone who can reach this port can spend your configured API keys.
  Keep it on a network you trust (no public tunnel) and set billing caps with each provider.

EOF
