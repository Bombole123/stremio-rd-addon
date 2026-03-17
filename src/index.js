const express = require('express');
const cors = require('cors');
const manifest = require('./manifest');
const config = require('./config');
const streamHandler = require('./handlers/stream');
const rd = require('./lib/realDebrid');
const { VIDEO_EXTENSIONS } = require('./lib/titleMatcher');
const { parseEpisodeFromPath } = require('./lib/nameParser');
const { computeOpenSubHash } = require('./lib/opensubHash');
const { getVideoHash, setVideoHash } = require('./lib/torrentDb');

const app = express();
app.use(cors());
app.use(express.json());

// Log all incoming requests
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip}`);
    next();
});

// Single-flight map: deduplicates concurrent resolve requests for the same hash+episode
const pendingResolves = new Map();

// Cache resolved download URLs — avoids re-unrestricting on repeated requests from same playback
// Key: resolveKey, Value: { url, expiry }
const resolvedUrlCache = new Map();
const RESOLVE_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// Clean up expired entries every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of resolvedUrlCache) {
        if (value.expiry < now) resolvedUrlCache.delete(key);
    }
}, 30 * 60 * 1000);

// Core resolve logic — returns the download URL string or throws
async function resolveHash(rdToken, hash, type, season, episode) {
    // Check if hash already in user's RD library
    let torrentId = null;
    const existing = await rd.getAllTorrents(rdToken);
    for (const t of existing) {
        if (t.hash && t.hash.toLowerCase() === hash.toLowerCase()) {
            torrentId = t.id;
            break;
        }
    }

    // Add magnet if not found
    if (!torrentId) {
        const added = await rd.addMagnet(rdToken, `magnet:?xt=urn:btih:${hash}`);
        if (!added || !added.id) {
            throw new Error('Failed to add magnet');
        }
        torrentId = added.id;
    }

    // Get torrent info
    let info = await rd.getTorrentInfo(rdToken, torrentId, true);

    // Select files if needed
    if (info.status === 'waiting_files_selection') {
        const videoFiles = (info.files || []).filter(f => VIDEO_EXTENSIONS.test(f.path));
        if (videoFiles.length > 0) {
            await rd.selectFiles(rdToken, torrentId, videoFiles.map(f => f.id).join(','));
        } else {
            await rd.selectFiles(rdToken, torrentId, 'all');
        }
        info = await rd.getTorrentInfo(rdToken, torrentId, true);
    }

    if (!info.links || info.links.length === 0) {
        throw new Error('No links available');
    }

    // Map selected files to links
    const selectedFiles = (info.files || [])
        .filter(f => f.selected === 1)
        .sort((a, b) => a.id - b.id);

    let targetFiles = selectedFiles.filter(f => VIDEO_EXTENSIONS.test(f.path));

    // For series: match the right episode
    if (type === 'series' && season && episode) {
        const s = parseInt(season, 10);
        const e = parseInt(episode, 10);
        const episodeFiles = targetFiles.filter(f => {
            const ep = parseEpisodeFromPath(f.path);
            return ep.season === s && ep.episode === e;
        });
        if (episodeFiles.length > 0) {
            targetFiles = episodeFiles;
        } else if (targetFiles.length > 1) {
            // Season pack but no episode match — don't play wrong episode
            throw new Error('Episode not found in season pack');
        }
    }

    if (targetFiles.length === 0) {
        throw new Error('No matching video file found');
    }

    // Pick the largest video file
    const targetFile = targetFiles.reduce((best, f) =>
        (f.bytes || 0) > (best.bytes || 0) ? f : best
    );

    const linkIndex = selectedFiles.findIndex(f => f.id === targetFile.id);
    if (linkIndex === -1 || linkIndex >= info.links.length) {
        throw new Error('Could not map file to link');
    }

    // Unrestrict and return download URL
    const unrestricted = await rd.unrestrictLink(rdToken, info.links[linkIndex]);
    if (!unrestricted || !unrestricted.download) {
        throw new Error('Failed to unrestrict link');
    }

    rd.markHashCached(hash);
    return { url: unrestricted.download, fileSize: targetFile.bytes || 0 };
}

// Resolve + redirect route — resolves and 302 redirects to RD CDN
app.get('/resolve/:hash', async (req, res) => {
    const { hash } = req.params;
    const { type, season, episode } = req.query;
    const rdToken = config.rdApiToken;

    if (!rdToken) {
        return res.status(503).send('No Real-Debrid token configured');
    }

    const resolveKey = `${hash}:${type || ''}:${season || ''}:${episode || ''}`;

    try {
        let downloadUrl;
        let fileSize = 0;
        const cached = resolvedUrlCache.get(resolveKey);
        if (cached && cached.expiry > Date.now()) {
            downloadUrl = cached.url;
            fileSize = cached.fileSize || 0;
        } else {
            if (!pendingResolves.has(resolveKey)) {
                pendingResolves.set(resolveKey, resolveHash(rdToken, hash, type, season, episode));
            }
            const result = await pendingResolves.get(resolveKey);
            pendingResolves.delete(resolveKey);
            downloadUrl = result.url;
            fileSize = result.fileSize || 0;
            resolvedUrlCache.set(resolveKey, { url: downloadUrl, fileSize, expiry: Date.now() + RESOLVE_CACHE_TTL });
        }

        // Compute OpenSubtitles hash in background (for behaviorHints on next listing)
        const hashKey = `${hash}:${season || ''}:${episode || ''}`;
        if (fileSize > 0 && !getVideoHash(hashKey)) {
            computeOpenSubHash(downloadUrl, fileSize)
                .then((osHash) => {
                    if (osHash) {
                        setVideoHash(hashKey, osHash, fileSize);
                        console.log(`[resolve] Cached OpenSub hash for ${hashKey}: ${osHash}`);
                    }
                })
                .catch((err) => console.error('[resolve] OpenSub hash error:', err.message));
        }

        // 302 redirect — player connects directly to RD CDN
        res.redirect(302, downloadUrl);
    } catch (err) {
        pendingResolves.delete(resolveKey);
        if (err.name === 'AbortError') return;
        console.error(`[resolve] Error:`, err.cause ? `${err.message} - ${err.cause.message}` : err.message);
        if (!res.headersSent) {
            res.status(502).send(`Resolve failed: ${err.message}`);
        }
    }
});

// HEAD handler for /resolve/:hash — Stremio sends HEAD to check the stream before playing
app.head('/resolve/:hash', async (req, res) => {
    const { hash } = req.params;
    const { type, season, episode } = req.query;
    const rdToken = config.rdApiToken;

    if (!rdToken) return res.status(503).end();

    const resolveKey = `${hash}:${type || ''}:${season || ''}:${episode || ''}`;

    try {
        let downloadUrl;
        const cached = resolvedUrlCache.get(resolveKey);
        if (cached && cached.expiry > Date.now()) {
            downloadUrl = cached.url;
        } else {
            if (!pendingResolves.has(resolveKey)) {
                pendingResolves.set(resolveKey, resolveHash(rdToken, hash, type, season, episode));
            }
            const result = await pendingResolves.get(resolveKey);
            pendingResolves.delete(resolveKey);
            downloadUrl = result.url;
            resolvedUrlCache.set(resolveKey, { url: downloadUrl, fileSize: result.fileSize || 0, expiry: Date.now() + RESOLVE_CACHE_TTL });
        }

        res.redirect(302, downloadUrl);
    } catch (err) {
        pendingResolves.delete(resolveKey);
        if (!res.headersSent) res.status(502).end();
    }
});

// Configure page HTML
function getConfigurePage(savedToken, settings) {
    const hasSavedToken = !!savedToken;
    const maskedToken = hasSavedToken
        ? (savedToken.length > 12 ? savedToken.slice(0, 6) + '...' + savedToken.slice(-6) : '******')
        : '';
    const s = settings || config.settings;
    const hostIP = config.hostIP;
    const port = config.port;
    const tunnelUrl = config.tunnelUrl;
    return `<!DOCTYPE html>
<html>
<head>
    <title>Real-Debrid Streams - Configure</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            background: #1a1a2e;
            padding: 40px;
            border-radius: 12px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }
        h1 { color: #00c853; margin-bottom: 8px; font-size: 24px; }
        .subtitle { color: #999; margin-bottom: 24px; font-size: 14px; }
        label { display: block; margin-bottom: 6px; font-weight: 600; font-size: 14px; }
        input[type="text"], input[type="password"], input[type="number"], select {
            width: 100%;
            padding: 12px;
            border: 1px solid #333;
            border-radius: 6px;
            background: #0d0d1a;
            color: #fff;
            font-size: 14px;
            margin-bottom: 16px;
            -webkit-appearance: none;
        }
        select { cursor: pointer; }
        .hint { color: #666; font-size: 12px; margin-top: -12px; margin-bottom: 16px; }
        .hint a { color: #00c853; }
        button {
            width: 100%;
            padding: 14px;
            background: #00c853;
            color: #000;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            margin-bottom: 10px;
        }
        button:hover { background: #00e676; }
        .btn-secondary { background: #2a2a4a; color: #e0e0e0; font-size: 14px; }
        .btn-secondary:hover { background: #3a3a5a; }
        .copied { background: #00c853 !important; color: #000 !important; }
        .saved-token {
            margin-bottom: 20px;
            padding: 14px;
            background: #0d2818;
            border: 1px solid #00c853;
            border-radius: 6px;
        }
        .saved-token .label { color: #00c853; font-size: 12px; font-weight: 600; text-transform: uppercase; }
        .saved-token .value { color: #e0e0e0; font-size: 14px; margin-top: 4px; font-family: monospace; }
        .divider { border: none; border-top: 1px solid #333; margin: 20px 0; }
        .section-label { color: #999; font-size: 12px; text-transform: uppercase; margin-bottom: 14px; letter-spacing: 1px; }
        .settings-row { display: flex; gap: 12px; }
        .settings-row > div { flex: 1; }
        .manual {
            margin-top: 16px; padding: 12px; background: #0d0d1a;
            border-radius: 6px; display: none; word-break: break-all; font-size: 13px;
        }
        .manual p { color: #999; margin-bottom: 8px; font-size: 12px; }
        .manual code { color: #00c853; }
        .sort-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: #0d0d1a;
            border: 1px solid #333;
            border-radius: 6px;
            margin-bottom: 6px;
            font-size: 14px;
        }
        .sort-item .sort-num { color: #00c853; font-weight: 700; min-width: 20px; }
        .sort-item .sort-label { flex: 1; }
        .sort-item button {
            width: 28px; padding: 4px; margin: 0; font-size: 12px;
            background: #2a2a4a; color: #e0e0e0; border-radius: 4px;
        }
        .sort-item button:hover { background: #3a3a5a; }
        .sort-item button:disabled { opacity: 0.3; cursor: default; }
        .status { text-align: center; color: #999; font-size: 13px; margin-top: 8px; }
        .status.success { color: #00c853; }
        .status.error { color: #f44336; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Real-Debrid Streams</h1>
        <p class="subtitle">Stream torrents from your Real-Debrid library for any movie or series</p>

        ${hasSavedToken ? `
        <div class="saved-token">
            <div class="label">Saved Token</div>
            <div class="value">${maskedToken}</div>
        </div>
        ` : ''}

        <div class="section-label">${hasSavedToken ? 'Update Token' : 'API Token'}</div>
        <input type="password" id="token" placeholder="Paste your Real-Debrid API token" />
        <div class="hint">
            Get your token from <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a>
        </div>

        <hr class="divider">
        <div class="section-label">Stream Settings</div>

        <label>Quality Tiers (check to enable)</label>
        <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
                <input type="checkbox" id="q2160" ${(s.qualities || []).includes('2160p') ? 'checked' : ''} /> 4K
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
                <input type="checkbox" id="q1080" ${(s.qualities || []).includes('1080p') ? 'checked' : ''} /> 1080p
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
                <input type="checkbox" id="q720" ${(s.qualities || []).includes('720p') ? 'checked' : ''} /> 720p
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
                <input type="checkbox" id="q480" ${(s.qualities || []).includes('480p') ? 'checked' : ''} /> 480p
            </label>
        </div>

        <div>
            <label>Sort Priority (1 = highest)</label>
            <div class="hint" style="margin-bottom:10px;">Use arrows to reorder. Top item is most important.</div>
            <div id="sortPriorityList" style="margin-bottom:16px;"></div>
        </div>

        <div class="settings-row">
            <div>
                <label for="maxPerQuality">Per Quality</label>
                <input type="number" id="maxPerQuality" min="1" max="20" value="${s.maxPerQuality || 5}" />
                <div class="hint">Max streams per quality tier</div>
            </div>
            <div></div>
        </div>

        <div class="settings-row">
            <div>
                <label for="preferredCodec">Codec Preference</label>
                <select id="preferredCodec">
                    <option value="all" ${s.preferredCodec === 'all' ? 'selected' : ''}>All Codecs</option>
                    <option value="x265" ${s.preferredCodec === 'x265' ? 'selected' : ''}>x265 / HEVC</option>
                    <option value="x264" ${s.preferredCodec === 'x264' ? 'selected' : ''}>x264 / AVC</option>
                </select>
            </div>
            <div>
                <label for="maxFileSize">Max File Size (GB)</label>
                <input type="number" id="maxFileSize" min="0" max="100" step="0.5" value="${s.maxFileSize || 0}" />
                <div class="hint">0 = no limit</div>
            </div>
        </div>

        <hr class="divider">

        <button onclick="saveAndInstall()">Save & Install in Stremio</button>
        <button class="btn-secondary" onclick="saveSettings()">Save Settings</button>
        <button class="btn-secondary" onclick="copyManifest()">Copy Manifest Link</button>
        <div class="status" id="status"></div>
        <div class="manual" id="manual">
            <p>Paste this link into the Stremio addon search bar:</p>
            <code id="manifest-url"></code>
        </div>
    </div>
    <script>
        var HOST = window.location.origin;
        var TUNNEL = ${JSON.stringify(tunnelUrl)};
        var MANIFEST_URL = TUNNEL ? TUNNEL + '/manifest.json' : 'http://localhost:${port}/manifest.json';

        var SORT_CRITERIA = {
            quality: 'Quality (2160p > 1080p > 720p)',
            language: 'Language (English first)',
            size: 'File Size (larger first)',
            seeders: 'Seeders (most first)',
            codec: 'Codec (x265 > x264)',
            source: 'Source (BluRay > WEB > etc.)'
        };
        var currentPriority = ${JSON.stringify(s.sortPriority || ['quality', 'language', 'size', 'seeders', 'codec', 'source'])};

        function renderSortList() {
            var container = document.getElementById('sortPriorityList');
            container.innerHTML = '';
            for (var i = 0; i < currentPriority.length; i++) {
                var key = currentPriority[i];
                var div = document.createElement('div');
                div.className = 'sort-item';
                div.innerHTML =
                    '<span class="sort-num">' + (i + 1) + '</span>' +
                    '<span class="sort-label">' + (SORT_CRITERIA[key] || key) + '</span>' +
                    '<button onclick="moveSortItem(' + i + ', -1)"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
                    '<button onclick="moveSortItem(' + i + ', 1)"' + (i === currentPriority.length - 1 ? ' disabled' : '') + '>&#9660;</button>';
                container.appendChild(div);
            }
        }
        function moveSortItem(index, direction) {
            var newIndex = index + direction;
            if (newIndex < 0 || newIndex >= currentPriority.length) return;
            var temp = currentPriority[index];
            currentPriority[index] = currentPriority[newIndex];
            currentPriority[newIndex] = temp;
            renderSortList();
        }
        renderSortList();

        function getSettings() {
            var qualities = [];
            if (document.getElementById('q2160').checked) qualities.push('2160p');
            if (document.getElementById('q1080').checked) qualities.push('1080p');
            if (document.getElementById('q720').checked) qualities.push('720p');
            if (document.getElementById('q480').checked) qualities.push('480p');
            if (qualities.length === 0) qualities = ['2160p', '1080p', '720p', '480p'];

            return {
                sortPriority: currentPriority.slice(),
                maxPerQuality: parseInt(document.getElementById('maxPerQuality').value, 10) || 5,
                qualities: qualities,
                preferredCodec: document.getElementById('preferredCodec').value,
                maxFileSize: parseFloat(document.getElementById('maxFileSize').value) || 0
            };
        }

        function getToken() {
            return document.getElementById('token').value.trim();
        }

        function showStatus(msg, type) {
            var el = document.getElementById('status');
            el.textContent = msg;
            el.className = 'status' + (type ? ' ' + type : '');
        }

        function saveSettings() {
            showStatus('Saving settings...', '');
            var body = { settings: getSettings() };
            var token = getToken();
            if (token) body.token = token;

            fetch(HOST + '/api/save-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.success) {
                    showStatus('Settings saved!' + (data.username ? ' Logged in as ' + data.username : ''), 'success');
                    if (token) setTimeout(function() { window.location.reload(); }, 1500);
                } else {
                    showStatus(data.error || 'Failed to save', 'error');
                }
            })
            .catch(function() { showStatus('Network error.', 'error'); });
        }

        function saveAndInstall() {
            showStatus('Saving...', '');
            var body = { settings: getSettings() };
            var token = getToken();
            if (token) body.token = token;

            fetch(HOST + '/api/save-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.success) {
                    showStatus('Saved! Opening Stremio...', 'success');
                    var stremioUrl = MANIFEST_URL.replace('https://', 'stremio://').replace('http://', 'stremio://');
                    window.location.href = stremioUrl;
                    setTimeout(function() {
                        document.getElementById('manifest-url').textContent = MANIFEST_URL;
                        document.getElementById('manual').style.display = 'block';
                        showStatus('If Stremio did not open, copy the link below.', 'success');
                    }, 2000);
                } else {
                    showStatus(data.error || 'Failed to save', 'error');
                }
            })
            .catch(function() { showStatus('Network error.', 'error'); });
        }

        function copyManifest() {
            navigator.clipboard.writeText(MANIFEST_URL).then(function() {
                document.getElementById('manifest-url').textContent = MANIFEST_URL;
                document.getElementById('manual').style.display = 'block';
                showStatus('Manifest link copied!', 'success');
            }).catch(function() {
                document.getElementById('manifest-url').textContent = MANIFEST_URL;
                document.getElementById('manual').style.display = 'block';
                showStatus('Copy the link below manually.', '');
            });
        }
    </script>
</body>
</html>`;
}

// API: Save token and/or settings
app.post('/api/save-config', async (req, res) => {
    const { token, settings } = req.body;
    const toSave = {};
    let username = null;

    // Verify and save token if provided
    if (token && typeof token === 'string' && token.trim().length > 0) {
        try {
            const user = await rd.getUser(token.trim());
            toSave.rdApiToken = token.trim();
            config.rdApiToken = token.trim();
            username = user.username;
            remountStaticRoutes();
            console.log(`[config] Token saved for user: ${user.username}`);
        } catch (err) {
            console.error('[config] Token verification failed:', err.message);
            return res.json({ success: false, error: 'Invalid or expired API token. Please check and try again.' });
        }
    }

    // Save settings if provided
    if (settings) {
        const validQualities = ['2160p', '1080p', '720p', '480p'];
        const validSortCriteria = ['quality', 'language', 'size', 'seeders', 'codec', 'source'];
        const sortPriority = Array.isArray(settings.sortPriority)
            ? settings.sortPriority.filter(c => validSortCriteria.includes(c))
            : ['quality', 'language', 'size', 'seeders', 'codec', 'source'];
        for (const c of validSortCriteria) {
            if (!sortPriority.includes(c)) sortPriority.push(c);
        }
        toSave.settings = {
            sortPriority,
            maxPerQuality: Math.min(Math.max(parseInt(settings.maxPerQuality, 10) || 5, 1), 20),
            qualities: (settings.qualities || []).filter(q => validQualities.includes(q)),
            preferredCodec: settings.preferredCodec || 'all',
            maxFileSize: Math.max(parseFloat(settings.maxFileSize) || 0, 0),
        };
        if (toSave.settings.qualities.length === 0) {
            toSave.settings.qualities = validQualities;
        }
        config.settings = { ...config.settings, ...toSave.settings };
        console.log(`[config] Settings saved:`, toSave.settings);
    }

    config.saveLocalConfig(toSave);
    res.json({ success: true, username });
});

// Configure page
app.get('/configure', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(getConfigurePage(config.rdApiToken, config.settings));
});
app.get('/:rdToken/configure', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(getConfigurePage(config.rdApiToken, config.settings));
});

// Addon routes
function mountAddonRoutes(router, getToken) {
    router.get('/manifest.json', (req, res) => res.json(manifest));

    router.get('/stream/:type/:id.json', async (req, res) => {
        try {
            const result = await streamHandler(req.params.type, req.params.id);
            res.json(result);
        } catch (err) {
            console.error('Stream error:', err.message, err.stack);
            res.json({ streams: [] });
        }
    });
}

// Token-in-URL routes
const tokenRouter = express.Router({ mergeParams: true });
mountAddonRoutes(tokenRouter, (req) => req.params.rdToken);
app.use('/:rdToken', tokenRouter);

// Static routes — delegate to an inner router that gets swapped when token changes
const staticWrapper = express.Router();
let staticInner = null;
function remountStaticRoutes() {
    staticInner = null;
    if (config.rdApiToken) {
        staticInner = express.Router();
        mountAddonRoutes(staticInner, () => config.rdApiToken);
        console.log('[config] Static routes mounted with saved token');
    }
}
staticWrapper.use((req, res, next) => {
    if (staticInner) return staticInner(req, res, next);
    next();
});
app.use('/', staticWrapper);
remountStaticRoutes();

// Start server on all interfaces so other devices on the network can reach it
const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Real-Debrid Streams addon running on:`);
    console.log(`  Local:   http://localhost:${config.port}`);
    console.log(`  Network: http://${config.hostIP}:${config.port}`);
    console.log(`  Tunnel:  ${config.tunnelUrl}`);
    console.log(`\n  *** Stremio Install URL (use this on all devices): ***`);
    console.log(`  ${config.tunnelUrl}/manifest.json\n`);
    console.log(`  Configure: ${config.tunnelUrl}/configure`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${config.port} is already in use. Kill the other process first.`);
        process.exit(1);
    }
    console.error('Server error:', err.message);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

process.on('exit', (code) => {
    console.log('Process exiting with code:', code);
});
