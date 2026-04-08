const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TORRENTIO_BASE = 'https://torrentio.strem.fun';
const TIMEOUT_MS = 8000;

/**
 * Parse a human-readable size string like "15.2 GB" or "800 MB" into bytes.
 */
function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    switch (unit) {
        case 'TB': return Math.round(num * 1024 * 1024 * 1024 * 1024);
        case 'GB': return Math.round(num * 1024 * 1024 * 1024);
        case 'MB': return Math.round(num * 1024 * 1024);
        case 'KB': return Math.round(num * 1024);
        default: return 0;
    }
}

/**
 * Parse a Torrentio stream object into our standard torrent format.
 * Torrentio's `title` field typically looks like:
 *   "Torrent.Name.2024.1080p.WEB-DL.x264\n👤 125 💾 4.2 GB ⚙️ YTS"
 * Some variants use `description` instead of `title`.
 */
function parseStream(stream) {
    // Skip streams without infoHash (direct debrid links)
    if (!stream.infoHash) return null;

    const descField = stream.title || stream.description || '';
    const lines = descField.split('\n').map(l => l.trim()).filter(Boolean);

    // First line is the torrent filename/title
    const torrentTitle = lines[0] || '';

    // Parse metadata from remaining lines
    let seeds = 0;
    let size = 0;
    let source = 'Torrentio';

    for (const line of lines) {
        // Seeds: 👤 NNN
        const seedMatch = line.match(/👤\s*(\d+)/);
        if (seedMatch) seeds = parseInt(seedMatch[1], 10);

        // Size: 💾 X.X GB
        const sizeMatch = line.match(/💾\s*([\d.]+\s*[TGMK]B)/i);
        if (sizeMatch) size = parseSize(sizeMatch[1]);

        // Source: ⚙️ SourceName
        const sourceMatch = line.match(/⚙️\s*(.+)/);
        if (sourceMatch) source = sourceMatch[1].trim();
    }

    return {
        hash: stream.infoHash.toLowerCase(),
        title: torrentTitle,
        size,
        seeds,
        source,
        ...(stream.fileIdx != null ? { fileIdx: stream.fileIdx } : {}),
    };
}

/**
 * Query Torrentio's stream endpoint for a given movie or series episode.
 * Returns an array of {hash, title, size, seeds, source, fileIdx} objects.
 * Returns empty array on any error.
 */
async function searchTorrentio(type, imdbId, season, episode) {
    try {
        // Build the Stremio stream ID
        let id = imdbId;
        if (type === 'series' && season != null && episode != null) {
            id = `${imdbId}:${season}:${episode}`;
        }

        const url = `${TORRENTIO_BASE}/stream/${type}/${id}.json`;
        console.log(`[torrentio] Fetching: ${url}`);

        const res = await fetch(url, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!res.ok) {
            console.warn(`[torrentio] HTTP ${res.status} for ${id}`);
            return [];
        }

        const data = await res.json();
        const streams = data.streams || [];

        const results = [];
        for (const stream of streams) {
            const parsed = parseStream(stream);
            if (parsed) results.push(parsed);
        }

        console.log(`[torrentio] Found ${results.length} torrents for ${id} (from ${streams.length} streams)`);
        return results;
    } catch (err) {
        console.error(`[torrentio] Error:`, err.message);
        return [];
    }
}

module.exports = { searchTorrentio };
