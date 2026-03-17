#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────
# Stremio Real-Debrid Addon — One-command installer for Debian
# Usage: bash install.sh
# ─────────────────────────────────────────────────────────────

APP_DIR="/opt/stremio-addon"
APP_USER="stremio"
SERVICE_NAME="stremio-addon"
NODE_MAJOR=22
PORT=7000

echo "╔══════════════════════════════════════════════╗"
echo "║  Stremio Real-Debrid Addon Installer         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. System packages ───────────────────────────────────────
echo "[1/7] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl gnupg build-essential python3 git ca-certificates > /dev/null

# ── 2. Node.js ───────────────────────────────────────────────
if ! command -v node &> /dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]; then
    echo "[2/7] Installing Node.js ${NODE_MAJOR}..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null
else
    echo "[2/7] Node.js $(node -v) already installed"
fi
NODE_BIN="$(which node)"

# ── 3. Create app user ───────────────────────────────────────
echo "[3/7] Setting up app user and directory..."
if ! id "$APP_USER" &>/dev/null; then
    useradd -r -s /usr/sbin/nologin -m -d "$APP_DIR" "$APP_USER"
else
    echo "     User '$APP_USER' already exists"
fi
mkdir -p "$APP_DIR/data"

# ── 4. Copy application ──────────────────────────────────────
echo "[4/7] Installing application..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Copy source files
cp -r "$SCRIPT_DIR/src" "$APP_DIR/"
cp "$SCRIPT_DIR/package.json" "$APP_DIR/"
cp "$SCRIPT_DIR/package-lock.json" "$APP_DIR/" 2>/dev/null || true

# Copy config if it exists (won't overwrite on re-install)
if [ ! -f "$APP_DIR/config.local.json" ] && [ -f "$SCRIPT_DIR/config.local.json" ]; then
    cp "$SCRIPT_DIR/config.local.json" "$APP_DIR/"
fi
# Ensure config file exists for systemd ReadWritePaths
touch "$APP_DIR/config.local.json"

# Copy .env.example as reference
cp "$SCRIPT_DIR/.env.example" "$APP_DIR/" 2>/dev/null || true

# Install npm dependencies
cd "$APP_DIR"
npm install --omit=dev --quiet 2>&1 || { echo "npm install failed"; exit 1; }

# ── 5. Detect LXC IP ─────────────────────────────────────────
echo "[5/7] Detecting network configuration..."
HOST_IP=$(hostname -I | awk '{print $1}')

# Update hostIP in config.local.json
APP_DIR="$APP_DIR" HOST_IP="$HOST_IP" node -e "
    const fs = require('fs');
    const p = process.env.APP_DIR + '/config.local.json';
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    cfg.hostIP = process.env.HOST_IP;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 4) + '\n');
"

echo "     LXC IP: $HOST_IP"

# ── 6. Set permissions ────────────────────────────────────────
echo "[6/7] Setting permissions..."
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 7. Create systemd service ────────────────────────────────
echo "[7/7] Creating systemd service..."
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Stremio Real-Debrid Addon
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=${PORT}

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/config.local.json
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" --quiet
systemctl restart "$SERVICE_NAME"

# ── Verify ────────────────────────────────────────────────────
for i in 1 2 3 4 5; do
    systemctl is-active --quiet "$SERVICE_NAME" && break
    sleep 1
done

if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo ""
    echo "════════════════════════════════════════════════"
    echo "  Installation complete!"
    echo ""
    echo "  Addon running at: http://${HOST_IP}:${PORT}"
    echo "  Configure:        http://${HOST_IP}:${PORT}/configure"
    echo ""
    echo "  Service commands:"
    echo "    systemctl status  ${SERVICE_NAME}"
    echo "    systemctl restart ${SERVICE_NAME}"
    echo "    journalctl -u ${SERVICE_NAME} -f    (live logs)"
    echo ""
    echo "  Next steps:"
    echo "    1. Set up Cloudflare tunnel pointing to ${HOST_IP}:${PORT}"
    echo "    2. Open /configure and set your RD API token"
    echo "    3. Install in Stremio via the configure page"
    echo "════════════════════════════════════════════════"
else
    echo ""
    echo "  WARNING: Service failed to start!"
    echo "  Check logs: journalctl -u ${SERVICE_NAME} -n 50"
    exit 1
fi
