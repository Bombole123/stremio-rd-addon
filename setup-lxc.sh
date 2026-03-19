#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────
# Stremio Real-Debrid Addon — Proxmox LXC One-Command Setup
#
# Run on the Proxmox host:
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/YOURUSER/YOURREPO/main/setup-lxc.sh)"
# ─────────────────────────────────────────────────────────────

# ── Defaults (override via environment) ──────────────────────
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME="${CT_HOSTNAME:-stremio-addon}"
CORES="${CT_CORES:-1}"
RAM="${CT_RAM:-512}"
DISK="${CT_DISK:-4}"
STORAGE="${CT_STORAGE:-local-lvm}"
BRIDGE="${CT_BRIDGE:-vmbr0}"
REPO_URL="https://github.com/Bombole123/stremio-rd-addon.git"

header() {
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  Stremio Real-Debrid Addon — LXC Installer       ║"
    echo "╠══════════════════════════════════════════════════╣"
    echo "║  Container ID: ${CTID}                              ║"
    echo "║  Hostname:     ${HOSTNAME}                     ║"
    echo "║  Resources:    ${CORES} CPU / ${RAM}MB RAM / ${DISK}GB Disk   ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo ""
}

# ── Ensure we're on a Proxmox host ───────────────────────────
if ! command -v pct &>/dev/null; then
    echo "ERROR: This script must be run on a Proxmox VE host."
    exit 1
fi

header

# ── 1. Download Debian 12 template if needed ─────────────────
echo "[1/5] Preparing Debian 12 template..."
TEMPLATE_STORAGE="local"
TEMPLATE=$(pveam available --section system | grep 'debian-12-standard' | sort -t_ -k2 -V | tail -1 | awk '{print $2}')

if [ -z "$TEMPLATE" ]; then
    echo "ERROR: Could not find Debian 12 template"
    exit 1
fi

TEMPLATE_PATH="/var/lib/vz/template/cache/${TEMPLATE}"
if [ ! -f "$TEMPLATE_PATH" ]; then
    echo "     Downloading ${TEMPLATE}..."
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
else
    echo "     Template already downloaded"
fi

# ── 2. Create the LXC container ─────────────────────────────
echo "[2/5] Creating LXC container ${CTID}..."

if pct status "$CTID" &>/dev/null; then
    echo "ERROR: Container ${CTID} already exists. Set a different ID:"
    echo "  CTID=201 bash -c \"\$(wget -qLO - ...)\""
    exit 1
fi

pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
    --hostname "$HOSTNAME" \
    --cores "$CORES" \
    --memory "$RAM" \
    --swap 256 \
    --rootfs "${STORAGE}:${DISK}" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp,type=veth" \
    --unprivileged 1 \
    --features "nesting=1" \
    --onboot 1 \
    --ostype debian \
    --start 0

# ── 3. Start container and wait for network ──────────────────
echo "[3/5] Starting container..."
pct start "$CTID"

echo "     Waiting for network..."
for i in $(seq 1 30); do
    if pct exec "$CTID" -- ping -c1 -W1 8.8.8.8 &>/dev/null; then
        break
    fi
    sleep 1
done

# Get the container IP
CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
echo "     Container IP: ${CT_IP:-unknown}"

# ── 4. Install everything inside the container ───────────────
echo "[4/5] Installing Stremio addon (this takes 1-2 minutes)..."

pct exec "$CTID" -- bash -c '
set -e

APP_DIR="/opt/stremio-addon"
NODE_MAJOR=22
PORT=7000

# System packages
apt-get update -qq
apt-get install -y -qq curl gnupg build-essential python3 git ca-certificates > /dev/null 2>&1

# Node.js
curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs > /dev/null 2>&1

# Create app user
useradd -r -s /usr/sbin/nologin -d "$APP_DIR" stremio
mkdir -p "$APP_DIR"

# Clone the addon (keep .git for easy updates via git pull)
git clone '"$REPO_URL"' "$APP_DIR" 2>/dev/null
cd "$APP_DIR"

# Install npm dependencies
npm install --omit=dev --quiet 2>&1

# Create empty config
echo "{}" > "$APP_DIR/config.local.json"
mkdir -p "$APP_DIR/data"

# Update hostIP
HOST_IP=$(hostname -I | awk "{print \$1}")
APP_DIR="$APP_DIR" HOST_IP="$HOST_IP" node -e "
    const fs = require(\"fs\");
    const p = process.env.APP_DIR + \"/config.local.json\";
    const cfg = { hostIP: process.env.HOST_IP };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 4) + \"\\n\");
"

# Set permissions
chown -R stremio:stremio "$APP_DIR"

# Create systemd service
NODE_BIN=$(which node)
cat > /etc/systemd/system/stremio-addon.service <<SVCEOF
[Unit]
Description=Stremio Real-Debrid Addon
After=network.target

[Service]
Type=simple
User=stremio
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=${PORT}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=stremio-addon
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/config.local.json
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SVCEOF

# Cap journal logs at 100MB to prevent disk fill
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/size-limit.conf <<JEOF
[Journal]
SystemMaxUse=100M
JEOF
systemctl restart systemd-journald

systemctl daemon-reload
systemctl enable stremio-addon --quiet
systemctl start stremio-addon
'

# ── 5. Verify ────────────────────────────────────────────────
echo "[5/5] Verifying..."
sleep 3

CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
SERVICE_OK=$(pct exec "$CTID" -- systemctl is-active stremio-addon 2>/dev/null || true)

if [ "$SERVICE_OK" = "active" ]; then
    echo ""
    echo "════════════════════════════════════════════════════"
    echo "  Installation complete!"
    echo ""
    echo "  Container:  ${CTID} (${HOSTNAME})"
    echo "  Addon URL:  http://${CT_IP}:7000"
    echo "  Configure:  http://${CT_IP}:7000/configure"
    echo ""
    echo "  Commands:"
    echo "    pct enter ${CTID}                           (shell into container)"
    echo "    pct exec ${CTID} -- journalctl -u stremio-addon -f  (live logs)"
    echo "    pct exec ${CTID} -- systemctl restart stremio-addon (restart)"
    echo ""
    echo "  Update:"
    echo "    pct exec ${CTID} -- bash -c 'cd /opt/stremio-addon && git pull && systemctl restart stremio-addon'"
    echo ""
    echo "  Next steps:"
    echo "    1. Point Cloudflare tunnel to ${CT_IP}:7000"
    echo "    2. Open /configure and add your Real-Debrid API token"
    echo "    3. Install in Stremio via the configure page"
    echo "════════════════════════════════════════════════════"
else
    echo ""
    echo "  WARNING: Service failed to start!"
    echo "  Debug: pct exec ${CTID} -- journalctl -u stremio-addon -n 50"
    exit 1
fi
