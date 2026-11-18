- Run God's Eye View headless on Proxmox VE: `scripts/proxmox-lxc.sh` creates
  an unprivileged Debian container, installs Node 24 and runs the app as a
  systemd service (docs/PROXMOX.md). Provider Settings can now be opened from
  the operator's own devices on such a server: `GEV_KEY_SETUP_TRUSTED_HOSTS`
  lists the exact names or addresses a `GEV_KEY_SETUP_TRUSTED_PEERS` device
  browses to, and loopback requests are unaffected (CaliMiller, #0000).
