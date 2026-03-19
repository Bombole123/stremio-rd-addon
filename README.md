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

After installation:

1. Point a Cloudflare tunnel (or reverse proxy) to `<container-ip>:7000`
2. Open `http://<container-ip>:7000/configure` to add your Real-Debrid API token
3. Click "Install in Stremio" on the configure page

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
