# Stremio Real-Debrid Addon

Self-hosted Stremio addon that searches multiple torrent indexers, checks Real-Debrid cache availability, and streams cached torrents directly through Real-Debrid's CDN.

## Features

- **Multi-user support** — each user authenticates via OAuth and gets a unique addon URL; RD tokens are stored server-side, never exposed in URLs
- **Season pack intelligence** — detects cached season packs on RD and reuses them for all episodes, giving instant playback
- **Next-episode pre-resolve** — automatically pre-resolves the next episode in the background for seamless binge-watching
- **7 torrent sources** — TPB, EZTV, YTS, TorrentGalaxy, Knaben, Torrents-CSV, Zilean (with smart source weighting)
- **Source reliability tracking** — automatically disables failing indexers and re-enables them after 10 minutes
- **RD API retry with backoff** — handles rate limits gracefully with exponential backoff
- **Auto-refresh OAuth tokens** — tokens refresh transparently when they expire
- **Quality filtering** — 2160p, 1080p, 720p, 480p with configurable sort priority
- **Language filter** — filter streams by English, Multi/Dual Audio, or all languages
- **Codec preference** — x265/x264 filtering using parsed torrent metadata
- **TMDB metadata fallback** — falls back to TMDB API when Cinemeta is unavailable
- **Status dashboard** — `/status` page showing RD account info, source health, and cache stats
- **Auto-update** — daily updates at 4am EST via systemd timer
- **Mobile-friendly** — configure page works on phones and tablets
- **SQLite caching** — torrent database with optimized indexes for fast repeat lookups
- **Security hardening** — runs as unprivileged systemd service with strict filesystem protections

## One-Command Install (Proxmox)

Run this on your **Proxmox host** — it creates a Debian 12 LXC container with everything configured:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/Bombole123/stremio-rd-addon/main/setup-lxc.sh)"
```

### Customize the container

Override defaults with environment variables:

```bash
CTID=200 CT_RAM=1024 CT_DISK=8 bash -c "$(wget -qLO - https://raw.githubusercontent.com/Bombole123/stremio-rd-addon/main/setup-lxc.sh)"
```

| Variable | Default | Description |
|---|---|---|
| `CTID` | next available | Container ID |
| `CT_HOSTNAME` | `stremio-addon` | Container hostname |
| `CT_CORES` | `1` | CPU cores |
| `CT_RAM` | `512` | RAM in MB |
| `CT_DISK` | `4` | Disk size in GB |
| `CT_STORAGE` | `local-lvm` | Proxmox storage |
| `CT_BRIDGE` | `vmbr0` | Network bridge |

## Setup

### 1. Set up a Cloudflare Tunnel

The addon needs a public HTTPS URL so Stremio can reach it from any device. Cloudflare Tunnel does this for free without opening ports on your network.

**a) Create a Cloudflare account and add your domain**

- Sign up at [dash.cloudflare.com](https://dash.cloudflare.com)
- Add your domain and update your registrar's nameservers to Cloudflare's (shown during setup)

**b) Install `cloudflared` on the Proxmox host**

```bash
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared-linux-amd64.deb
```

**c) Authenticate with Cloudflare**

```bash
cloudflared tunnel login
```

This opens a browser. Select your domain to authorize.

**d) Create the tunnel**

```bash
cloudflared tunnel create stremio-addon
```

Note the **Tunnel ID** from the output.

**e) Create the config file**

```bash
mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml <<EOF
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: stremio.yourdomain.com
    service: http://<CONTAINER_IP>:7000
  - service: http_status:404
EOF
```

Replace `<TUNNEL_ID>`, `<CONTAINER_IP>` (your LXC IP), and `stremio.yourdomain.com` with your actual values.

**f) Create the DNS record**

```bash
cloudflared tunnel route dns stremio-addon stremio.yourdomain.com
```

**g) Install as a service and start**

```bash
cloudflared service install
systemctl start cloudflared
systemctl enable cloudflared
```

Your addon is now accessible at `https://stremio.yourdomain.com`.

### 2. Configure the addon

1. Open `https://stremio.yourdomain.com/configure`
2. Click **"Login with Real-Debrid"** and authorize on the RD website
3. After login, you'll see your personal addon URL — click **"Install in Stremio"**

Each user who authenticates gets their own unique URL. RD tokens are stored securely on the server, never exposed in URLs.

### 3. Multi-user setup

Multiple people can use the same addon instance with their own RD accounts:

1. Each person visits `/configure` and authenticates with their RD account
2. They get a unique addon URL: `https://stremio.yourdomain.com/<user-id>/manifest.json`
3. Each person's streams resolve through their own RD account independently

The legacy single-user setup (token in `config.local.json`) still works as a fallback.

## Updating

The addon auto-updates daily at **4:00 AM EST**. Updates won't interrupt active streams since Stremio streams directly from Real-Debrid's CDN.

To update manually:

```bash
cd /opt/stremio-addon && git pull && systemctl restart stremio-addon
```

Or from the Proxmox host:

```bash
pct exec <CTID> -- bash -c 'cd /opt/stremio-addon && git pull && systemctl restart stremio-addon'
```

Check auto-update status:

```bash
systemctl status stremio-update.timer
journalctl -t stremio-update --no-pager -n 20
```

## Status Dashboard

Visit `/status` in a browser to see:

- Addon version and uptime
- Real-Debrid account info (username, premium expiry)
- Torrent source health (up/down, response times, success rates)
- Registered users

Also available as JSON: `curl https://stremio.yourdomain.com/status`

## Useful Commands

```bash
# Shell into the container
pct enter <CTID>

# Live logs
journalctl -u stremio-addon -f

# Restart the addon
systemctl restart stremio-addon

# Check status
systemctl status stremio-addon

# Check auto-update timer
systemctl status stremio-update.timer
```

## Configuration

All settings are managed through the web UI at `/configure`:

- **Sort priority** — order of: quality, language, size, seeders, codec, source
- **Max per quality** — max streams shown per quality tier (default: 5)
- **Qualities** — enable/disable 2160p, 1080p, 720p, 480p
- **Language filter** — all languages, English only, or Multi/Dual Audio
- **Preferred codec** — all, x265, or x264
- **Max file size** — limit in GB (0 = unlimited)

### Optional: TMDB fallback

If Cinemeta (Stremio's metadata service) goes down, the addon can fall back to TMDB for title lookups. To enable, get a free API key from [themoviedb.org](https://www.themoviedb.org/settings/api) and add it to your config:

```bash
# Inside the LXC container
cd /opt/stremio-addon
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('config.local.json'));
  cfg.tmdbApiKey = 'YOUR_TMDB_API_KEY';
  fs.writeFileSync('config.local.json', JSON.stringify(cfg, null, 4));
"
systemctl restart stremio-addon
```

### Advanced: Tunable thresholds

All performance thresholds are configurable in `src/config.js`:

| Threshold | Default | Description |
|---|---|---|
| `searchTimeout` | 10s | Per-indexer fetch timeout |
| `searchGlobalTimeout` | 15s | Max total search time (returns partial results) |
| `rdApiTimeout` | 15s | Real-Debrid API timeout |
| `rdRetryDelayMs` | 1s | Initial retry delay on rate limits |
| `rdMaxRetries` | 3 | Max retries on rate limit |
| `magnetCheckDelay` | 300ms | Delay between cache checks |
| `magnetCheckLimit` | 10 | Max hashes for cache check |
| `zileanSeedBoost` | 50 | Synthetic seed count for Zilean results |
