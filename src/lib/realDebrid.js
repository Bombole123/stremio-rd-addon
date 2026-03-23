const config = require('../config');
const Cache = require('./cache');
const userStore = require('./userStore');
const { getCachedAvailability, setCachedAvailability } = require('./torrentDb');

const ERR_RATE_LIMITED = 'Real-Debrid rate limit exceeded. Try again shortly.';

const cache = new Cache();

// In-memory negative cache of hashes known NOT to be cached on RD (6-hour TTL)
const hashCache = new Cache();

// --- Library index: in-memory hash→torrent mapping to avoid paginating getAllTorrents() every resolve ---
const LIBRARY_REFRESH_INTERVAL = 2 * 60 * 1000; // 2 minutes

// Per-token library index: tokenKey → { index: Map<hash, {id, status, filename}>, lastRefresh, refreshPromise }
const libraryIndexes = new Map();

// Use last 8 chars of token as cache key fingerprint
function tokenKey(token) {
    return token.slice(-8);
}

// --- Library index functions ---

function getLibraryEntry(token) {
    const key = tokenKey(token);
    if (!libraryIndexes.has(key)) {
        libraryIndexes.set(key, { index: new Map(), lastRefresh: 0, refreshPromise: null });
    }
    return libraryIndexes.get(key);
}

async function refreshLibraryIndex(token, force = false) {
    const entry = getLibraryEntry(token);
    const now = Date.now();

    // Skip if recently refreshed and not forced
    if (!force && (now - entry.lastRefresh) < LIBRARY_REFRESH_INTERVAL) {
        return entry.index;
    }

    // Deduplicate concurrent refreshes
    if (entry.refreshPromise) return entry.refreshPromise;

    entry.refreshPromise = (async () => {
        try {
            const torrents = await getAllTorrents(token);
            const newIndex = new Map();
            for (const t of torrents) {
                if (t.hash) {
                    newIndex.set(t.hash.toLowerCase(), {
                        id: t.id,
                        status: t.status,
                        filename: t.filename || '',
                    });
                }
            }
            entry.index = newIndex;
            entry.lastRefresh = Date.now();
            console.log(`[rd] Library index refreshed: ${newIndex.size} torrents`);
            return newIndex;
        } finally {
            entry.refreshPromise = null;
        }
    })();

    return entry.refreshPromise;
}

async function findTorrentByHash(token, hash) {
    const normalizedHash = hash.toLowerCase();
    const entry = getLibraryEntry(token);

    // Check index first
    if (entry.index.has(normalizedHash)) {
        return entry.index.get(normalizedHash);
    }

    // Miss — refresh and check again
    const freshIndex = await refreshLibraryIndex(token, true);
    return freshIndex.get(normalizedHash) || null;
}

// --- Token refresh logic ---
// Per-key refresh promises to deduplicate concurrent refreshes
const refreshPromises = new Map();

async function refreshAccessToken(userId) {
    let rdRefreshToken, rdClientId, rdClientSecret;

    if (userId) {
        const user = userStore.getUser(userId);
        if (!user) throw new Error('User not found for token refresh');
        rdRefreshToken = user.rdRefreshToken;
        rdClientId = user.rdClientId;
        rdClientSecret = user.rdClientSecret;
    } else {
        rdRefreshToken = config.rdRefreshToken;
        rdClientId = config.rdClientId;
        rdClientSecret = config.rdClientSecret;
    }

    if (!rdRefreshToken || !rdClientId || !rdClientSecret) {
        throw new Error('Missing refresh credentials — re-authenticate via OAuth');
    }

    const res = await fetch('https://api.real-debrid.com/oauth/v2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: rdClientId,
            client_secret: rdClientSecret,
            code: rdRefreshToken,
            grant_type: 'http://oauth.net/grant_type/device/1.0',
        }).toString(),
        signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Token refresh HTTP ${res.status}: ${text}`);
    }

    const data = await res.json();
    const newExpiry = Date.now() + (data.expires_in * 1000);

    if (userId) {
        // Persist to user store
        userStore.updateUser(userId, {
            rdApiToken: data.access_token,
            rdRefreshToken: data.refresh_token,
            rdTokenExpiry: newExpiry,
        });
    } else {
        // Update in-memory config + persist to disk (legacy)
        config.rdApiToken = data.access_token;
        config.rdRefreshToken = data.refresh_token;
        config.rdTokenExpiry = newExpiry;
        config.saveLocalConfig({
            rdApiToken: data.access_token,
            rdRefreshToken: data.refresh_token,
            rdTokenExpiry: newExpiry,
        });
    }

    return data.access_token;
}

async function tryRefreshToken(userId) {
    const key = userId || '__default__';

    // If a refresh is already in flight for this key, piggy-back on it
    if (refreshPromises.has(key)) return refreshPromises.get(key);

    const promise = refreshAccessToken(userId)
        .then((newToken) => {
            console.log(`[auth] Access token refreshed successfully${userId ? ` for user ${userId.slice(0, 8)}...` : ''}`);
            refreshPromises.delete(key);
            return newToken;
        })
        .catch((err) => {
            console.error(`[auth] Token refresh failed${userId ? ` for user ${userId.slice(0, 8)}...` : ''}:`, err.message);
            refreshPromises.delete(key);
            throw err;
        });

    refreshPromises.set(key, promise);
    return promise;
}

// --- Core API request with automatic 401 retry ---
// Note: HTTP keep-alive is enabled by default in Node 19+ (both http/https agents
// and native fetch/undici use persistent connections). No custom agent needed.

async function doFetch(endpoint, token, options = {}) {
    const url = `${config.rdApiBase}${endpoint}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
    };

    const fetchOptions = {
        method: options.method || 'GET',
        headers,
    };

    if (options.body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = new URLSearchParams(options.body).toString();
    }

    return fetch(url, {
        ...fetchOptions,
        signal: AbortSignal.timeout(config.thresholds?.rdApiTimeout || 15000),
    });
}

function handleNonAuthErrors(res) {
    if (res.status === 403) {
        throw new Error('Forbidden/disabled endpoint');
    }
    if (!res.ok) {
        // Caller will read the body
        return false;
    }
    return true;
}

async function apiRequest(endpoint, token, options = {}) {
    const maxRetries = config.thresholds?.rdMaxRetries || 3;
    const baseDelay = config.thresholds?.rdRetryDelayMs || 1000;
    const userId = options.userId || null;
    let delay = baseDelay;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let res = await doFetch(endpoint, token, options);

        // On 401, attempt a transparent token refresh and retry once
        if (res.status === 401) {
            try {
                const newToken = await tryRefreshToken(userId);
                token = newToken;
                res = await doFetch(endpoint, newToken, options);
            } catch (_refreshErr) {
                // Refresh failed — throw the original 401 error
                throw new Error('Invalid or expired Real-Debrid API token');
            }
        }

        if (res.status === 401) {
            throw new Error('Invalid or expired Real-Debrid API token');
        }

        // On 429, retry with exponential backoff
        if (res.status === 429) {
            if (attempt < maxRetries) {
                console.log(`[rd] Rate limited, retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
                continue;
            }
            // All retries exhausted — throw the rate limit error
            throw new Error(ERR_RATE_LIMITED);
        }

        handleNonAuthErrors(res);

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`RD API error ${res.status}: ${text}`);
        }

        if (res.status === 204 || res.headers.get('content-length') === '0') {
            return null;
        }

        return res.json();
    }
}

async function getUser(token) {
    return apiRequest('/user', token);
}

async function getTorrents(token, page = 1, limit = 50) {
    const cacheKey = `torrents:${page}:${limit}:${tokenKey(token)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await apiRequest(`/torrents?page=${page}&limit=${limit}`, token);
    cache.set(cacheKey, result, config.cacheTTL.torrentList);
    return result;
}

async function getAllTorrents(token) {
    const cacheKey = `torrents:all:${tokenKey(token)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // Fetch up to 2500 torrents (50 pages of 50)
    let allTorrents = [];
    let page = 1;
    while (true) {
        const batch = await apiRequest(`/torrents?page=${page}&limit=50`, token);
        if (!batch || batch.length === 0) break;
        allTorrents = allTorrents.concat(batch);
        if (batch.length < 50) break;
        page++;
        if (page > 50) break;
    }

    cache.set(cacheKey, allTorrents, config.cacheTTL.torrentList);
    return allTorrents;
}

async function getTorrentInfo(token, torrentId, forceRefresh = false) {
    const cacheKey = `torrent_info:${torrentId}:${tokenKey(token)}`;
    if (!forceRefresh) {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
    }

    const result = await apiRequest(`/torrents/info/${torrentId}`, token);
    cache.set(cacheKey, result, config.cacheTTL.torrentInfo);
    return result;
}

async function getDownloads(token, page = 1, limit = 50) {
    const cacheKey = `downloads:${page}:${limit}:${tokenKey(token)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await apiRequest(`/downloads?page=${page}&limit=${limit}`, token);
    cache.set(cacheKey, result, config.cacheTTL.torrentList);
    return result;
}

async function unrestrictLink(token, link) {
    const cacheKey = `unrestrict:${link}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await apiRequest('/unrestrict/link', token, {
        method: 'POST',
        body: { link },
    });
    cache.set(cacheKey, result, config.cacheTTL.unrestrict);
    return result;
}

// Mark a hash as known-cached in the local hash cache
function markHashCached(hash) {
    hashCache.set(`known:${hash.toLowerCase()}`, true, config.cacheTTL.hashCache);
}

// Check if a hash is already known to be cached locally
function isHashKnownCached(hash) {
    return hashCache.get(`known:${hash.toLowerCase()}`) === true;
}

// Mark a hash as known NOT cached on RD (6-hour TTL)
function markHashNotCached(hash) {
    hashCache.set(`notcached:${hash.toLowerCase()}`, true, config.cacheTTL.hashCache);
}

// Check if a hash is known to NOT be cached on RD
function isHashKnownNotCached(hash) {
    return hashCache.get(`notcached:${hash.toLowerCase()}`) === true;
}

// Group hashes by quality tier using torrent metadata, then pick up to maxPerTier from each
function prioritizeByQuality(hashes, torrentMap) {
    const maxPerTier = config.thresholds?.maxPerTierCheck || 3;
    const tiers = { '2160p': [], '1080p': [], '720p': [], '480p': [], 'unknown': [] };

    for (const hash of hashes) {
        const torrent = torrentMap && torrentMap.get(hash);
        const quality = torrent?._parsedQuality || 'unknown';
        const bucket = tiers[quality] || tiers['unknown'];
        bucket.push(hash);
    }

    const selected = [];
    for (const tier of ['2160p', '1080p', '720p', '480p', 'unknown']) {
        selected.push(...tiers[tier].slice(0, maxPerTier));
    }
    return selected;
}

// Simple concurrency limiter — runs async tasks with at most `limit` in flight
async function parallelLimit(tasks, limit) {
    let idx = 0;

    async function worker() {
        while (idx < tasks.length) {
            await tasks[idx++]();
        }
    }

    const workers = [];
    for (let w = 0; w < Math.min(limit, tasks.length); w++) {
        workers.push(worker());
    }
    await Promise.all(workers);
}

async function checkInstantAvailability(token, hashes, torrentMap) {
    if (!hashes || hashes.length === 0) return {};

    // Normalize all hashes to lowercase once so all downstream keying is consistent
    const normalizedHashes = hashes.map(h => h.toLowerCase());

    const result = {};
    const concurrency = config.thresholds?.magnetConcurrency || 3;
    const minPerTier = config.thresholds?.minResultsPerTier || 2;

    // Step 1: Check persistent positive cache (SQLite) and in-memory negative cache
    const toQuery = [];
    let positiveCacheHits = 0;
    let negativeCacheHits = 0;

    for (const hash of normalizedHashes) {
        const cached = getCachedAvailability(hash);
        if (cached) {
            result[hash] = cached;
            markHashCached(hash);
            positiveCacheHits++;
        } else if (isHashKnownNotCached(hash)) {
            negativeCacheHits++;
        } else {
            toQuery.push(hash);
        }
    }

    if (positiveCacheHits > 0 || negativeCacheHits > 0) {
        console.log(`[rd] Cache: ${positiveCacheHits} positive hit(s), ${negativeCacheHits} negative skip(s)`);
    }

    if (toQuery.length === 0) return result;

    // Step 2: Prioritize hashes by quality tier
    const prioritized = torrentMap ? prioritizeByQuality(toQuery, torrentMap) : toQuery;
    const magnetLimit = config.thresholds?.magnetCheckLimit || 10;
    const limitedHashes = prioritized.slice(0, magnetLimit);

    console.log(`[rd] Checking ${limitedHashes.length} hash(es) via parallel add-magnet (concurrency=${concurrency})...`);

    // Step 3: Check in parallel with concurrency limit + early termination
    const tierCounts = {};
    let rateLimitCount = 0;
    let checkedCount = 0;
    let stopped = false;

    const tasks = limitedHashes.map((hash) => async () => {
        // Early termination: stop if we already have enough results
        if (stopped) return;

        const cacheResult = await checkCacheViaAdd(token, hash);
        checkedCount++;

        if (cacheResult === 'rate_limited') {
            rateLimitCount++;
            if (rateLimitCount >= 2) {
                console.log('[rd] Stopping — rate limited');
                stopped = true;
            }
            return;
        }

        if (!cacheResult) {
            markHashNotCached(hash);
            return;
        }

        // Build availability object from torrent info
        const { info } = cacheResult;
        const variant = {};
        if (info && info.files && info.files.length > 0) {
            for (const file of info.files) {
                const fileId = file.id || 1;
                variant[fileId] = {
                    filename: file.path ? file.path.replace(/^\//, '') : `file_${fileId}`,
                    filesize: file.bytes || 0,
                };
            }
        } else {
            variant[1] = { filename: 'cached', filesize: 0 };
        }

        const availability = { rd: [variant] };
        result[hash] = availability;
        markHashCached(hash);
        setCachedAvailability(hash, availability);

        // Track per-tier results for early termination
        const torrent = torrentMap && torrentMap.get(hash);
        const quality = torrent?._parsedQuality || 'unknown';
        tierCounts[quality] = (tierCounts[quality] || 0) + 1;

        // Check if every tier with candidates has enough results
        if (torrentMap) {
            const enabledQualities = config.settings?.qualities || ['2160p', '1080p', '720p', '480p'];
            const allSatisfied = enabledQualities.every(q => {
                const hasCandidates = limitedHashes.some(h => {
                    const t = torrentMap.get(h);
                    return t && t._parsedQuality === q;
                });
                if (!hasCandidates) return true;
                return (tierCounts[q] || 0) >= minPerTier;
            });
            if (allSatisfied) {
                console.log(`[rd] Early termination — enough results per tier after ${checkedCount} checks`);
                stopped = true;
            }
        }
    });

    await parallelLimit(tasks, concurrency);

    const cachedCount = Object.values(result).filter(v => v && v.rd && v.rd.length > 0).length;
    console.log(`[rd] Found ${cachedCount - positiveCacheHits} new cached hash(es) out of ${checkedCount} checked (${positiveCacheHits} from cache)`);

    return result;
}

// Add magnet, select all files, check if already cached via torrent status.
// Returns { torrentId, info } if cached, null if not cached, or 'rate_limited' on 429.
async function checkCacheViaAdd(token, hash) {
    let torrentId = null;
    try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        const added = await addMagnet(token, magnet);
        if (!added || !added.id) return null;
        torrentId = added.id;

        await selectFiles(token, torrentId, 'all');

        const info = await getTorrentInfo(token, torrentId, true);
        if (info && info.status === 'downloaded') {
            markHashCached(hash);
            return { torrentId, info };
        }

        // Not cached — clean up
        await deleteTorrent(token, torrentId).catch(() => {});
        return null;
    } catch (err) {
        if (err.message === ERR_RATE_LIMITED) {
            if (torrentId) await deleteTorrent(token, torrentId).catch(() => {});
            return 'rate_limited';
        }
        console.error(`[rd] checkCacheViaAdd failed for ${hash}:`, err.message);
        if (torrentId) await deleteTorrent(token, torrentId).catch(() => {});
        return null;
    }
}

async function addMagnet(token, magnet) {
    return apiRequest('/torrents/addMagnet', token, {
        method: 'POST',
        body: { magnet },
    });
}

async function selectFiles(token, torrentId, files) {
    return apiRequest(`/torrents/selectFiles/${torrentId}`, token, {
        method: 'POST',
        body: { files: files || 'all' },
    });
}

async function deleteTorrent(token, torrentId) {
    return apiRequest(`/torrents/delete/${torrentId}`, token, {
        method: 'DELETE',
    });
}

function clearCache() {
    cache.clear();
}

// Fetch all torrents bypassing the in-memory cache (for cleanup, which needs fresh data)
async function getAllTorrentsFresh(token) {
    let allTorrents = [];
    let page = 1;
    while (true) {
        const batch = await apiRequest(`/torrents?page=${page}&limit=50`, token);
        if (!batch || batch.length === 0) break;
        allTorrents = allTorrents.concat(batch);
        if (batch.length < 50) break;
        page++;
        if (page > 50) break;
    }
    return allTorrents;
}

async function cleanupLibrary(token, options = {}) {
    const maxAgeDays = options.maxAgeDays != null ? options.maxAgeDays : 7;
    const keepActive = options.keepActive != null ? options.keepActive : true;
    const dryRun = options.dryRun || false;

    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    // Use fresh data — never cached — so we don't delete stale entries
    const torrents = await getAllTorrentsFresh(token);

    let deleted = 0;
    let skipped = 0;
    let errors = 0;

    for (const torrent of torrents) {
        const addedTime = new Date(torrent.added).getTime();

        if (isNaN(addedTime)) {
            console.warn(`[rd] Cleanup: skipping torrent ${torrent.id} — unparseable added date: ${torrent.added}`);
            skipped++;
            continue;
        }

        // Skip torrents newer than the cutoff
        if (addedTime > cutoff) {
            skipped++;
            continue;
        }

        // If keepActive, only delete torrents with status "downloaded"
        if (keepActive && torrent.status !== 'downloaded') {
            skipped++;
            continue;
        }

        if (dryRun) {
            deleted++;
            continue;
        }

        try {
            await deleteTorrent(token, torrent.id);
            deleted++;
            // Delay between deletions to stay within RD write rate limits (~1 req/s)
            await new Promise(r => setTimeout(r, 250));
        } catch (err) {
            console.error(`[rd] Cleanup: failed to delete torrent ${torrent.id}: ${err.message}`);
            errors++;
        }
    }

    const mode = dryRun ? 'DRY RUN' : 'deleted';
    console.log(`[rd] Library cleanup: ${mode} ${deleted} torrents (${skipped} skipped, ${errors} errors)`);

    // Force refresh the library index after cleanup so it reflects the deletions
    if (!dryRun && deleted > 0) {
        refreshLibraryIndex(token, true).catch(() => {});
    }

    return { deleted, skipped, errors };
}

// Warm the hash cache and library index from the user's RD torrent library on startup.
// Uses refreshLibraryIndex as the single authoritative path for building the index, then
// walks the resulting index to populate the SQLite availability cache for downloaded torrents.
async function warmHashCache(token) {
    try {
        // Force a full refresh so the index is populated before the first resolve request.
        // refreshLibraryIndex owns all writes to entry.index / entry.lastRefresh, which
        // prevents a race with any concurrent findTorrentByHash call.
        const index = await refreshLibraryIndex(token, true);
        let warmed = 0;

        for (const [hash, t] of index) {
            if (t.status === 'downloaded') {
                const availability = { rd: [{ 1: { filename: t.filename || 'cached', filesize: 0 } }] };
                setCachedAvailability(hash, availability);
                markHashCached(hash);
                warmed++;
            }
        }

        console.log(`[rd] Warmed hash cache with ${warmed} downloaded torrents (${index.size} total in library index)`);
    } catch (err) {
        console.error('[rd] Failed to warm hash cache:', err.message);
    }
}

module.exports = {
    getUser,
    getTorrents,
    getAllTorrents,
    getTorrentInfo,
    getDownloads,
    unrestrictLink,
    checkInstantAvailability,
    checkCacheViaAdd,
    addMagnet,
    selectFiles,
    deleteTorrent,
    clearCache,
    cleanupLibrary,
    markHashCached,
    markHashNotCached,
    isHashKnownNotCached,
    refreshLibraryIndex,
    findTorrentByHash,
    warmHashCache,
};
