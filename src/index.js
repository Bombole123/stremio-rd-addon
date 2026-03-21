const express = require('express');
const cors = require('cors');
const manifest = require('./manifest');
const config = require('./config');
const streamHandler = require('./handlers/stream');
const rd = require('./lib/realDebrid');
const userStore = require('./lib/userStore');
const { VIDEO_EXTENSIONS } = require('./lib/titleMatcher');
const { parseEpisodeFromPath } = require('./lib/nameParser');
const { computeOpenSubHash } = require('./lib/opensubHash');
const { getVideoHash, setVideoHash } = require('./lib/torrentDb');
const { sourceStats } = require('./lib/torrentSearch');
const { setCachedPack } = require('./lib/seasonPackCache');

const app = express();
app.use(cors());
app.use(express.json());

// UUID v4 format regex for route matching
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Log all incoming requests
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip}`);
    next();
});

// Cached configure page HTML — invalidated when config changes
let configPageCache = null;

// Single-flight map: deduplicates concurrent resolve requests for the same hash+episode
const pendingResolves = new Map();

// Cache resolved download URLs — avoids re-unrestricting on repeated requests from same playback
// Key: resolveKey, Value: { url, expiry }
const resolvedUrlCache = new Map();
const RESOLVE_CACHE_TTL = 20 * 60 * 1000; // 20 minutes — RD links expire after ~30-60 min

// Clean up expired entries every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of resolvedUrlCache) {
        if (value.expiry < now) resolvedUrlCache.delete(key);
    }
}, 30 * 60 * 1000);

// Core resolve logic — returns the download URL string or throws
async function resolveHash(rdToken, hash, type, season, episode, imdbId) {
    const startTime = Date.now();
    // Check if hash already in user's RD library
    let torrentId = null;
    let weAdded = false; // Track whether we added this magnet ourselves
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
        weAdded = true;
    }

    try {
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
        const source = weAdded ? 'added' : 'library';
        console.log(`[resolve] ${hash} | ${Date.now() - startTime}ms | ${source}`);

        // Cache season pack data for instant resolution of other episodes
        if (type === 'series' && season && imdbId) {
            const videoCount = selectedFiles.filter(f => VIDEO_EXTENSIONS.test(f.path)).length;
            if (videoCount > 3) {
                setCachedPack(imdbId, parseInt(season, 10), {
                    torrentId,
                    hash: hash.toLowerCase(),
                    files: info.files,
                    links: info.links,
                });
                console.log(`[resolve] Cached season pack ${hash.slice(0, 8)}... for ${imdbId} S${season} (${videoCount} episodes)`);
            }
        }

        return { url: unrestricted.download, fileSize: targetFile.bytes || 0 };
    } catch (err) {
        // Clean up torrents we added if resolve fails (e.g. episode not found in pack)
        if (weAdded && torrentId) {
            console.log(`[resolve] Cleaning up torrent ${torrentId} — ${err.message}`);
            await rd.deleteTorrent(rdToken, torrentId).catch(() => {});
        }
        throw err;
    }
}

// Pre-resolve next episode in background for binge-watching (best-effort, silent on failure)
async function preResolveNextEpisode(rdToken, hash, type, season, nextEpisode, imdbId, userId) {
    try {
        const cacheKey = `${userId || 'default'}:${hash}:${type}:${season}:${nextEpisode}`;
        const cached = resolvedUrlCache.get(cacheKey);
        if (cached && cached.expiry > Date.now()) return; // Already cached

        const result = await resolveHash(rdToken, hash, type, season, String(nextEpisode), imdbId);
        if (result) {
            resolvedUrlCache.set(cacheKey, { url: result.url, fileSize: result.fileSize || 0, expiry: Date.now() + RESOLVE_CACHE_TTL });
            console.log(`[resolve] Pre-resolved next episode S${season}E${nextEpisode}`);
        }
    } catch (_err) {
        // Silent — pre-resolve is best-effort
    }
}

// --- Resolve handler logic (shared by both root and user-scoped routes) ---

async function handleResolve(req, res) {
    const { hash } = req.params;
    const { type, season, episode, imdbId } = req.query;
    const rdToken = req.rdToken;
    const userId = req.userId;

    if (!rdToken) {
        return res.status(503).send('No Real-Debrid token configured');
    }

    // Include userId in the cache key so users don't share resolved URLs
    const resolveKey = `${userId || 'default'}:${hash}:${type || ''}:${season || ''}:${episode || ''}`;

    try {
        let downloadUrl;
        let fileSize = 0;
        const cached = resolvedUrlCache.get(resolveKey);
        if (cached && cached.expiry > Date.now()) {
            downloadUrl = cached.url;
            fileSize = cached.fileSize || 0;
        } else {
            if (!pendingResolves.has(resolveKey)) {
                const p = resolveHash(rdToken, hash, type, season, episode, imdbId);
                p.finally(() => pendingResolves.delete(resolveKey));
                pendingResolves.set(resolveKey, p);
            }
            const result = await pendingResolves.get(resolveKey);
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

        // Pre-resolve next episode for binge-watching (fire-and-forget)
        if (type === 'series' && season && episode) {
            const nextEp = parseInt(episode, 10) + 1;
            setImmediate(() => {
                preResolveNextEpisode(rdToken, hash, type, season, nextEp, imdbId, userId);
            });
        }

        // 302 redirect — player connects directly to RD CDN
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.redirect(302, downloadUrl);
    } catch (err) {
        if (err.name === 'AbortError') return;
        console.error(`[resolve] Error:`, err.cause ? `${err.message} - ${err.cause.message}` : err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: err.message });
        }
    }
}

async function handleResolveHead(req, res) {
    const { hash } = req.params;
    const { type, season, episode, imdbId } = req.query;
    const rdToken = req.rdToken;
    const userId = req.userId;

    if (!rdToken) return res.status(503).end();

    const resolveKey = `${userId || 'default'}:${hash}:${type || ''}:${season || ''}:${episode || ''}`;

    try {
        let downloadUrl;
        const cached = resolvedUrlCache.get(resolveKey);
        if (cached && cached.expiry > Date.now()) {
            downloadUrl = cached.url;
        } else {
            if (!pendingResolves.has(resolveKey)) {
                const p = resolveHash(rdToken, hash, type, season, episode, imdbId);
                p.finally(() => pendingResolves.delete(resolveKey));
                pendingResolves.set(resolveKey, p);
            }
            const result = await pendingResolves.get(resolveKey);
            downloadUrl = result.url;
            resolvedUrlCache.set(resolveKey, { url: downloadUrl, fileSize: result.fileSize || 0, expiry: Date.now() + RESOLVE_CACHE_TTL });
        }

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.redirect(302, downloadUrl);
    } catch (err) {
        if (!res.headersSent) res.status(502).end();
    }
}

// --- Configure page HTML ---

function escHtml(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getConfigurePage(options = {}) {
    const { savedToken, settings, userId, username } = options;

    // Only cache the default (non-user) configure page
    if (!userId && configPageCache) return configPageCache;

    const hasSavedToken = !!savedToken;
    const maskedToken = hasSavedToken
        ? (savedToken.length > 12 ? savedToken.slice(0, 6) + '...' + savedToken.slice(-6) : '******')
        : '';
    const s = settings || config.settings;
    const port = config.port;
    const tunnelUrl = config.tunnelUrl;

    // User-specific display — escape username to prevent HTML injection
    const userBanner = userId ? `
        <div class="saved-token" style="margin-bottom:20px;">
            <div class="label">Logged in${username ? ' as ' + escHtml(username) : ''}</div>
            <div class="value" style="font-size:12px;word-break:break-all;margin-top:4px;">User ID: ${escHtml(userId)}</div>
        </div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Real-Debrid Streams - Configure</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
        @media (max-width: 768px) {
            body { padding: 10px; }
            .container { padding: 15px; margin: 10px; }
            h1 { font-size: 1.4em; }
            .settings-row { flex-direction: column; gap: 0; }
            input[type="text"], input[type="password"], input[type="number"], select {
                font-size: 16px; min-height: 44px;
            }
            button { font-size: 16px; min-height: 44px; }
            .sort-item button { min-height: 28px; }
            pre { font-size: 12px; overflow-x: auto; word-break: break-all; }
            .manual code { font-size: 12px; }
            .btn-secondary { width: 100%; margin-bottom: 8px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Real-Debrid Streams</h1>
        <p class="subtitle">Stream torrents from your Real-Debrid library for any movie or series</p>

        <div class="section-label">Real-Debrid Account</div>

        ${userBanner}

        ${!userId && hasSavedToken ? `
        <div class="saved-token">
            <div class="label">Saved Token</div>
            <div class="value">${maskedToken}</div>
        </div>
        ` : ''}

        <button class="btn-secondary" id="btnDeviceAuth" onclick="startDeviceAuth()">Login with Real-Debrid</button>

        <div id="deviceAuthFlow" style="display:none; margin-top:16px;">
            <div style="padding:16px; background:#0d0d1a; border-radius:6px; text-align:center;">
                <p style="color:#999; margin-bottom:8px;">Go to:</p>
                <a id="authUrl" href="#" target="_blank" style="color:#00c853; font-size:18px; font-weight:700;"></a>
                <p style="color:#999; margin:12px 0 8px;">Enter code:</p>
                <div id="authCode" style="font-size:28px; font-weight:700; color:#fff; letter-spacing:4px; font-family:monospace;"></div>
                <p id="authStatus" style="color:#999; margin-top:12px; font-size:13px;">Waiting for authorization...</p>
            </div>
        </div>

        <div id="installSection" style="display:none; margin-top:16px;">
            <div style="padding:16px; background:#0d2818; border:1px solid #00c853; border-radius:6px;">
                <p style="color:#00c853; font-weight:600; margin-bottom:8px;">Your personal addon URL:</p>
                <code id="personalUrl" style="color:#fff; font-size:13px; word-break:break-all;"></code>
                <button onclick="installPersonalUrl()" style="margin-top:12px;">Install in Stremio</button>
                <button class="btn-secondary" onclick="copyPersonalUrl()" style="margin-top:4px;">Copy Manifest Link</button>
            </div>
        </div>

        <div style="margin-top:12px;">
            <details>
                <summary style="color:#666; font-size:12px; cursor:pointer;">Or paste API token manually</summary>
                <div style="margin-top:8px;">
                    <input type="password" id="token" placeholder="Paste your Real-Debrid API token" />
                    <div class="hint">Get your token from <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a></div>
                </div>
            </details>
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
            <div>
                <label for="languageFilter">Language Filter</label>
                <select id="languageFilter">
                    <option value="all" ${s.languageFilter === 'all' ? 'selected' : ''}>All Languages</option>
                    <option value="english" ${s.languageFilter === 'english' ? 'selected' : ''}>English Only</option>
                    <option value="multi" ${s.languageFilter === 'multi' ? 'selected' : ''}>Multi/Dual Audio</option>
                </select>
            </div>
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
        var authPollTimer = null;
        var currentUserId = ${userId ? JSON.stringify(userId) : 'null'};
        var MANIFEST_URL = currentUserId
            ? (TUNNEL + '/' + currentUserId + '/manifest.json')
            : (TUNNEL ? TUNNEL + '/manifest.json' : 'http://localhost:${port}/manifest.json');

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
                languageFilter: document.getElementById('languageFilter').value,
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

        function updateManifestUrl(userId) {
            if (userId) {
                currentUserId = userId;
                MANIFEST_URL = TUNNEL + '/' + userId + '/manifest.json';
            }
        }

        function showInstallSection(manifestUrl) {
            document.getElementById('personalUrl').textContent = manifestUrl;
            document.getElementById('installSection').style.display = 'block';
        }

        function installPersonalUrl() {
            var stremioUrl = MANIFEST_URL.replace('https://', 'stremio://').replace('http://', 'stremio://');
            window.location.href = stremioUrl;
            setTimeout(function() {
                document.getElementById('manifest-url').textContent = MANIFEST_URL;
                document.getElementById('manual').style.display = 'block';
                showStatus('If Stremio did not open, copy the link below.', 'success');
            }, 2000);
        }

        function copyPersonalUrl() {
            navigator.clipboard.writeText(MANIFEST_URL).then(function() {
                showStatus('Manifest link copied!', 'success');
            }).catch(function() {
                document.getElementById('manifest-url').textContent = MANIFEST_URL;
                document.getElementById('manual').style.display = 'block';
                showStatus('Copy the link below manually.', '');
            });
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
                    var msg = 'Settings saved!';
                    if (data.username) msg += ' Logged in as ' + data.username;
                    if (data.userId) {
                        updateManifestUrl(data.userId);
                        showInstallSection(MANIFEST_URL);
                        msg += ' Your personal URL is ready.';
                    }
                    showStatus(msg, 'success');
                    if (token && !data.userId) setTimeout(function() { window.location.reload(); }, 1500);
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
                    if (data.userId) {
                        updateManifestUrl(data.userId);
                        showInstallSection(MANIFEST_URL);
                    }
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

        function startDeviceAuth() {
            document.getElementById('btnDeviceAuth').disabled = true;
            document.getElementById('btnDeviceAuth').textContent = 'Starting...';

            fetch(HOST + '/api/auth/device-code', { method: 'POST' })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.error) {
                    showStatus(data.error, 'error');
                    document.getElementById('btnDeviceAuth').disabled = false;
                    document.getElementById('btnDeviceAuth').textContent = 'Login with Real-Debrid';
                    return;
                }

                document.getElementById('deviceAuthFlow').style.display = 'block';
                document.getElementById('authUrl').href = data.verification_url;
                document.getElementById('authUrl').textContent = data.verification_url;
                document.getElementById('authCode').textContent = data.user_code;
                document.getElementById('authStatus').textContent = 'Waiting for authorization...';
                document.getElementById('authStatus').style.color = '#999';

                if (authPollTimer) clearInterval(authPollTimer);
                authPollTimer = setInterval(pollDeviceAuth, 5000);
            })
            .catch(function() {
                showStatus('Failed to start authentication', 'error');
                document.getElementById('btnDeviceAuth').disabled = false;
                document.getElementById('btnDeviceAuth').textContent = 'Login with Real-Debrid';
            });
        }

        function pollDeviceAuth() {
            var pollUrl = HOST + '/api/auth/poll';
            if (currentUserId) pollUrl += '?userId=' + currentUserId;

            fetch(pollUrl)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.status === 'authorized') {
                    clearInterval(authPollTimer);
                    authPollTimer = null;

                    var msg = 'Authorized!';
                    if (data.username) msg += ' Logged in as ' + data.username;
                    document.getElementById('authStatus').textContent = msg;
                    document.getElementById('authStatus').style.color = '#00c853';

                    if (data.userId) {
                        updateManifestUrl(data.userId);
                        showInstallSection(MANIFEST_URL);
                        showStatus(msg + ' Your personal addon URL is ready below.', 'success');
                        document.getElementById('btnDeviceAuth').textContent = 'Re-authenticate';
                        document.getElementById('btnDeviceAuth').disabled = false;
                    } else {
                        showStatus(msg, 'success');
                        setTimeout(function() { window.location.reload(); }, 2000);
                    }
                } else if (data.status === 'error') {
                    clearInterval(authPollTimer);
                    authPollTimer = null;
                    document.getElementById('authStatus').textContent = data.message || 'Authorization failed';
                    document.getElementById('authStatus').style.color = '#f44336';
                    document.getElementById('btnDeviceAuth').disabled = false;
                    document.getElementById('btnDeviceAuth').textContent = 'Login with Real-Debrid';
                }
            })
            .catch(function() {
                // Network error - keep polling
            });
        }
    </script>
</body>
</html>`;
    if (!userId) configPageCache = html;
    return html;
}

// --- API: Save token and/or settings ---

app.post('/api/save-config', async (req, res) => {
    const { token, settings } = req.body;
    const toSave = {};
    let username = null;
    let userId = null;

    // Verify and save token if provided
    if (token && typeof token === 'string' && token.trim().length > 0) {
        try {
            const user = await rd.getUser(token.trim());
            username = user.username;

            // Create a new user in the store
            userId = userStore.createUser({
                rdApiToken: token.trim(),
                username: user.username,
            });

            console.log(`[config] Manual token saved for user: ${user.username} (${userId})`);
        } catch (err) {
            console.error('[config] Token verification failed:', err.message);
            return res.json({ success: false, error: 'Invalid or expired API token. Please check and try again.' });
        }
    }

    // Save settings if provided (global settings, stored in config.local.json)
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
            languageFilter: ['all', 'english', 'multi'].includes(settings.languageFilter) ? settings.languageFilter : 'all',
            maxFileSize: Math.max(parseFloat(settings.maxFileSize) || 0, 0),
        };
        if (toSave.settings.qualities.length === 0) {
            toSave.settings.qualities = validQualities;
        }
        config.settings = { ...config.settings, ...toSave.settings };
        console.log(`[config] Settings saved:`, toSave.settings);
    }

    if (Object.keys(toSave).length > 0) {
        config.saveLocalConfig(toSave);
    }
    configPageCache = null;
    res.json({ success: true, username, userId });
});

// --- Device Code OAuth Flow ---
const RD_OAUTH_CLIENT_ID = 'X245A4XAIBGVM';

// Per-session pending device codes (keyed by a random session ID)
// This supports multiple concurrent auth flows from different users
const pendingAuthSessions = new Map();
let legacyDeviceCode = null; // Backwards compat for single-session usage

// Start device code auth flow
app.post('/api/auth/device-code', async (req, res) => {
    try {
        const response = await fetch(
            `https://api.real-debrid.com/oauth/v2/device/code?client_id=${RD_OAUTH_CLIENT_ID}&new_credentials=yes`,
            { signal: AbortSignal.timeout(15000) }
        );
        if (!response.ok) {
            const text = await response.text();
            return res.json({ error: `Real-Debrid error: ${text}` });
        }
        const data = await response.json();

        // Store the device code keyed by itself (poll endpoint will look it up)
        legacyDeviceCode = data.device_code;

        res.json({
            user_code: data.user_code,
            verification_url: data.verification_url,
            direct_verification_url: data.direct_verification_url,
            expires_in: data.expires_in,
        });
    } catch (err) {
        console.error('[auth] Device code request failed:', err.message);
        res.json({ error: 'Failed to start authentication. Try again.' });
    }
});

// Poll for device auth completion
app.get('/api/auth/poll', async (req, res) => {
    const existingUserId = req.query.userId || null;

    if (!legacyDeviceCode) {
        return res.json({ status: 'error', message: 'No authentication in progress.' });
    }

    try {
        // Step 1: Check if user has authorized
        const credRes = await fetch(
            `https://api.real-debrid.com/oauth/v2/device/credentials?client_id=${RD_OAUTH_CLIENT_ID}&code=${legacyDeviceCode}`,
            { signal: AbortSignal.timeout(15000) }
        );

        if (credRes.status === 403) {
            return res.json({ status: 'pending' });
        }

        if (!credRes.ok) {
            legacyDeviceCode = null;
            return res.json({ status: 'error', message: 'Authorization expired or failed.' });
        }

        const credentials = await credRes.json();

        // Step 2: Exchange credentials for access token
        const tokenRes = await fetch('https://api.real-debrid.com/oauth/v2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: credentials.client_id,
                client_secret: credentials.client_secret,
                code: legacyDeviceCode,
                grant_type: 'http://oauth.net/grant_type/device/1.0',
            }).toString(),
            signal: AbortSignal.timeout(15000),
        });

        if (!tokenRes.ok) {
            const text = await tokenRes.text();
            legacyDeviceCode = null;
            return res.json({ status: 'error', message: `Token exchange failed: ${text}` });
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;
        legacyDeviceCode = null;

        // Step 3: Verify token and get user info
        const user = await rd.getUser(accessToken);

        const rdCredentials = {
            rdApiToken: accessToken,
            rdRefreshToken: tokenData.refresh_token,
            rdClientId: credentials.client_id,
            rdClientSecret: credentials.client_secret,
            rdTokenExpiry: Date.now() + (tokenData.expires_in * 1000),
            username: user.username,
        };

        let userId;
        if (existingUserId && UUID_RE.test(existingUserId)) {
            // Re-authenticating an existing user
            const existingUser = userStore.getUser(existingUserId);
            if (existingUser) {
                userStore.updateUser(existingUserId, rdCredentials);
                userId = existingUserId;
                console.log(`[auth] Re-authenticated user ${userId} as ${user.username}`);
            } else {
                // User not found, create new
                userId = userStore.createUser(rdCredentials);
                console.log(`[auth] Created new user ${userId} for ${user.username} (old ID not found)`);
            }
        } else {
            // New user
            userId = userStore.createUser(rdCredentials);
            console.log(`[auth] OAuth login successful — created user ${userId} for ${user.username}`);
        }

        configPageCache = null;

        res.json({ status: 'authorized', username: user.username, userId });
    } catch (err) {
        console.error('[auth] Poll error:', err.message);
        legacyDeviceCode = null;
        res.json({ status: 'error', message: 'Authentication failed. Please try again.' });
    }
});

// --- API: List users (admin) ---
app.get('/api/users', (req, res) => {
    res.json(userStore.listUsers());
});

// --- Configure page ---

// Root configure page (no user context)
app.get('/configure', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(getConfigurePage({
        savedToken: config.rdApiToken,
        settings: config.settings,
    }));
});

// User-specific configure page
app.get('/:userId/configure', (req, res) => {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) {
        // Not a valid UUID — fall through (could be old /:rdToken/configure)
        res.setHeader('Content-Type', 'text/html');
        res.end(getConfigurePage({
            savedToken: config.rdApiToken,
            settings: config.settings,
        }));
        return;
    }

    const user = userStore.getUser(userId);
    if (!user) {
        return res.status(404).send('User not found. Please go to /configure to set up your account.');
    }

    res.setHeader('Content-Type', 'text/html');
    res.end(getConfigurePage({
        savedToken: user.rdApiToken,
        settings: config.settings,
        userId,
        username: user.username,
    }));
});

// --- Status / Health endpoint ---
let cachedUserInfo = null;
let userInfoExpiry = 0;
async function getCachedUserInfo() {
    if (cachedUserInfo && Date.now() < userInfoExpiry) return cachedUserInfo;
    try {
        cachedUserInfo = await rd.getUser(config.rdApiToken);
        userInfoExpiry = Date.now() + 5 * 60 * 1000;
    } catch (err) {
        cachedUserInfo = null;
    }
    return cachedUserInfo;
}

function buildStatusHtml(data) {
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const badge = (ok) => ok
        ? '<span style="color:#4caf50;font-weight:600;">Yes</span>'
        : '<span style="color:#f44336;font-weight:600;">No</span>';

    const sourceRows = Object.entries(data.sources).map(([name, s]) =>
        `<tr>
            <td>${esc(name)}</td>
            <td>${s.successes}</td>
            <td>${s.failures}</td>
            <td>${s.totalResults}</td>
            <td>${s.consecutiveFailures >= 5 ? '<span style="color:#f44336;">disabled</span>' : '<span style="color:#4caf50;">ok</span>'}</td>
        </tr>`
    ).join('');

    const userRows = data.users.map(u =>
        `<tr><td style="font-family:monospace;font-size:12px;">${esc(u.userId.slice(0, 8))}...</td><td>${esc(u.username || '-')}</td><td>${esc(u.created || '-')}</td></tr>`
    ).join('');

    return `<!DOCTYPE html>
<html>
<head>
    <title>Addon Status</title>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 40px; max-width: 700px; margin: 0 auto; }
        h1 { color: #00c853; margin-bottom: 24px; }
        h2 { color: #aaa; font-size: 16px; text-transform: uppercase; letter-spacing: 1px; margin-top: 28px; margin-bottom: 12px; border-bottom: 1px solid #333; padding-bottom: 6px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
        td, th { text-align: left; padding: 6px 12px; }
        th { color: #999; font-size: 12px; text-transform: uppercase; }
        tr:nth-child(even) { background: #111; }
        .kv td:first-child { color: #999; width: 180px; }
        .kv td:last-child { color: #fff; }
    </style>
</head>
<body>
    <h1>${esc(data.addon.name || 'Real-Debrid Streams')}</h1>

    <h2>Addon</h2>
    <table class="kv">
        <tr><td>Version</td><td>${esc(data.addon.version)}</td></tr>
        <tr><td>Uptime</td><td>${Math.floor(data.addon.uptime)}s</td></tr>
        <tr><td>Node</td><td>${esc(data.addon.nodeVersion)}</td></tr>
    </table>

    <h2>Real-Debrid (Legacy)</h2>
    <table class="kv">
        <tr><td>Token Configured</td><td>${badge(data.realDebrid.tokenConfigured)}</td></tr>
        <tr><td>Username</td><td>${esc(data.realDebrid.username || '-')}</td></tr>
        <tr><td>Email</td><td>${esc(data.realDebrid.email || '-')}</td></tr>
        <tr><td>Premium</td><td>${badge(data.realDebrid.premium)}</td></tr>
        <tr><td>Premium Expiry</td><td>${esc(data.realDebrid.premiumExpiry || '-')}</td></tr>
    </table>

    <h2>Users (${data.users.length})</h2>
    ${data.users.length > 0 ? `
    <table>
        <tr><th>ID</th><th>Username</th><th>Created</th></tr>
        ${userRows}
    </table>` : '<p style="color:#999;">No users registered yet.</p>'}

    <h2>Sources</h2>
    ${Object.keys(data.sources).length > 0 ? `
    <table>
        <tr><th>Source</th><th>OK</th><th>Fail</th><th>Results</th><th>Status</th></tr>
        ${sourceRows}
    </table>` : '<p style="color:#999;">No source data yet (no searches performed).</p>'}

    <h2>Cache</h2>
    <table class="kv">
        <tr><td>Hash Cache</td><td>${badge(data.cache.hashCacheConfigured)}</td></tr>
        <tr><td>DB Path</td><td style="font-family:monospace;font-size:13px;">${esc(data.cache.dbPath)}</td></tr>
    </table>
</body>
</html>`;
}

app.get('/status', async (req, res) => {
    const user = await getCachedUserInfo();

    const data = {
        addon: {
            name: manifest.name,
            version: manifest.version,
            uptime: process.uptime(),
            nodeVersion: process.version,
        },
        realDebrid: {
            username: (user && user.username) || null,
            email: (user && user.email) || null,
            premium: user ? user.premium > 0 : false,
            premiumExpiry: (user && user.expiration) || null,
            tokenConfigured: !!config.rdApiToken,
        },
        users: userStore.listUsers(),
        sources: sourceStats,
        cache: {
            hashCacheConfigured: true,
            dbPath: 'data/torrents.db',
        },
    };

    const accept = req.headers.accept || '';
    if (accept.includes('text/html') && !accept.includes('application/json')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(buildStatusHtml(data));
    } else {
        res.json(data);
    }
});

// --- Root-level addon routes (backwards compatible, uses config.rdApiToken) ---

// Middleware to attach default RD token for root-level routes
function defaultTokenMiddleware(req, res, next) {
    req.rdToken = config.rdApiToken;
    req.userId = null;
    next();
}

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/stream/:type/:id.json', defaultTokenMiddleware, async (req, res) => {
    try {
        const result = await streamHandler(req.params.type, req.params.id, {
            rdToken: req.rdToken,
            userId: req.userId,
        });
        res.json(result);
    } catch (err) {
        console.error('Stream error:', err.message, err.stack);
        res.json({ streams: [] });
    }
});

app.get('/resolve/:hash', defaultTokenMiddleware, handleResolve);
app.head('/resolve/:hash', defaultTokenMiddleware, handleResolveHead);

// --- User-scoped addon routes (/:userId/...) ---

const userRouter = express.Router({ mergeParams: true });

// Middleware: look up user by UUID, attach rdToken to request
userRouter.use((req, res, next) => {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) {
        return next('router'); // Not a UUID — skip this router entirely
    }

    const user = userStore.getUser(userId);
    if (!user || !user.rdApiToken) {
        return res.status(404).json({ error: 'User not found or no token configured' });
    }

    req.rdToken = user.rdApiToken;
    req.userId = userId;
    next();
});

userRouter.get('/manifest.json', (req, res) => res.json(manifest));

userRouter.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const result = await streamHandler(req.params.type, req.params.id, {
            rdToken: req.rdToken,
            userId: req.userId,
        });
        res.json(result);
    } catch (err) {
        console.error('Stream error:', err.message, err.stack);
        res.json({ streams: [] });
    }
});

userRouter.get('/resolve/:hash', handleResolve);
userRouter.head('/resolve/:hash', handleResolveHead);

app.use('/:userId', userRouter);

// Start server on all interfaces so other devices on the network can reach it
const server = app.listen(config.port, '0.0.0.0', () => {
    const users = userStore.listUsers();
    console.log(`Real-Debrid Streams addon running on:`);
    console.log(`  Local:   http://localhost:${config.port}`);
    console.log(`  Network: http://${config.hostIP}:${config.port}`);
    console.log(`  Tunnel:  ${config.tunnelUrl}`);
    console.log(`\n  Configure: ${config.tunnelUrl}/configure`);
    if (config.rdApiToken) {
        console.log(`  Legacy manifest: ${config.tunnelUrl}/manifest.json`);
    }
    if (users.length > 0) {
        console.log(`\n  Registered users: ${users.length}`);
        for (const u of users) {
            console.log(`    ${u.username || 'unknown'}: ${config.tunnelUrl}/${u.userId}/manifest.json`);
        }
    }
    console.log('');
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
