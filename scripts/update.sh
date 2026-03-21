#!/bin/bash
# Auto-update Stremio addon from GitHub
set -e

APP_DIR="/opt/stremio-addon"
SERVICE="stremio-addon"
LOG_TAG="stremio-update"

logger -t "$LOG_TAG" "Starting auto-update..."

cd "$APP_DIR"

# Fetch latest changes
git fetch origin main --quiet

# Check if there are updates
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    logger -t "$LOG_TAG" "Already up to date ($LOCAL)"
    exit 0
fi

logger -t "$LOG_TAG" "Updating from $LOCAL to $REMOTE"

# Pull updates
git pull origin main --quiet

# Reinstall deps if package.json changed
if git diff "$LOCAL" "$REMOTE" --name-only | grep -q "package.json"; then
    logger -t "$LOG_TAG" "package.json changed, running npm install..."
    npm install --omit=dev --quiet 2>&1 | logger -t "$LOG_TAG"
fi

# Restart service
systemctl restart "$SERVICE"

logger -t "$LOG_TAG" "Update complete. Now running $(git rev-parse --short HEAD)"
