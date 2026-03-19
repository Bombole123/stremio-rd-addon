# Stremio Real-Debrid Addon

Self-hosted Stremio addon that searches multiple torrent indexers, checks Real-Debrid cache availability, and streams cached torrents directly through Real-Debrid's CDN.

## Features

- Searches multiple torrent sources (TPB, EZTV, YTS, TorrentGalaxy, Knaben, Torrents-CSV, Zilean)
- Real-Debrid cache checking with local hash caching (6h TTL)
- Quality filtering (2160p, 1080p, 720p, 480p) with configurable sort priority
- Codec preference (x265/x264)
- File size limits
- Real-Debrid OAuth device code login
- SQLite torrent database for fast repeat lookups
- Runs as a systemd service with security hardening

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

- Open `https://stremio.yourdomain.com/configure`
- Add your Real-Debrid API token (or use the OAuth login)
- Set your tunnel URL in the config if it wasn't auto-detected

### 3. Install in Stremio

- On the configure page, click **"Install in Stremio"**
- Or manually add the manifest URL in Stremio: `https://stremio.yourdomain.com/manifest.json`

## Updating

```bash
cd /opt/stremio-addon && git pull && systemctl restart stremio-addon
```

Or from the Proxmox host:

```bash
pct exec <CTID> -- bash -c 'cd /opt/stremio-addon && git pull && systemctl restart stremio-addon'
```

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
```

## Configuration

All settings are managed through the web UI at `/configure`:

- **Sort priority** — order of: quality, language, size, seeders, codec, source
- **Max per quality** — max streams shown per quality tier (default: 5)
- **Qualities** — enable/disable 2160p, 1080p, 720p, 480p
- **Preferred codec** — all, x265, or x264
- **Max file size** — limit in GB (0 = unlimited)

Config is stored in `/opt/stremio-addon/config.local.json`.
